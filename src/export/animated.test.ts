import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc32 } from '../source/crc32';
import { ApngEncoder, rgbaToI420 } from './animated';

function unpaeth(filtered: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    expect(filtered[y * (stride + 1)]).toBe(4);
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[y * stride + i - 4] : 0;
      const b = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? out[(y - 1) * stride + i - 4] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[y * stride + i] = (filtered[y * (stride + 1) + 1 + i] + predicted) & 0xff;
    }
  }
  return out;
}

describe('ApngEncoder', () => {
  it('writes valid, lossless, correctly sequenced frames', async () => {
    const width = 23;
    const height = 9;
    const frames = [0, 1, 2].map((f) => Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 7 + f * 31 + (i >> 5)) & 0xff));
    const encoder = new ApngEncoder(width, height, 4);
    for (const frame of frames) await encoder.addFrame(frame);
    const png = await encoder.finish();

    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer, png.byteOffset);
    const types: string[] = [];
    const images: Uint8Array[] = [];
    const sequence: number[] = [];
    for (let offset = 8; offset < png.length;) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
      const data = png.subarray(offset + 8, offset + 8 + length);
      expect(view.getUint32(offset + 8 + length), `${type} crc`).toBe(crc32(png.subarray(offset + 4, offset + 8 + length)));
      types.push(type);
      if (type === 'acTL') expect(new DataView(data.buffer, data.byteOffset).getUint32(0)).toBe(frames.length);
      if (type === 'fcTL' || type === 'fdAT') sequence.push(new DataView(data.buffer, data.byteOffset).getUint32(0));
      if (type === 'IDAT') images.push(data);
      if (type === 'fdAT') images.push(data.subarray(4));
      offset += length + 12;
    }
    expect(types).toEqual(['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'fcTL', 'fdAT', 'IEND']);
    expect(sequence).toEqual([0, 1, 2, 3, 4]);
    images.forEach((image, f) => {
      expect(Array.from(unpaeth(inflateSync(image), width, height))).toEqual(Array.from(frames[f]));
    });
  });
});

describe('rgbaToI420', () => {
  it('produces BT.709 limited-range values with 2x2 chroma', () => {
    // Columns: white, black; each a 2x2 block so chroma is unmixed. Then red.
    const block = (rgb: number[]) => [...rgb, 255];
    const row = [...block([255, 255, 255]), ...block([255, 255, 255]), ...block([0, 0, 0]), ...block([0, 0, 0]), ...block([255, 0, 0]), ...block([255, 0, 0])];
    const yuv = rgbaToI420(Uint8Array.from([...row, ...row]), 6, 2);
    expect(Array.from(yuv.subarray(0, 6))).toEqual([235, 235, 16, 16, 63, 63]);
    expect(Array.from(yuv.subarray(12, 15))).toEqual([128, 128, 102]); // Cb
    expect(Array.from(yuv.subarray(15, 18))).toEqual([128, 128, 240]); // Cr
  });

  it('rounds odd sizes up to even by repeating the last row and column', () => {
    // 3x3: white everywhere except a black bottom-right pixel.
    const rgba = new Uint8Array(3 * 3 * 4).fill(255);
    rgba.set([0, 0, 0, 255], 8 * 4);
    const yuv = rgbaToI420(rgba, 3, 3);
    expect(yuv.length).toBe(4 * 4 * 1.5);
    expect(Array.from(yuv.subarray(8, 16))).toEqual([235, 235, 16, 16, 235, 235, 16, 16]);
  });
});
