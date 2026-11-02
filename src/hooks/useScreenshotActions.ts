import { useCallback } from 'react';
import type { RefObject } from 'react';

import type { Viewer } from '../viewer/Viewer';
import type { TurntableSink } from '../viewer/capture/viewerCapture';
import { TURNTABLE_SECONDS, type ControlsState, type TurntableFormat, type TurntableProfile } from '../viewer/controls';
import type { TurntableWorkerRequest, TurntableWorkerResponse } from '../export/turntable.worker';
import { downloadBlob } from '../ui/common/download';
import type { WebpEncoder } from '../export/animated';
import { TURNTABLE_FORMATS, TurntableStoppedError, turntablePlaybackFps } from '../export/turntableFormats';
import { TOUCH_ONLY_DEVICE } from '../device';

type TurntableSettings = Pick<
  ControlsState,
  'turntableFormat' | 'turntableProfiles' | 'turntableTransparent' | 'turntableColor'
>;

/** Animated formats this browser can encode (GIF and APNG always can). */
export async function supportedTurntableFormats(): Promise<TurntableFormat[]> {
  // Mediabunny loads on first use. If that fetch fails, only GIF and APNG are offered.
  const animated = await import('../export/animated').catch(() => null);
  const [webp, mp4] = await Promise.all([
    animated?.canEncodeWebp().catch(() => false) ?? false,
    animated?.canEncodeMp4().catch(() => false) ?? false,
  ]);
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

// Frames the encoder may queue before rendering waits, so memory stays bounded.
// A raw 1440 px MP4 frame is about 8 MB, so phones keep two.
const MAX_FRAMES_IN_FLIGHT = TOUCH_ONLY_DEVICE ? 2 : 4;
const PROGRESS_INTERVAL_MS = 100;

interface TurntableSession {
  readonly sink: TurntableSink;
  finish: () => Promise<Blob>;
  dispose: () => void;
}

/** WebP encodes on the main thread: in a worker each encode blocks it (about 5x slower at 640 px). */
function createWebpSession(
  EncoderClass: typeof WebpEncoder,
  quality: TurntableProfile['quality'],
  onProgress: (encoded: number) => void,
): TurntableSession {
  let encoder: WebpEncoder | null = null;
  let encoded = 0;
  const sink: TurntableSink = {
    start: ({ width, height, fps }) => {
      encoder = new EncoderClass(width, height, fps, quality);
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
  // Reports through onStatus instead of throwing; aborting signal stops the capture with its reason.
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
    let size = { width: 0, height: 0 };
    let session: TurntableSession | undefined;
    try {
      const viewer = viewerRef.current;
      if (!viewer) throw new Error('Viewer not ready');
      // WebP's encoder loads with the export, so mediabunny stays out of the startup bundle.
      session = turntableFormat === 'webp'
        ? createWebpSession((await import('../export/animated')).WebpEncoder, profile.quality, onProgress)
        : createTurntableSession(turntableFormat, profile.quality, onProgress);
      const { sink } = session;
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
          sink.start(info, samples);
        },
        frame: sink.frame,
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
      session?.dispose();
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
