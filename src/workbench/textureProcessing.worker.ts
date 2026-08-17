/// <reference lib="webworker" />

import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { encodeRgbaPng } from '../source/png';

interface DecodeTgaRequest {
  id: number;
  kind: 'decode-tga';
  bytes: ArrayBuffer;
}

interface MergeAlphaRequest {
  id: number;
  kind: 'merge-alpha';
  color: Blob;
  alpha: Blob;
}

type ProcessingRequest = DecodeTgaRequest | MergeAlphaRequest;

class UnsupportedProcessingError extends Error {
  readonly code = 'unsupported';
}

function fail(id: number, cause: unknown): void {
  const message = cause instanceof Error
    ? cause.message
    : 'The texture could not be processed.';
  self.postMessage({
    id,
    ok: false,
    code: cause instanceof UnsupportedProcessingError ? cause.code : undefined,
    message,
  });
}

async function decodeTga(request: DecodeTgaRequest): Promise<void> {
  const parsed = new TGALoader().parse(request.bytes);
  if (!parsed.data || !parsed.width || !parsed.height) {
    throw new Error('This TGA has no readable pixel data.');
  }
  const png = await encodeRgbaPng(
    Uint8Array.from(parsed.data as ArrayLike<number>),
    parsed.width,
    parsed.height,
  );
  self.postMessage(
    { id: request.id, ok: true, kind: request.kind, png, width: parsed.width, height: parsed.height },
    [png],
  );
}

async function mergeAlpha(request: MergeAlphaRequest): Promise<void> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
    throw new UnsupportedProcessingError('The browser cannot process textures in a worker.');
  }
  const [color, alpha] = await Promise.all([
    createImageBitmap(request.color),
    createImageBitmap(request.alpha),
  ]);
  try {
    const width = color.width;
    const height = color.height;
    if (!width || !height) throw new Error('The color texture has no readable pixel data.');
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('The browser could not merge the alpha mask.');
    context.drawImage(color, 0, 0);
    const colorPixels = context.getImageData(0, 0, width, height);
    context.clearRect(0, 0, width, height);
    context.drawImage(alpha, 0, 0, width, height);
    const maskPixels = context.getImageData(0, 0, width, height);
    let hasTransparency = false;
    for (let index = 3; index < maskPixels.data.length; index += 4) {
      if (maskPixels.data[index] < 255) {
        hasTransparency = true;
        break;
      }
    }
    for (let index = 0; index < colorPixels.data.length; index += 4) {
      colorPixels.data[index + 3] = hasTransparency
        ? maskPixels.data[index + 3]
        : Math.round(
            maskPixels.data[index] * 0.299
              + maskPixels.data[index + 1] * 0.587
              + maskPixels.data[index + 2] * 0.114,
          );
    }
    context.putImageData(colorPixels, 0, 0);
    // The browser's native encoder is substantially faster for a canvas that
    // already lives in the worker and avoids another full RGBA traversal.
    const png = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    self.postMessage({ id: request.id, ok: true, kind: request.kind, png, width, height }, [png]);
  } finally {
    color.close();
    alpha.close();
  }
}

self.onmessage = (event: MessageEvent<ProcessingRequest>) => {
  void (async () => {
    try {
      if (event.data.kind === 'decode-tga') await decodeTga(event.data);
      else await mergeAlpha(event.data);
    } catch (cause) {
      fail(event.data.id, cause);
    }
  })();
};
