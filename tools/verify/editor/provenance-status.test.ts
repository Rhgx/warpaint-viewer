import assert from 'node:assert/strict';
import { test } from 'vitest';

import { provenanceRecipeKey, provenanceStatus } from '../../../src/editor/provenanceStatus';

const selection = {
  kitId: 442,
  sourceGeneration: 1,
  weaponKey: 'c_rocketlauncher',
  team: 'red',
  wearIndex: 0,
};

test('provenance keys change with the source generation, so a re-import cannot reuse replaced provenance', () => {
  const before = provenanceRecipeKey(selection);
  assert.notEqual(before, provenanceRecipeKey({ ...selection, sourceGeneration: 2 }));
  assert.notEqual(before, provenanceRecipeKey({ ...selection, sourceGeneration: 'stock' }));
  assert.equal(before, provenanceRecipeKey({ ...selection }));
});

test('a settled request answers only the key it was requested for', () => {
  const key = provenanceRecipeKey(selection);
  const recipe = { tree: 'resolved' };
  const afterReimport = provenanceRecipeKey({ ...selection, sourceGeneration: 2 });

  assert.equal(provenanceStatus({ key, recipe }, key), 'ready');
  assert.equal(provenanceStatus({ key, recipe }, afterReimport), 'pending');
});

test('a selection that settled without a recipe is unavailable, not pending', () => {
  const key = provenanceRecipeKey(selection);
  assert.equal(provenanceStatus({ key, recipe: null }, key), 'unavailable');
});

test('a selection with no request yet is pending', () => {
  const key = provenanceRecipeKey(selection);
  assert.equal(provenanceStatus(null, key), 'pending');
  assert.equal(provenanceStatus({ key: 'other', recipe: null }, key), 'pending');
  assert.equal(provenanceStatus(null, ''), 'pending');
});
