/// <reference lib="webworker" />

import { decodeVTF, parseVTFHeader } from '../../tools/lib/vtf-core.mjs';
import { decodeVtfToPngPair, VtfDecodeError } from './vtfDecodeCore';

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  maxPixels: number;
  limitDescription: string;
}

function failure(id: number, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : 'The image data could not be decoded.';
  const header = cause instanceof VtfDecodeError ? cause.header : undefined;
  self.postMessage({ id, ok: false, message, header });
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { id, bytes, maxPixels, limitDescription } = event.data;
  try {
    const decoded = await decodeVtfToPngPair(
      { decodeVTF, parseVTFHeader },
      new Uint8Array(bytes),
      { maxPixels, limitDescription },
    );
    self.postMessage({ id, ok: true, ...decoded }, [decoded.png, decoded.thumbnailPng]);
  } catch (cause) {
    failure(id, cause);
  }
};
