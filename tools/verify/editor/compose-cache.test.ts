import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RecipeNode } from '../../../src/compositor/types';
import { recipeFingerprint } from '../../../src/hooks/useComposedPaint';

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
