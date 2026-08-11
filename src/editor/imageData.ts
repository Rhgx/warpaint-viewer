import type { RgbaImageDataLike } from './groupSampling';
import { decodeImageThumbnailExact } from '../export/decodeImage';

const MAX_GROUP_PIXELS = 16 * 1024 * 1024;
export const LAYER_COLOR_THUMBNAIL_SIDE = 32;

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
 * Decode only a fixed 32×32 colour thumbnail. This deliberately never reads
 * a full paint texture into CPU memory: it is just enough data for the editor
 * to choose a legible layer cue.
 */
export async function loadRgbaThumbnail(url: string): Promise<RgbaImageDataLike> {
  const decoded = await decodeImageThumbnailExact(
    url,
    LAYER_COLOR_THUMBNAIL_SIDE,
    LAYER_COLOR_THUMBNAIL_SIDE,
  );
  return { width: decoded.width, height: decoded.height, data: decoded.pixels };
}

/** Turn decoded thumbnail pixels into a browser-displayable image URL. */
export function rgbaThumbnailDataUrl(
  thumbnail: RgbaImageDataLike,
): string {
  const canvas = document.createElement('canvas');
  canvas.width = thumbnail.width;
  canvas.height = thumbnail.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser cannot display texture thumbnails.');
  const pixels = Uint8ClampedArray.from(thumbnail.data);
  for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
  context.putImageData(new ImageData(pixels, thumbnail.width, thumbnail.height), 0, 0);
  return canvas.toDataURL('image/png');
}
