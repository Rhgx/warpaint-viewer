import type { TextureMetadata } from '../data/types';
import type { DecodedVTF, VTFHeader } from '../../tools/lib/vtf-core.mjs';
import { encodeRgbaPng } from './png';
import { opaqueRgbaThumbnail, SOURCE_THUMBNAIL_SIDE } from './thumbnail';

export interface VtfHeaderDetails {
  verMajor: number;
  verMinor: number;
  width: number;
  height: number;
  highResFormat: number;
  sampling: Partial<TextureMetadata>;
}

export interface DecodedVtfPng {
  png: ArrayBuffer;
  thumbnailPng: ArrayBuffer;
  width: number;
  height: number;
  header: VtfHeaderDetails;
}

export interface VtfDecodeLimits {
  maxPixels: number;
  limitDescription: string;
}

/**
 * vtf-core entry points, passed in so the main thread can load vtf-core lazily while the
 * worker imports it up front.
 */
export interface VtfCodec {
  parseVTFHeader(input: Uint8Array): VTFHeader;
  decodeVTF(input: Uint8Array): DecodedVTF;
}

export class VtfDecodeError extends Error {
  readonly header: VtfHeaderDetails | undefined;

  constructor(message: string, header?: VtfHeaderDetails) {
    super(message);
    this.name = 'VtfDecodeError';
    this.header = header;
  }
}

/**
 * Parses, bounds-checks, decodes and PNG-encodes one VTF with its thumbnail. Shared by the
 * main-thread fallback and the worker so both apply the same limits and errors. Failures
 * throw VtfDecodeError, carrying the header if it was already parsed.
 */
export async function decodeVtfToPngPair(
  codec: VtfCodec,
  bytes: Uint8Array,
  limits: VtfDecodeLimits,
): Promise<DecodedVtfPng> {
  let header: VtfHeaderDetails | undefined;
  try {
    header = codec.parseVTFHeader(bytes) as VtfHeaderDetails;
    const pixels = header.width * header.height;
    if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
      throw new Error(`VTF dimensions ${header.width} x ${header.height} exceed the ${limits.limitDescription}.`);
    }
    const decoded = codec.decodeVTF(bytes);
    const [png, thumbnailPng] = await Promise.all([
      encodeRgbaPng(decoded.rgba, decoded.width, decoded.height),
      encodeRgbaPng(
        opaqueRgbaThumbnail(decoded.rgba, decoded.width, decoded.height),
        SOURCE_THUMBNAIL_SIDE,
        SOURCE_THUMBNAIL_SIDE,
      ),
    ]);
    return { png, thumbnailPng, width: decoded.width, height: decoded.height, header };
  } catch (cause) {
    throw new VtfDecodeError(
      cause instanceof Error ? cause.message : 'The image data could not be decoded.',
      header,
    );
  }
}
