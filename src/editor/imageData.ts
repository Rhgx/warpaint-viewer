import type { RgbaImageDataLike } from './groupSampling';

const MAX_GROUP_PIXELS = 16 * 1024 * 1024;
export const LAYER_COLOR_THUMBNAIL_SIDE = 16;

/** Decode a resolved group-map URL into CPU-readable pixels for UV picking. */
export async function loadRgbaImageData(url: string): Promise<RgbaImageDataLike> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the group map (${response.status}).`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const pixels = bitmap.width * bitmap.height;
    if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > MAX_GROUP_PIXELS) {
      throw new Error(`Group-map dimensions ${bitmap.width} × ${bitmap.height} are invalid or too large.`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This browser cannot read group-map pixels.');
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

/**
 * Decode only a fixed 16×16 colour thumbnail. This deliberately never reads
 * a full paint texture into CPU memory: it is just enough data for the editor
 * to choose a legible layer cue.
 */
export async function loadRgbaThumbnail(url: string): Promise<RgbaImageDataLike> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load the texture thumbnail (${response.status}).`);
  const blob = await response.blob();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: LAYER_COLOR_THUMBNAIL_SIDE,
      resizeHeight: LAYER_COLOR_THUMBNAIL_SIDE,
      resizeQuality: 'low',
    });
  } catch {
    // Older browsers can still downsample into the same tiny canvas. The
    // fallback does not expose full-sized pixels to the editor.
    bitmap = await createImageBitmap(blob);
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = LAYER_COLOR_THUMBNAIL_SIDE;
    canvas.height = LAYER_COLOR_THUMBNAIL_SIDE;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('This browser cannot read texture thumbnails.');
    context.drawImage(bitmap, 0, 0, LAYER_COLOR_THUMBNAIL_SIDE, LAYER_COLOR_THUMBNAIL_SIDE);
    return context.getImageData(0, 0, LAYER_COLOR_THUMBNAIL_SIDE, LAYER_COLOR_THUMBNAIL_SIDE);
  } finally {
    bitmap.close();
  }
}
