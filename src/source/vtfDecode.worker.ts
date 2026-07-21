/// <reference lib="webworker" />

import { decodeVTF, parseVTFHeader } from '../../tools/lib/vtf-core.mjs';
import { encodeRgbaPng } from './png';

interface DecodeRequest {
  id: number;
  bytes: ArrayBuffer;
  maxPixels: number;
  limitDescription: string;
}

type Header = ReturnType<typeof parseVTFHeader>;

function failure(id: number, cause: unknown, header?: Header): void {
  const message = cause instanceof Error ? cause.message : 'The image data could not be decoded.';
  self.postMessage({ id, ok: false, message, header });
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { id, bytes, maxPixels, limitDescription } = event.data;
  let header: Header | undefined;
  try {
    header = parseVTFHeader(new Uint8Array(bytes));
    const pixels = header.width * header.height;
    if (!Number.isSafeInteger(pixels) || pixels > maxPixels) {
      throw new Error(`VTF dimensions ${header.width} x ${header.height} exceed the ${limitDescription}.`);
    }
    const decoded = decodeVTF(new Uint8Array(bytes));
    const png = await encodeRgbaPng(decoded.rgba, decoded.width, decoded.height);
    self.postMessage({ id, ok: true, png, width: decoded.width, height: decoded.height, header }, [png]);
  } catch (cause) {
    failure(id, cause, header);
  }
};
