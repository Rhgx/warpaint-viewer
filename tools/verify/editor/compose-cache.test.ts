import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RecipeNode } from '../../../src/compositor/types';
import { applyTextureOverrides, recipeFingerprint } from '../../../src/hooks/useComposedPaint';

const recipe = (groups: string): RecipeNode => ({
  type: 'combine_lerp',
  nodes: [
    { type: 'texture_lookup', texture: 'patterns/base' },
    { type: 'texture_lookup', texture: 'patterns/paint' },
    { type: 'select', groups, select: [16, 32] },
  ],
});

test('recipe cache identity is stable across equivalent editor revisions', () => {
  const original = recipe('models/rocket_groups_04');
  const equivalent = structuredClone(original);
  assert.equal(recipeFingerprint(original), recipeFingerprint(equivalent));
  assert.notEqual(recipeFingerprint(original), recipeFingerprint(recipe('models/rocket_groups_05')));
});

test('texture override traversal keeps untouched branches and empty recipes by identity', () => {
  const untouched: RecipeNode = { type: 'texture_lookup', texture: 'patterns/untouched' };
  const changed: RecipeNode = { type: 'texture_lookup', texture: 'patterns/paint' };
  const root: RecipeNode = {
    type: 'combine_lerp',
    nodes: [untouched, changed, { type: 'select', groups: 'models/groups', select: [1] }],
  };

  assert.equal(applyTextureOverrides(root, {}), root);
  const next = applyTextureOverrides(root, { 'patterns/paint': 'blob:paint' });
  assert.notEqual(next, root);
  assert.equal(next.type, 'combine_lerp');
  if (next.type !== 'combine_lerp') return;
  assert.equal(next.nodes[0], untouched);
  assert.notEqual(next.nodes[1], changed);
  assert.equal(next.nodes[2], root.nodes[2]);
});

test('a supplied _s override adds specular to stickers whose recipe omits it', () => {
  const root: RecipeNode = {
    type: 'apply_sticker',
    stickers: [{ base: 'patterns/stickers/pig' }],
    nodes: [{ type: 'texture_lookup', texture: 'patterns/base' }],
  };

  const next = applyTextureOverrides(root, {
    'patterns/stickers/pig_s': 'blob:pig-specular',
  });
  assert.equal(next.type, 'apply_sticker');
  if (next.type !== 'apply_sticker') return;
  assert.equal(next.stickers[0]?.spec, 'blob:pig-specular');
});
