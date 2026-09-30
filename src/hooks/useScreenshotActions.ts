import { useCallback } from 'react';
import type { RefObject } from 'react';
import { TurntableStoppedError, type TurntableSink, type Viewer } from '../viewer/Viewer';
import { TURNTABLE_SECONDS, type ControlsState, type TurntableFormat, type TurntableProfile } from '../viewer/controls';
import type { TurntableWorkerRequest, TurntableWorkerResponse } from '../export/turntable.worker';
import { downloadBlob } from '../ui/common/download';
import { canEncodeMp4, canEncodeWebp, WebpEncoder } from '../export/animated';

export type TurntableSettings = Pick<
  ControlsState,
  'turntableFormat' | 'turntableProfiles' | 'turntableTransparent' | 'turntableColor'
>;

/**
 * How each animated format is written, what it can hold, which settings it
 * offers, its defaults and a size estimate, from captures measured on Taxi
 * Cabbed (12 s spin; error is mean |difference| out of 255 against the render):
 *   GIF   480 px 25 fps            3.6 MB
 *   WebP  640 px 30 fps standard   4.1 MB, error 3.7
 *                       high       5.7 MB, error 2.5
 *                       maximum    7.8 MB, error 2.1 (quality 1.0 would be lossless and 36 MB)
 *   APNG  480 px 25 fps           12.9 MB, lossless
 *   MP4  1080 px 60 fps standard   1.9 MB, error 1.7
 *                       high       3.6 MB, error 1.4 (same size as 30 fps: the bitrate follows size, not rate)
 *                       maximum    6.8 MB, error 1.3
 */
export const TURNTABLE_FORMATS: Record<TurntableFormat, {
  readonly label: string;
  readonly extension: string;
  readonly mime: string;
  /** null: no transparency at all (always drawn on the background colour). */
  readonly alpha: 'binary' | 'full' | null;
  /** Output long edges offered, in pixels. */
  readonly sizes: readonly number[];
  readonly frameRates: readonly number[];
  /** Whether the Quality setting applies (GIF is always 256 colours, APNG lossless). */
  readonly hasQuality: boolean;
  readonly defaults: TurntableProfile;
  /** Rough, content-dependent size for `frames` frames over `seconds`. */
  readonly estimateBytes: (profile: TurntableProfile, frames: number, seconds: number) => number;
}> = {
  // GIF timing is in hundredths of a second, so 33 fps really plays at 33.3.
  gif: {
    label: 'GIF', extension: 'gif', mime: 'image/gif', alpha: 'binary',
    sizes: [360, 480, 640, 800], frameRates: [20, 25, 33, 50], hasQuality: false,
    defaults: { maxEdge: 480, fps: 25, quality: 'high' },
    estimateBytes: ({ maxEdge }, frames) => frames * maxEdge ** 2 * 0.06,
  },
  webp: {
    label: 'WebP', extension: 'webp', mime: 'image/webp', alpha: 'full',
    sizes: [360, 480, 640, 800], frameRates: [20, 25, 30, 50, 60], hasQuality: true,
    defaults: { maxEdge: 640, fps: 30, quality: 'high' },
    estimateBytes: ({ maxEdge, quality }, frames) => frames * maxEdge ** 2 * { standard: 0.03, high: 0.042, maximum: 0.055 }[quality],
  },
  apng: {
    label: 'APNG', extension: 'png', mime: 'image/png', alpha: 'full',
    sizes: [360, 480, 640, 800], frameRates: [20, 25, 30, 50, 60], hasQuality: false,
    defaults: { maxEdge: 480, fps: 25, quality: 'high' },
    estimateBytes: ({ maxEdge }, frames) => frames * maxEdge ** 2 * 0.19,
  },
  mp4: {
    label: 'MP4', extension: 'mp4', mime: 'video/mp4', alpha: null,
    sizes: [480, 640, 800, 1080, 1440], frameRates: [24, 30, 50, 60], hasQuality: true,
    defaults: { maxEdge: 1080, fps: 60, quality: 'high' },
    estimateBytes: ({ maxEdge, quality }, _frames, seconds) => seconds * maxEdge ** 2 * { standard: 0.14, high: 0.26, maximum: 0.46 }[quality],
  },
};

/** Frame rate the format actually plays: GIF rounds to whole hundredths of a second. */
export function turntablePlaybackFps(format: TurntableFormat, fps: number): number {
  return format === 'gif' ? 100 / Math.round(100 / fps) : fps;
}

/** Animated formats this browser can encode (GIF and APNG always can). */
export async function supportedTurntableFormats(): Promise<TurntableFormat[]> {
  const [webp, mp4] = await Promise.all([canEncodeWebp().catch(() => false), canEncodeMp4().catch(() => false)]);
  return (['gif', 'webp', 'apng', 'mp4'] as const).filter((format) =>
    (format !== 'webp' || webp) && (format !== 'mp4' || mp4));
}

export type TurntableStatus =
  /** `done` of `frames` encoded so far; 0 while the capture is being set up. */
  | { readonly phase: 'rendering'; readonly format: TurntableFormat; readonly done: number; readonly frames: number }
  /** Every frame is encoded; the file is being assembled. */
  | { readonly phase: 'finishing'; readonly format: TurntableFormat }
  | { readonly phase: 'saved'; readonly format: TurntableFormat; readonly bytes: number; readonly width: number; readonly height: number }
  /** Cancelled or interrupted on purpose; `reason` is user-facing. */
  | { readonly phase: 'stopped'; readonly reason: string }
  | { readonly phase: 'failed'; readonly message: string };

// Frames the encoder may have queued before rendering waits for it, which
// bounds memory to a handful of frames plus the output file itself.
const MAX_FRAMES_IN_FLIGHT = 4;
const PROGRESS_INTERVAL_MS = 100;

/**
 * WebP encodes on this thread: the browser runs main-thread canvas encodes on
 * a background pool, so frames overlap, while in a worker each encode blocks
 * the worker thread (measured about 5x slower at 640 px).
 */
function createWebpSession(quality: TurntableProfile['quality'], onProgress: (encoded: number) => void) {
  let encoder: WebpEncoder | null = null;
  let encoded = 0;
  const sink: TurntableSink = {
    start: ({ width, height, fps }) => {
      encoder = new WebpEncoder(width, height, fps, quality);
    },
    frame: async (rgba) => {
      await encoder!.addFrame(rgba);
      onProgress(++encoded);
    },
  };
  return {
    sink,
    finish: async () => new Blob([await encoder!.finish() as Uint8Array<ArrayBuffer>], { type: TURNTABLE_FORMATS.webp.mime }),
    dispose: () => {},
  };
}

/** Streams a turntable capture into the encoder worker, pacing rendering to encoding. */
function createTurntableSession(
  format: Exclude<TurntableFormat, 'webp'>,
  quality: TurntableProfile['quality'],
  onProgress: (encoded: number) => void,
) {
  const worker = new Worker(new URL('../export/turntable.worker.ts', import.meta.url), { type: 'module' });
  const send = (message: TurntableWorkerRequest, transfer: Transferable[] = []) => worker.postMessage(message, transfer);
  let sent = 0;
  let encoded = 0;
  let result: Uint8Array<ArrayBuffer> | null = null;
  let failure: Error | null = null;
  let wake = () => {};
  worker.onmessage = (event: MessageEvent<TurntableWorkerResponse>) => {
    const message = event.data;
    if (message.type === 'ack') onProgress(++encoded);
    else if (message.type === 'done') result = message.bytes;
    else failure = new Error(message.message);
    wake();
  };
  worker.onerror = () => {
    failure = new Error('The encoder failed');
    wake();
  };
  const waitFor = async (ready: () => boolean) => {
    for (;;) {
      if (failure) throw failure;
      if (ready()) return;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  };

  const sink: TurntableSink = {
    start: ({ width, height, fps }, samples) =>
      send({ type: 'start', format, width, height, fps, quality, samples }, samples.map((sample) => sample.buffer)),
    frame: async (rgba) => {
      if (failure) throw failure;
      send({ type: 'frame', rgba }, [rgba.buffer]);
      sent++;
      await waitFor(() => sent - encoded < MAX_FRAMES_IN_FLIGHT);
    },
  };
  return {
    sink,
    async finish(): Promise<Blob> {
      send({ type: 'finish' });
      await waitFor(() => result !== null);
      return new Blob([result!], { type: TURNTABLE_FORMATS[format].mime });
    },
    dispose: () => worker.terminate(),
  };
}

export function useScreenshotActions({
  viewerRef,
  paintName,
  weaponKey,
  seed,
  maxEdge,
  turntable,
}: {
  viewerRef: RefObject<Viewer | null>;
  paintName?: string;
  weaponKey: string;
  seed: string;
  maxEdge: number;
  turntable: TurntableSettings;
}) {
  const slug = paintName
    ? paintName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
    : '';
  const baseName = `${slug || 'warpaint'}_${weaponKey}_seed${seed}`;

  const saveImage = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Viewer not ready');
    downloadBlob(await viewer.captureScreenshot({ maxEdge }), `${baseName}.png`);
  }, [viewerRef, baseName, maxEdge]);

  const { turntableFormat, turntableProfiles, turntableTransparent, turntableColor } = turntable;
  const profile = turntableProfiles[turntableFormat];
  // Reports progress and failures through `onStatus` instead of throwing.
  // Aborting `signal` stops the capture; its reason becomes the stop reason.
  const saveTurntable = useCallback(async (onStatus: (status: TurntableStatus) => void, signal?: AbortSignal) => {
    const format = TURNTABLE_FORMATS[turntableFormat];
    const fps = turntablePlaybackFps(turntableFormat, profile.fps);
    const frames = Math.max(2, Math.round(TURNTABLE_SECONDS * fps));
    const color = parseInt(turntableColor.slice(1), 16);
    // Progress re-renders the app, so report at most every PROGRESS_INTERVAL_MS.
    let reportedAt = 0;
    const onProgress = (done: number) => {
      const now = performance.now();
      if (done < frames && now - reportedAt < PROGRESS_INTERVAL_MS) return;
      reportedAt = now;
      onStatus({ phase: 'rendering', format: turntableFormat, done, frames });
    };
    const session = turntableFormat === 'webp'
      ? createWebpSession(profile.quality, onProgress)
      : createTurntableSession(turntableFormat, profile.quality, onProgress);
    let size = { width: 0, height: 0 };
    try {
      const viewer = viewerRef.current;
      if (!viewer) throw new Error('Viewer not ready');
      onStatus({ phase: 'rendering', format: turntableFormat, done: 0, frames });
      await viewer.captureTurntable({
        maxEdge: profile.maxEdge,
        fps,
        seconds: TURNTABLE_SECONDS,
        background: turntableTransparent && format.alpha ? null : color,
        alpha: format.alpha ?? 'full',
        paletteSamples: turntableFormat === 'gif',
      }, {
        start: (info, samples) => {
          size = info;
          session.sink.start(info, samples);
        },
        frame: session.sink.frame,
      }, signal);
      onStatus({ phase: 'finishing', format: turntableFormat });
      const file = await session.finish();
      downloadBlob(file, `${baseName}_turntable.${format.extension}`);
      // MP4 frames are padded to even dimensions for H.264.
      const pad = (value: number) => turntableFormat === 'mp4' ? value + (value & 1) : value;
      onStatus({ phase: 'saved', format: turntableFormat, bytes: file.size, width: pad(size.width), height: pad(size.height) });
    } catch (cause) {
      if (cause instanceof TurntableStoppedError) onStatus({ phase: 'stopped', reason: cause.message });
      else onStatus({ phase: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
    } finally {
      session.dispose();
    }
  }, [viewerRef, baseName, turntableFormat, profile, turntableTransparent, turntableColor]);

  const copyImage = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Viewer not ready');
    const blob = await viewer.captureScreenshot({ maxEdge });
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
  }, [viewerRef, maxEdge]);

  return { saveImage, saveTurntable, copyImage };
}
