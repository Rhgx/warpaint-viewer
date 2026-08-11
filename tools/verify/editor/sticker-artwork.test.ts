// Sticker artwork level-adjustment contract check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  adjustStickerArtworkPixels,
  matchResolvedStickerArtwork,
  matchResolvedStickerArtworkGroups,
  stickerArtworkNeedsComposedPreview,
  stickerLevelsAreIdentity,
} from '../../../src/editor/stickerArtwork';
import type { StickerArtworkCandidate, StickerArtworkTarget } from '../../../src/editor/stickerArtwork';

test('sticker artwork levels', () => {
  assert.equal(stickerLevelsAreIdentity({ black: 0, white: 1, gamma: 1 }), true);
  assert.equal(stickerLevelsAreIdentity({ black: 0, white: 0.5, gamma: 1 }), false);
  assert.equal(stickerArtworkNeedsComposedPreview(['patterns/FFV3/square']), true);
  assert.equal(stickerArtworkNeedsComposedPreview(['textures/patterns/FFV3/groupsticker.webp']), true);
  assert.equal(stickerArtworkNeedsComposedPreview(['patterns/FFV3/black_square']), true);
  assert.equal(stickerArtworkNeedsComposedPreview(['patterns/FFV3/tf2logo']), false);
  const targets: StickerArtworkTarget[] = [
    { bases: ['stickers/first'], quad: { tl: [0.1, 0.2], tr: [0.3, 0.2], bl: [0.1, 0.4] } },
    { bases: ['stickers/second'], quad: { tl: [0.5, 0.6], tr: [0.7, 0.6], bl: [0.5, 0.8] } },
  ];
  const expanded: StickerArtworkCandidate[] = [
    { base: 'templates/unrelated', destTl: [0, 0], destTr: [1, 0], destBl: [0, 1] },
    { base: 'textures/stickers/second.webp', destTl: [0.5, 0.6], destTr: [0.7, 0.6], destBl: [0.5, 0.8] },
    { base: 'stickers/first', destTl: [0.1, 0.2], destTr: [0.3, 0.2], destBl: [0.1, 0.4] },
  ];
  assert.deepEqual(
    matchResolvedStickerArtwork(targets, expanded).map((candidate) => candidate?.base),
    ['stickers/first', 'textures/stickers/second.webp'],
    'expanded template stickers must not shift authored artwork pairing',
  );
  const duplicated = [expanded[2], { ...expanded[2] }];
  assert.deepEqual(
    matchResolvedStickerArtworkGroups([{ ...targets[0], occurrenceCount: 2 }], duplicated)[0].map((candidate) => candidate.base),
    ['stickers/first', 'stickers/first'],
    'one logical sticker pairs with every resolved wear-branch copy',
  );

  const pixels = new Uint8ClampedArray([51, 128, 204, 128]);
  adjustStickerArtworkPixels(pixels, { black: 0.2, white: 0.8, gamma: 1 });
  assert.deepEqual([...pixels], [0, 128, 255, 128], 'RGB and alpha follow the compositor level range');

  const threshold = new Uint8ClampedArray([63, 64, 65, 255]);
  adjustStickerArtworkPixels(threshold, { black: 0.25, white: 0.25, gamma: 1 });
  assert.deepEqual([...threshold], [0, 255, 255, 255], 'degenerate ranges reproduce the compositor threshold');

  const gamma = new Uint8ClampedArray([128]);
  adjustStickerArtworkPixels(gamma, { black: 0, white: 1, gamma: 2 });
  assert.equal(gamma[0], 64, 'gamma is applied after the black and white range');
});
