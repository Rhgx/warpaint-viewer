import assert from 'node:assert/strict';
import { test } from 'vitest';
import { formatStickerValue } from '../../../src/ui/workbench/stickerValueFormat';

test('simple sticker values keep useful precision without floating-point noise', () => {
  for (const [value, expected] of [
    [0.7548, '0.7548'],
    [0.5, '0.5'],
    [37.125, '37.125'],
    [0.30000000000000004, '0.3'],
    [0.7548000000000001, '0.7548'],
    [-0, '0'],
    [0.123456789, '0.123457'],
  ] as const) assert.equal(formatStickerValue(value), expected);
});
