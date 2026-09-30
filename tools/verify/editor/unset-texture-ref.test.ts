// A stage from the graph's Add menu has no texture yet, which the resolver
// carries as an empty ref. Connecting it must not reach the strict Source path
// normalizer ("Source paths cannot be empty" blanked the whole app).

import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RecipeNode } from '../../../src/compositor/types';
import { protoTextureReference } from '../../../src/editor/stickerTargets';
import { collectTextureRefs } from '../../../src/export/plan';

test('an unset texture ref names nothing to export or compare', () => {
  const recipe: RecipeNode = {
    type: 'combine_multiply',
    nodes: [
      { type: 'texture_lookup', texture: '' },
      { type: 'texture_lookup', texture: 'textures/patterns/surface.webp' },
      { type: 'select', groups: '', select: [1] },
    ],
  };
  assert.deepEqual(collectTextureRefs([recipe]), ['textures/patterns/surface.webp']);
  assert.equal(protoTextureReference(''), '');
  assert.equal(protoTextureReference('textures/patterns/surface.webp'), 'patterns/surface');
});
