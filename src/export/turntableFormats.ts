import type { TurntableFormat, TurntableProfile } from '../viewer/controls';

// Format table and playback helpers without three.js, so the startup UI can read it
// without loading the viewer. The export hook adds the encoders.

/** Per-format options and size estimates, measured on Taxi Cabbed. MP4 bitrate follows size, not frame rate. */
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

/** A turntable capture stopped on purpose (cancelled, or the scene changed under it). */
export class TurntableStoppedError extends Error {
  override name = 'TurntableStoppedError';
}
