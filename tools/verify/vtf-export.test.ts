import { describe, expect, test } from 'vitest';
import { encodeVtf } from '../../src/export/vtfEncode';
import { decodeVTF, parseVTFHeader } from '../lib/vtf-core.mjs';

const FORMAT_BGRA8888 = 12;
const FORMAT_DXT1 = 13;
const FORMAT_DXT5 = 15;

interface TestImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

function gradientImage(width: number, height: number): TestImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round((x / Math.max(1, width - 1)) * 255);
      pixels[offset + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      pixels[offset + 2] = 128;
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

function hiddenColorImage(width: number, height: number): TestImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels.set([200, 60, 30, 0], offset);
  }
  return { width, height, pixels };
}

function maskImage(): TestImage & { ids: readonly number[] } {
  const width = 128;
  const ids = [48, 64, 80, 96, 128, 160, 176, 192] as const;
  const pixels = new Uint8Array(width * width * 4);
  for (let y = 0; y < width; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const id = ids[((y >> 5) * 4 + (x >> 5)) % ids.length];
      const offset = (y * width + x) * 4;
      pixels.set([id, id, id, 255], offset);
    }
  }
  return { width, height: width, pixels, ids };
}

function mipByteSize(format: number, width: number, height: number): number {
  if (format === FORMAT_DXT1) return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * 8;
  if (format === FORMAT_DXT5) return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * 16;
  return width * height * 4;
}

describe('VTF encoder', () => {
  test.each([
    ['gradient', gradientImage(64, 32)],
    ['transparent color', hiddenColorImage(32, 32)],
  ])('round-trips BGRA8888 exactly for %s', (_name, image) => {
    const decoded = decodeVTF(encodeVtf({ ...image, format: 'bgra8888' }));
    expect(decoded.width).toBe(image.width);
    expect(decoded.height).toBe(image.height);
    expect(decoded.rgba).toEqual(image.pixels);
  });

  test('writes the expected header, format, mip, and sampling metadata', () => {
    const image = gradientImage(64, 64);
    const header = parseVTFHeader(encodeVtf(image));
    expect([header.verMajor, header.verMinor]).toEqual([7, 4]);
    expect([header.width, header.height]).toEqual([64, 64]);
    expect(header.highResFormat).toBe(FORMAT_DXT1);
    expect(header.mipCount).toBe(7);
    expect([header.frames, header.faces, header.depth]).toEqual([1, 1, 1]);
    expect(header.headerSize).toBe(88);
    expect(header.imageDataOffset).toBe(88);
    expect(header.lowResImageDataSize).toBe(0);
    expect(header.flags & 0x2000).toBe(0);

    const alphaHeader = parseVTFHeader(encodeVtf(hiddenColorImage(32, 32)));
    expect(alphaHeader.highResFormat).toBe(FORMAT_DXT5);
    expect(alphaHeader.flags & 0x2000).not.toBe(0);

    const sampling = parseVTFHeader(encodeVtf({ ...image, flags: { clampS: true, clampT: true, pointSample: true } })).sampling;
    expect(sampling).toMatchObject({ clampS: true, clampT: true, pointSample: true, noMip: false });
    expect(parseVTFHeader(encodeVtf({ ...image, flags: { noMip: true } })).mipCount).toBe(1);
  });

  test('writes the complete mip chain smallest-first', () => {
    const pixels = new Uint8Array(4 * 4 * 4);
    for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([40, 80, 120, 255], offset);
    const file = encodeVtf({ width: 4, height: 4, pixels, format: 'bgra8888' });
    const header = parseVTFHeader(file);
    expect(header.mipCount).toBe(3);
    expect([...file.subarray(header.imageDataOffset, header.imageDataOffset + 4)]).toEqual([120, 80, 40, 255]);
    const expected = mipByteSize(FORMAT_BGRA8888, 1, 1)
      + mipByteSize(FORMAT_BGRA8888, 2, 2)
      + mipByteSize(FORMAT_BGRA8888, 4, 4);
    expect(file.length).toBe(header.imageDataOffset + expected);
  });

  test('preserves RGB underneath zero alpha through every mip', () => {
    const file = encodeVtf({ ...hiddenColorImage(64, 64), format: 'bgra8888' });
    const header = parseVTFHeader(file);
    let offset = header.imageDataOffset;
    for (let level = header.mipCount - 1; level >= 0; level -= 1) {
      const width = Math.max(1, header.width >> level);
      const height = Math.max(1, header.height >> level);
      const size = mipByteSize(FORMAT_BGRA8888, width, height);
      for (let index = offset; index < offset + size; index += 4) {
        expect([...file.subarray(index, index + 4)]).toEqual([30, 60, 200, 0]);
      }
      offset += size;
    }
  });

  test('keeps flat group-mask regions distinct within RGB565 drift', () => {
    const mask = maskImage();
    const decoded = decodeVTF(encodeVtf(mask));
    const seen = new Set<number>();
    let worst = 0;
    for (let offset = 0; offset < decoded.rgba.length; offset += 4) {
      seen.add(decoded.rgba[offset]);
      worst = Math.max(worst, Math.abs(decoded.rgba[offset] - mask.pixels[offset]));
    }
    expect(seen.size).toBe(new Set(mask.ids).size);
    expect(worst).toBeLessThanOrEqual(4);
  });
});
