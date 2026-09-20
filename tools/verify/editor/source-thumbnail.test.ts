import { applyAlphaMask } from '../../../src/workbench/alphaMask';
import { describe, expect, it } from 'vitest';
import { opaqueRgbaThumbnail } from '../../../src/source/thumbnail';

describe('custom texture thumbnails', () => {
  it('averages authored RGB without applying the alpha channel', () => {
    const rgba = Uint8Array.from([
      200, 20, 10, 0,
      100, 40, 30, 4,
      20, 80, 50, 128,
      0, 100, 70, 255,
    ]);

    expect([...opaqueRgbaThumbnail(rgba, 2, 2, 1)]).toEqual([80, 60, 40, 255]);
  });

  it('rejects mismatched source dimensions', () => {
    expect(() => opaqueRgbaThumbnail(new Uint8Array(4), 2, 2, 1)).toThrow(/invalid RGBA dimensions/);
  });
});

it('alpha masks use transparency when present and luminance otherwise', () => {
  const color = Uint8ClampedArray.from([10, 20, 30, 255, 40, 50, 60, 255]);
  applyAlphaMask(color, Uint8ClampedArray.from([255, 255, 255, 0, 0, 0, 0, 128]));
  expect([...color]).toEqual([10, 20, 30, 0, 40, 50, 60, 128]);
  applyAlphaMask(color, Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255]));
  expect([...color]).toEqual([10, 20, 30, 76, 40, 50, 60, 150]);
});
