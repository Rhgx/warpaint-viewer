import { expect, it } from 'vitest';
import { applyAlphaMask } from '../../../src/workbench/alphaMask';

it('alpha masks use transparency when present and luminance otherwise', () => {
  const color = Uint8ClampedArray.from([10, 20, 30, 255, 40, 50, 60, 255]);
  applyAlphaMask(color, Uint8ClampedArray.from([255, 255, 255, 0, 0, 0, 0, 128]));
  expect([...color]).toEqual([10, 20, 30, 0, 40, 50, 60, 128]);
  applyAlphaMask(color, Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255]));
  expect([...color]).toEqual([10, 20, 30, 76, 40, 50, 60, 150]);
});
