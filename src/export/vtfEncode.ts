// VTF writer for the export path, the inverse of tools/lib/vtf-core.mjs.
//
// Emits version 7.4, which is what the game's own paint textures are (checked
// against materials/patterns/solid_red.vtf: 7.4, DXT5, full mip chain).
//
// Two parts of the layout are easy to get wrong and are worth stating up front,
// both confirmed against the SDK at .tmp/source-sdk-2013/src/public/vtf/vtf.h:
//
//  1. Image data is stored SMALLEST MIP FIRST, 1x1 upward to the full size,
//     then by frame, then by face (vtf.h:394). In memory the engine keeps the
//     opposite order, which is exactly why the on-disk order surprises people.
//  2. The 7.3+ header has invisible struct padding. `VectorAligned reflectivity`
//     forces 16-byte alignment, so although the fields stop at 0x48 the resource
//     directory starts at 0x50. The SDK shouts about this at vtf.h:446, and our
//     own decoder agrees by reading resources from byte 80.
//
// We only ever write single-frame, single-face, non-volume textures, so the
// data section is just the mip chain.

import { compressDxt1, compressDxt5 } from './dxt';

/** ImageFormat values from public/bitmap/imageformat.h. */
const FORMAT_BGRA8888 = 12;
const FORMAT_DXT1 = 13;
const FORMAT_DXT5 = 15;
const FORMAT_NONE = -1;

/** CompiledVtfFlags, public/vtf/vtf.h:33. */
const FLAG_POINTSAMPLE = 0x0001;
const FLAG_TRILINEAR = 0x0002;
const FLAG_CLAMPS = 0x0004;
const FLAG_CLAMPT = 0x0008;
const FLAG_ANISOTROPIC = 0x0010;
const FLAG_NOMIP = 0x0100;
const FLAG_NOLOD = 0x0200;
const FLAG_EIGHTBITALPHA = 0x2000;

/** VTF_LEGACY_RSRC_IMAGE, the high-resolution image data. */
const RESOURCE_HIGH_RES = 0x30;
/** Where the resource directory starts once the compiler's padding is applied. */
const RESOURCE_DIRECTORY_OFFSET = 80;

export interface VtfEncodeFlags {
  clampS?: boolean;
  clampT?: boolean;
  pointSample?: boolean;
  trilinear?: boolean;
  anisotropic?: boolean;
  noMip?: boolean;
  noLod?: boolean;
}

export interface VtfEncodeOptions {
  width: number;
  height: number;
  /** Unpremultiplied RGBA, 4 bytes per pixel, first row is the top. */
  pixels: Uint8Array;
  /**
   * 'auto' and 'dxt' both follow the game's own choice, DXT5 when the image
   * carries alpha and DXT1 when it does not. 'bgra8888' stays uncompressed,
   * for data that has to survive byte for byte.
   */
  format?: 'auto' | 'dxt' | 'bgra8888';
  /** Sampling flags, normally copied from the texture being replaced. */
  flags?: VtfEncodeFlags;
}

interface MipLevel {
  width: number;
  height: number;
  pixels: Uint8Array;
}

function hasTransparency(pixels: Uint8Array): boolean {
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i] !== 255) return true;
  return false;
}

/**
 * 2x2 box filter, every channel averaged on its own.
 *
 * Alpha is never multiplied into RGB. A TF2 paint texture uses the two as
 * independent data channels (a pattern's wear mask, a sticker's spec), so a
 * "correct" premultiplied downsample would quietly zero the colour under any
 * transparent pixel. The WebP pipeline hit this same trap once, which is why
 * public/data is written with libwebp's `exact` flag.
 */
function downsample(level: MipLevel): MipLevel {
  const width = Math.max(1, level.width >> 1);
  const height = Math.max(1, level.height >> 1);
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.min(y * 2, level.height - 1);
    const y1 = Math.min(y * 2 + 1, level.height - 1);
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.min(x * 2, level.width - 1);
      const x1 = Math.min(x * 2 + 1, level.width - 1);
      const a = (y0 * level.width + x0) * 4;
      const b = (y0 * level.width + x1) * 4;
      const c = (y1 * level.width + x0) * 4;
      const d = (y1 * level.width + x1) * 4;
      const out = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        pixels[out + channel] = Math.round(
          (level.pixels[a + channel] + level.pixels[b + channel] + level.pixels[c + channel] + level.pixels[d + channel]) / 4,
        );
      }
    }
  }
  return { width, height, pixels };
}

function buildMipChain(base: MipLevel, mipCount: number): MipLevel[] {
  const levels: MipLevel[] = [base];
  for (let level = 1; level < mipCount; level += 1) levels.push(downsample(levels[level - 1]));
  return levels;
}

function encodeLevel(level: MipLevel, format: number): Uint8Array {
  if (format === FORMAT_DXT1) return compressDxt1(level.pixels, level.width, level.height);
  if (format === FORMAT_DXT5) return compressDxt5(level.pixels, level.width, level.height);
  const out = new Uint8Array(level.width * level.height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = level.pixels[i + 2];
    out[i + 1] = level.pixels[i + 1];
    out[i + 2] = level.pixels[i];
    out[i + 3] = level.pixels[i + 3];
  }
  return out;
}

/**
 * Average colour of the largest mip, 0..1 per channel. The engine only uses
 * this to light world geometry from a surface, so it does not matter for a
 * weapon skin, but a plausible value costs nothing and a zeroed one looks like
 * a broken file to other tools.
 */
function reflectivityOf(level: MipLevel): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  const count = level.width * level.height;
  for (let i = 0; i < level.pixels.length; i += 4) {
    r += level.pixels[i];
    g += level.pixels[i + 1];
    b += level.pixels[i + 2];
  }
  return [r / count / 255, g / count / 255, b / count / 255];
}

function flagBits(flags: VtfEncodeFlags | undefined, eightBitAlpha: boolean): number {
  let bits = 0;
  if (flags?.pointSample) bits |= FLAG_POINTSAMPLE;
  if (flags?.trilinear) bits |= FLAG_TRILINEAR;
  if (flags?.clampS) bits |= FLAG_CLAMPS;
  if (flags?.clampT) bits |= FLAG_CLAMPT;
  if (flags?.anisotropic) bits |= FLAG_ANISOTROPIC;
  if (flags?.noMip) bits |= FLAG_NOMIP;
  if (flags?.noLod) bits |= FLAG_NOLOD;
  // vtex derives this one from the pixels rather than from the author's config,
  // so it is set here for the same reason: it describes the data, not a wish.
  // ONEBITALPHA is never set: we do not emit DXT1_ONEBITALPHA.
  if (eightBitAlpha) bits |= FLAG_EIGHTBITALPHA;
  return bits;
}

export function encodeVtf(options: VtfEncodeOptions): Uint8Array {
  const { width, height, pixels } = options;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`Cannot encode a VTF at ${width} x ${height}.`);
  }
  if (pixels.length !== width * height * 4) {
    throw new Error(`Expected ${width * height * 4} bytes of RGBA for a ${width} x ${height} texture, got ${pixels.length}.`);
  }

  const alpha = hasTransparency(pixels);
  const requested = options.format ?? 'auto';
  const format = requested === 'bgra8888' ? FORMAT_BGRA8888 : alpha ? FORMAT_DXT5 : FORMAT_DXT1;
  const eightBitAlpha = format === FORMAT_DXT5 || (format === FORMAT_BGRA8888 && alpha);

  const mipCount = options.flags?.noMip
    ? 1
    : Math.floor(Math.log2(Math.max(width, height))) + 1;
  const levels = buildMipChain({ width, height, pixels }, mipCount);
  const encoded = levels.map((level) => encodeLevel(level, format));

  const headerSize = RESOURCE_DIRECTORY_OFFSET + 8;
  const imageBytes = encoded.reduce((total, level) => total + level.length, 0);
  const file = new Uint8Array(headerSize + imageBytes);
  const view = new DataView(file.buffer);

  file.set([0x56, 0x54, 0x46, 0x00]); // "VTF\0"
  view.setUint32(4, 7, true);
  view.setUint32(8, 4, true);
  view.setUint32(12, headerSize, true);
  view.setUint16(16, width, true);
  view.setUint16(18, height, true);
  view.setUint32(20, flagBits(options.flags, eightBitAlpha), true);
  view.setUint16(24, 1, true); // numFrames
  view.setUint16(26, 0, true); // startFrame
  const reflectivity = reflectivityOf(levels[0]);
  view.setFloat32(32, reflectivity[0], true);
  view.setFloat32(36, reflectivity[1], true);
  view.setFloat32(40, reflectivity[2], true);
  view.setFloat32(48, 1, true); // bumpScale
  view.setInt32(52, format, true);
  view.setUint8(56, mipCount);
  // No low-resolution thumbnail. It is optional, and the engine reads the
  // reflectivity it would otherwise be consulted for straight from the header.
  view.setInt32(57, FORMAT_NONE, true);
  view.setUint8(61, 0);
  view.setUint8(62, 0);
  view.setUint16(63, 1, true); // depth
  view.setUint32(68, 1, true); // numResources

  file[RESOURCE_DIRECTORY_OFFSET] = RESOURCE_HIGH_RES;
  view.setUint32(RESOURCE_DIRECTORY_OFFSET + 4, headerSize, true);

  // Smallest mip first, per the disk layout note at the top of this file.
  let offset = headerSize;
  for (let level = encoded.length - 1; level >= 0; level -= 1) {
    file.set(encoded[level], offset);
    offset += encoded[level].length;
  }
  return file;
}
