// Sticker 2D surface source contract check.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import {
  preStickerSurface,
  recipeWithoutStickerOccurrence,
  recipeWithoutStickerOccurrences,
  resolvedGroupStickerContext,
} from '../../../src/editor/stickerSurface';
import { visibleStickerEditorMap } from '../../../src/viewer/stickerEditorMap';
import type { CombineNode, ApplyStickerNode } from '../../../src/compositor/types';
import type { ResolvedCombine, ResolvedNode, ResolvedSelect, ResolvedSticker } from '../../../src/compositor/resolve';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function resolvedCombineAt(nodes: readonly ResolvedNode[], index: number): ResolvedCombine {
  const node = nodes[index];
  if (!node || (node.type !== 'combine_add' && node.type !== 'combine_lerp' && node.type !== 'combine_multiply')) {
    throw new Error(`expected combine node at ${index}`);
  }
  return node;
}

function resolvedTextureAt(nodes: readonly ResolvedNode[], index: number): string {
  const node = nodes[index];
  if (!node || node.type !== 'texture_lookup') throw new Error(`expected texture node at ${index}`);
  return node.texture;
}

test('sticker surface preview source contract', () => {
  const nested: CombineNode = {
    type: 'combine_multiply',
    nodes: [
      { type: 'texture_lookup', texture: 'patterns/colour' },
      { type: 'select', groups: 'patterns/groups', select: [1] },
    ],
  };
  const stage: Pick<ApplyStickerNode, 'nodes'> = { nodes: [nested] };
  assert.equal(preStickerSurface(stage), nested, 'the complete nested pre-sticker tree is preserved');
  assert.equal(preStickerSurface({ nodes: [] }), null, 'a missing surface is not replaced with an invented preview');

  const firstSticker: ApplyStickerNode = {
    type: 'apply_sticker', stickers: [{ base: 'stickers/first' }],
    destTl: [0.1, 0.1], destTr: [0.2, 0.1], destBl: [0.1, 0.2], nodes: [{ type: 'texture_lookup', texture: 'base/first' }],
  };
  const secondSticker: ApplyStickerNode = {
    type: 'apply_sticker', stickers: [{ base: 'stickers/second' }],
    destTl: [0.6, 0.6], destTr: [0.7, 0.6], destBl: [0.6, 0.7], nodes: [{ type: 'texture_lookup', texture: 'base/second' }],
  };
  const completeRecipe: CombineNode = { type: 'combine_add', nodes: [firstSticker, secondSticker] };
  const withoutSecond = recipeWithoutStickerOccurrence(completeRecipe, 1);
  assert.ok(withoutSecond, 'a known sticker occurrence can be removed');
  if (withoutSecond.type !== 'combine_add') throw new Error('expected combine recipe');
  assert.equal(withoutSecond.nodes[0], firstSticker, 'other sticker stages stay in the full recipe');
  assert.equal(withoutSecond.nodes[1], secondSticker.nodes[0], 'only the selected sticker is replaced by its base');
  assert.equal(recipeWithoutStickerOccurrence(completeRecipe, 2), null, 'a missing occurrence never returns a misleading base');
  const withoutLogicalSticker = recipeWithoutStickerOccurrences(completeRecipe, [0, 1]);
  assert.ok(withoutLogicalSticker);
  if (withoutLogicalSticker.type !== 'combine_add') throw new Error('expected combine recipe');
  assert.equal(withoutLogicalSticker.nodes[0], firstSticker.nodes[0], 'the first wear-branch copy is removed');
  assert.equal(withoutLogicalSticker.nodes[1], secondSticker.nodes[0], 'the second wear-branch copy is removed');

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
  assert.ok(groupContext, 'a sticker in a lerp selector has a position-independent preview context');
  if (!groupContext || groupContext.base.type !== 'combine_lerp' || groupContext.endpointZero.type !== 'combine_lerp' || groupContext.endpointOne.type !== 'combine_lerp') throw new Error('expected group context');
  assert.equal(groupContext.base.nodes[2], siblingGroup, 'only the moving group is removed from the full base');
  assert.equal(groupContext.selectorBase, siblingGroup, 'other group stickers remain in the selector baseline');
  assert.match(resolvedTextureAt(groupContext.endpointZero.nodes, 2), /^data:image\/svg\+xml/, 'the zero endpoint replaces the complete selector');
  assert.match(resolvedTextureAt(groupContext.endpointOne.nodes, 2), /^data:image\/svg\+xml/, 'the one endpoint replaces the complete selector');
  const siblingGroupWear: ResolvedSticker = { ...siblingGroup, nodes: [rawSelector] };
  const movingGroupWear: ResolvedSticker = { ...movingGroup, nodes: [siblingGroupWear] };
  const groupRootWear: ResolvedCombine = { ...groupRoot, nodes: [...groupRoot.nodes.slice(0, 2), movingGroupWear] };
  const wearRoot: ResolvedCombine = { type: 'combine_add', ...transform, nodes: [groupRoot, groupRootWear] };
  const logicalGroupContext = resolvedGroupStickerContext(wearRoot, [movingGroup, movingGroupWear]);
  assert.ok(logicalGroupContext);
  if (!logicalGroupContext || logicalGroupContext.base.type !== 'combine_add' || logicalGroupContext.endpointZero.type !== 'combine_add') throw new Error('expected logical group context');
  assert.equal(resolvedCombineAt(logicalGroupContext.base.nodes, 0).nodes[2], siblingGroup, 'the first group-sticker wear copy is removed');
  assert.equal(resolvedCombineAt(logicalGroupContext.base.nodes, 1).nodes[2], siblingGroupWear, 'the second group-sticker wear copy is removed');
  assert.match(resolvedTextureAt(resolvedCombineAt(logicalGroupContext.endpointZero.nodes, 0).nodes, 2), /^data:image\/svg\+xml/, 'the first wear selector reaches zero');
  assert.match(resolvedTextureAt(resolvedCombineAt(logicalGroupContext.endpointZero.nodes, 1).nodes, 2), /^data:image\/svg\+xml/, 'the second wear selector reaches zero');
  const ordinarySticker: ResolvedSticker = { ...movingGroup, base: 'stickers/logo', nodes: [groupRoot] };
  assert.equal(
    resolvedGroupStickerContext(ordinarySticker, ordinarySticker),
    null,
    'an ordinary sticker outside a selector is not misclassified as a group sticker',
  );

  const fullMap = { name: 'newly composed full map' };
  const editorBase = { name: 'selected sticker removed' };
  assert.equal(visibleStickerEditorMap(fullMap, editorBase), editorBase, 'the live editor base wins over a late normal compose');
  assert.equal(visibleStickerEditorMap(fullMap, null), fullMap, 'clearing the editor base restores the newest normal compose');

  const appSource = fs.readFileSync(path.join(ROOT, 'src', 'App.tsx'), 'utf8');
  assert.match(
    appSource,
    /const undoEditorSynced = useCallback\(\(\) => \{\s*discardStickerDraft\(\);\s*undoEditor\(\);/,
    'undo discards the transient sticker draft before restoring authored coordinates',
  );
  assert.match(
    appSource,
    /const resetEditorSynced = useCallback\(\(\) => \{\s*discardStickerDraft\(\);\s*resetEditor\(\);/,
    'revert discards the transient sticker draft before restoring the baseline',
  );
  assert.match(
    appSource,
    /const draft = stickerDraftRef\.current;\s*if \(draft && authoredStickerQuad && stickerQuadsEqual\(draft, authoredStickerQuad\)\) \{\s*discardStickerDraft\(\);\s*\}/,
    'a settled local sticker draft remains visible until authored state catches up',
  );
});
