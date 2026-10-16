// Sticker weight text follows the compositor rule: blank, missing, or
// non-numeric counts as 1, and any finite number (including negatives) is kept.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { stickerWeightFromString } from '../../../src/protodefs/values';

test('a missing, blank, or non-numeric sticker weight counts as 1', () => {
  assert.equal(stickerWeightFromString(undefined), 1);
  assert.equal(stickerWeightFromString(''), 1);
  assert.equal(stickerWeightFromString('   '), 1);
  assert.equal(stickerWeightFromString('heavy'), 1);
  assert.equal(stickerWeightFromString('Infinity'), 1);
});

test('a finite sticker weight is kept, including zero and negatives', () => {
  assert.equal(stickerWeightFromString('0'), 0);
  assert.equal(stickerWeightFromString('-2'), -2);
  assert.equal(stickerWeightFromString(' 2.5 '), 2.5);
});
