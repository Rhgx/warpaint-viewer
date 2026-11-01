/// <reference lib="webworker" />

import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import { encodeTgaPixels, mergeAlphaPixels } from './texturePixels';

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
  const png = await encodeTgaPixels(new TGALoader().parse(request.bytes));
  self.postMessage({ id: request.id, ok: true, png }, [png]);
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
    const colorPixels = mergeAlphaPixels(context, color, alpha, width, height);
    context.putImageData(colorPixels, 0, 0);
    // The native encoder is faster for a canvas already in the worker and skips an RGBA pass.
    const png = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    self.postMessage({ id: request.id, ok: true, png }, [png]);
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
