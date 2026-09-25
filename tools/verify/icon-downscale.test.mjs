import assert from 'node:assert/strict';
import { test } from 'vitest';
import { downscaleRGBA } from '../extract/icons.mjs';

test('icon downscale halves to fit and keeps transparent edges from darkening', () => {
  // 4x4: left half opaque red, right half fully transparent black.
  const pixels = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) pixels.push(...(x < 2 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const half = downscaleRGBA(new Uint8Array(pixels), 4, 4, 2);
  assert.deepEqual([half.width, half.height], [2, 2]);
  assert.deepEqual([...half.rgba.slice(0, 8)], [255, 0, 0, 255, 0, 0, 0, 0]);
  const one = downscaleRGBA(new Uint8Array(pixels), 4, 4, 1);
  assert.deepEqual([...one.rgba], [255, 0, 0, 128]);
});
