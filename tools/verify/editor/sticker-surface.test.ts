// Sticker artwork level-adjustment and 2D surface preview source contracts.

import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { ResolvedCombine, ResolvedSelect, ResolvedSticker } from '../../../src/compositor/resolve';
import type { ApplyStickerNode, CombineNode } from '../../../src/compositor/types';
import {
  adjustStickerArtworkPixels,
  matchResolvedStickerArtworkGroups,
  stickerArtworkNeedsComposedPreview,
  stickerLevelsAreIdentity,
  type StickerArtworkCandidate,
  type StickerArtworkTarget,
} from '../../../src/editor/sticker/stickerArtwork';
import {
  recipeWithoutStickerOccurrences,
  resolvedGroupStickerContext,
} from '../../../src/editor/sticker/stickerSurface';
import { dig } from '../fixtures';

const SVG = /^data:image\/svg\+xml/;

test('sticker artwork levels and pairing', () => {
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
    targets
      .map((target) => matchResolvedStickerArtworkGroups([{ ...target, occurrenceCount: 1 }], expanded)[0][0] ?? null)
      .map((candidate) => candidate?.base),
    ['stickers/first', 'textures/stickers/second.webp'],
  );
  const duplicated = [expanded[2], { ...expanded[2] }];
  assert.deepEqual(
    matchResolvedStickerArtworkGroups([{ ...targets[0], occurrenceCount: 2 }], duplicated)[0].map((candidate) => candidate.base),
    ['stickers/first', 'stickers/first'],
  );

  const pixels = new Uint8ClampedArray([51, 128, 204, 128]);
  adjustStickerArtworkPixels(pixels, { black: 0.2, white: 0.8, gamma: 1 });
  assert.deepEqual([...pixels], [0, 128, 255, 128]);

  const threshold = new Uint8ClampedArray([63, 64, 65, 255]);
  adjustStickerArtworkPixels(threshold, { black: 0.25, white: 0.25, gamma: 1 });
  assert.deepEqual([...threshold], [0, 255, 255, 255]);

  const gamma = new Uint8ClampedArray([128]);
  adjustStickerArtworkPixels(gamma, { black: 0, white: 1, gamma: 2 });
  assert.equal(gamma[0], 64);
});

test('sticker surface preview source contract', () => {
  const firstSticker: ApplyStickerNode = {
    type: 'apply_sticker', stickers: [{ base: 'stickers/first' }],
    destTl: [0.1, 0.1], destTr: [0.2, 0.1], destBl: [0.1, 0.2], nodes: [{ type: 'texture_lookup', texture: 'base/first' }],
  };
  const secondSticker: ApplyStickerNode = {
    type: 'apply_sticker', stickers: [{ base: 'stickers/second' }],
    destTl: [0.6, 0.6], destTr: [0.7, 0.6], destBl: [0.6, 0.7], nodes: [{ type: 'texture_lookup', texture: 'base/second' }],
  };
  const completeRecipe: CombineNode = { type: 'combine_add', nodes: [firstSticker, secondSticker] };
  const withoutSecond = recipeWithoutStickerOccurrences(completeRecipe, [1]);
  assert.ok(withoutSecond);
  if (withoutSecond.type !== 'combine_add') throw new Error('expected combine recipe');
  assert.equal(withoutSecond.nodes[0], firstSticker);
  assert.equal(withoutSecond.nodes[1], secondSticker.nodes[0]);
  assert.equal(recipeWithoutStickerOccurrences(completeRecipe, [2]), null);
  const withoutLogicalSticker = recipeWithoutStickerOccurrences(completeRecipe, [0, 1]);
  assert.ok(withoutLogicalSticker);
  if (withoutLogicalSticker.type !== 'combine_add') throw new Error('expected combine recipe');
  assert.equal(withoutLogicalSticker.nodes[0], firstSticker.nodes[0]);
  assert.equal(withoutLogicalSticker.nodes[1], secondSticker.nodes[0]);

  const transform = {
    black: 0, white: 1, gamma: 1, rotationDeg: 0,
    translateU: 0, translateV: 0, scale: 1, flipU: false, flipV: false,
  };
  const rawSelector: ResolvedSelect = { type: 'select', groups: 'groups', select: [16] };
  const siblingGroup: ResolvedSticker = {
    type: 'apply_sticker', base: 'masks/sibling', destTl: [0, 0], destTr: [0.2, 0], destBl: [0, 0.2],
    black: 0, white: 1, gamma: 1, nodes: [rawSelector],
  };
  const movingGroup: ResolvedSticker = {
    type: 'apply_sticker', base: 'masks/full-source', destTl: [0.2, 0.2], destTr: [0.4, 0.2], destBl: [0.2, 0.4],
    black: 0, white: 1, gamma: 1, nodes: [siblingGroup],
  };
  const groupRoot: ResolvedCombine = {
    type: 'combine_lerp', ...transform,
    nodes: [
      { type: 'texture_lookup', texture: 'paint/base', ...transform },
      { type: 'texture_lookup', texture: 'paint/layer', ...transform },
      movingGroup,
    ],
  };
  const groupContext = resolvedGroupStickerContext(groupRoot, movingGroup);
  assert.ok(groupContext);
  assert.equal(dig(groupContext.base, 'nodes', 2), siblingGroup);
  assert.equal(groupContext.selectorBase, siblingGroup);
  assert.match(String(dig(groupContext.endpointZero, 'nodes', 2, 'texture')), SVG);
  assert.match(String(dig(groupContext.endpointOne, 'nodes', 2, 'texture')), SVG);

  const siblingGroupWear: ResolvedSticker = { ...siblingGroup, nodes: [rawSelector] };
  const movingGroupWear: ResolvedSticker = { ...movingGroup, nodes: [siblingGroupWear] };
  const groupRootWear: ResolvedCombine = { ...groupRoot, nodes: [...groupRoot.nodes.slice(0, 2), movingGroupWear] };
  const wearRoot: ResolvedCombine = { type: 'combine_add', ...transform, nodes: [groupRoot, groupRootWear] };
  const logicalGroupContext = resolvedGroupStickerContext(wearRoot, [movingGroup, movingGroupWear]);
  assert.ok(logicalGroupContext);
  assert.equal(dig(logicalGroupContext.base, 'nodes', 0, 'nodes', 2), siblingGroup);
  assert.equal(dig(logicalGroupContext.base, 'nodes', 1, 'nodes', 2), siblingGroupWear);
  for (const wear of [0, 1]) {
    assert.match(String(dig(logicalGroupContext.endpointZero, 'nodes', wear, 'nodes', 2, 'texture')), SVG);
  }
  const ordinarySticker: ResolvedSticker = { ...movingGroup, base: 'stickers/logo', nodes: [groupRoot] };
  assert.equal(resolvedGroupStickerContext(ordinarySticker, ordinarySticker), null);
});
