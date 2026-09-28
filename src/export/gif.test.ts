import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { buildPalette, encodeGif, GifEncoder } from './gif';

async function decode(gif: Uint8Array) {
  const { data, info } = await sharp(gif, { animated: true }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, pages: info.pages ?? 1 };
}

// Distinct 6-bit histogram bins, so a palette of <= 255 colours is lossless.
const color = (i: number) => [(i % 8) * 32 + 5, ((i >> 3) % 8) * 32 + 9, (i >> 6) * 32 + 17, 255];

function expectFramesMatch(decoded: Awaited<ReturnType<typeof decode>>, frames: Uint8Array[]) {
  expect(decoded.pages).toBe(frames.length);
  frames.forEach((frame, f) => {
    for (let p = 0; p < frame.length; p += 4) {
      const o = f * frame.length + p;
      const got = [decoded.data[o], decoded.data[o + 1], decoded.data[o + 2], decoded.data[o + 3]];
      if (frame[p + 3] === 0) expect(got[3], `frame ${f} pixel ${p / 4} alpha`).toBe(0);
      else expect(got, `frame ${f} pixel ${p / 4}`).toEqual([frame[p], frame[p + 1], frame[p + 2], 255]);
    }
  });
}

function sprites(offsets: number[], background: boolean) {
  const width = 40;
  const height = 30;
  const frames = offsets.map((offset) => {
    const frame = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const inside = x >= offset && x < offset + 10 && y >= 8 && y < 20;
        if (inside) frame.set(color(1 + ((x + y) % 5)), (y * width + x) * 4);
        else if (background) frame.set(color(0), (y * width + x) * 4);
      }
    }
    return frame;
  });
  return { width, height, frames };
}

describe('encodeGif', () => {
  it('round-trips a moving sprite through diffed, partly transparent frames', async () => {
    const { width, height, frames } = sprites([0, 6, 12, 12, 3], true);
    expectFramesMatch(await decode(encodeGif({ width, height, frames, delayCs: 4 })), frames);
  });

  it('clears pixels a transparent sprite leaves behind', async () => {
    const { width, height, frames } = sprites([0, 6, 12, 12, 30, 3], false);
    expectFramesMatch(await decode(encodeGif({ width, height, frames, delayCs: 4 })), frames);
  });

  it('refits spare entries into a local palette for a badly matched frame', async () => {
    const width = 256;
    const height = 8;
    const flat = new Uint8Array(width * height * 4);
    for (let p = 0; p < width * height; p++) flat.set(color(p % 40), p * 4);
    const gradient = new Uint8Array(width * height * 4);
    for (let p = 0; p < width * height; p++) gradient.set([p % width, 90, 255 - (p % width), 255], p * 4);

    const encoder = new GifEncoder(width, height, 4, buildPalette([flat]));
    encoder.addFrame(flat);
    encoder.addFrame(gradient);
    const decoded = await decode(encoder.finish());
    expect(decoded.pages).toBe(2);
    expect(Array.from(decoded.data.subarray(0, flat.length))).toEqual(Array.from(flat));
    let worst = 0;
    for (let p = 0; p < gradient.length; p += 4) {
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(decoded.data[gradient.length + p + c] - gradient[p + c]));
    }
    // The 40-colour shared palette alone would miss by over 30 levels; the
    // refit only chases pixels past POOR_FIT (0.03 Oklab, about ten levels).
    expect(worst).toBeLessThanOrEqual(12);
  });

  it('round-trips noise that forces LZW table resets', async () => {
    const width = 256;
    const height = 200;
    let seed = 1;
    const random = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const frames = [0, 1].map(() => {
      const frame = new Uint8Array(width * height * 4);
      for (let p = 0; p < width * height; p++) frame.set(color(Math.floor(random() * 200)), p * 4);
      return frame;
    });
    expectFramesMatch(await decode(encodeGif({ width, height, frames, delayCs: 5 })), frames);
  });
});
