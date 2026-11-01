import { encodeRgbaPng } from '../source/png';
import { applyAlphaMask } from './alphaMask';

/** Shape of a parsed TGA. The parser stays at the call sites so this module runs in the worker without three.js. */
interface TgaPixels {
  data?: ArrayLike<number>;
  width?: number;
  height?: number;
}

/** The 2D canvas operations the alpha merge needs, shared by DOM and OffscreenCanvas contexts. */
export interface AlphaMergeContext<Image> {
  drawImage(image: Image, dx: number, dy: number, dw?: number, dh?: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): ImageData;
  clearRect(x: number, y: number, width: number, height: number): void;
}

export async function encodeTgaPixels(parsed: TgaPixels): Promise<ArrayBuffer> {
  if (!parsed.data || !parsed.width || !parsed.height) {
    throw new Error('This TGA has no readable pixel data.');
  }
  return encodeRgbaPng(Uint8Array.from(parsed.data), parsed.width, parsed.height);
}

/** Returns the color pixels with the alpha mask merged in. The caller decides how they are written out. */
export function mergeAlphaPixels<Image>(
  context: AlphaMergeContext<Image>,
  color: Image,
  alpha: Image,
  width: number,
  height: number,
): ImageData {
  context.drawImage(color, 0, 0);
  const colorPixels = context.getImageData(0, 0, width, height);
  context.clearRect(0, 0, width, height);
  context.drawImage(alpha, 0, 0, width, height);
  const maskPixels = context.getImageData(0, 0, width, height);
  applyAlphaMask(colorPixels.data, maskPixels.data);
  return colorPixels;
}
