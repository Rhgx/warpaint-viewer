import fs from 'node:fs';
import path from 'node:path';
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
    ['noise', noiseImage(64, 64)],
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

function noiseImage(width: number, height: number, seed = 1) {
  const pixels = new Uint8Array(width * height * 4);
  let state = seed;
  for (let i = 0; i < pixels.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    pixels[i] = state >>> 24;
  }
  return { width, height, pixels };
}

function artworkImage(width: number, height: number) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const cx = x - width / 2;
      const cy = y - height / 2;
      const radius = Math.sqrt(cx * cx + cy * cy);
      const stripe = Math.sin(x * 0.12) * 0.5 + 0.5;
      const inside = radius < width * 0.3;
      pixels[offset] = Math.round(inside ? 200 : stripe * 120 + 20);
      pixels[offset + 1] = Math.round((y / height) * 180 + (inside ? 40 : 0));
      pixels[offset + 2] = Math.round(inside ? 60 : 140 - stripe * 90);
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

function psnr(a: Uint8Array, b: Uint8Array) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const diff = a[i + channel] - b[i + channel];
      sum += diff * diff;
      count += 1;
    }
  }
  const mse = sum / count;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

test('DXT compression preserves artwork quality and alpha ramps', () => {
  const image = artworkImage(128, 128);
  expect(psnr(decodeVTF(encodeVtf(image)).rgba, image.pixels)).toBeGreaterThan(29);
  for (let i = 3; i < image.pixels.length; i += 4) image.pixels[i] = (i >> 2) % 256;
  const decoded = decodeVTF(encodeVtf(image));
  let worstAlpha = 0;
  for (let i = 3; i < image.pixels.length; i += 4) {
    worstAlpha = Math.max(worstAlpha, Math.abs(decoded.rgba[i] - image.pixels[i]));
  }
  expect(worstAlpha).toBeLessThanOrEqual(18);
});

test('real Valve texture retains format, sampling, mip layout, and quality', (context) => {
  const fixture = process.env.TF2_VTF_FIXTURE ?? [
    'staging/materials/patterns/solid_red.vtf',
    '../../../staging/materials/patterns/solid_red.vtf',
  ].map(candidate => path.resolve(candidate)).find(candidate => fs.existsSync(candidate));
  if (!fixture) { context.skip('No real VTF fixture'); return; }
  const original = fs.readFileSync(fixture);
  const originalHeader = parseVTFHeader(original);
  const originalPixels = decodeVTF(original);
  const reencoded = encodeVtf({
    width: originalPixels.width, height: originalPixels.height,
    pixels: originalPixels.rgba, flags: originalHeader.sampling,
  });
  const header = parseVTFHeader(reencoded);
  for (const key of ['width', 'height', 'highResFormat', 'mipCount', 'flags'] as const) {
    expect(header[key], key).toBe(originalHeader[key]);
  }
  expect(psnr(decodeVTF(reencoded).rgba, originalPixels.rgba)).toBeGreaterThan(35);
  expect(reencoded.length - header.imageDataOffset).toBe(original.length - originalHeader.imageDataOffset);
});
