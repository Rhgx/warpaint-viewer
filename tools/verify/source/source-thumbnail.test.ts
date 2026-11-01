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
