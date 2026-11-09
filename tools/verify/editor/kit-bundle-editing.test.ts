// Per-wear editing contract: which operation the viewer's weapon and wear
// select, how one edit is written back into a bundle, and whether an edited
// operation previews for the weapon and wear that read it.

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { serializeProtoDefKitBundle } from '../../../src/editor/export/jsonExport';
import {
  activeOperationIndex,
  applyBundleEdit,
  operationMessages,
  sameBundleContent,
  selectActiveScope,
  topLevelMessages,
} from '../../../src/editor/kitBundle';
import { setTextureTransformFlip, setTextureTransformRange } from '../../../src/editor/transform/transformMutations';
import { discoverLayerTransforms } from '../../../src/editor/transform/transformTargets';
import { decodeProtoDefsFromJson } from '../../../src/protodefs/decoder';
import { resolveKitRecipe } from '../../../src/protodefs/kitQueries';
import type { ProtoDefKitBundle, ProtoDefOperationScope } from '../../../src/protodefs/types';
import { shippedProtoDefs } from '../fixtures';

// Read-only use of the shared decode: every edit below goes through applyBundleEdit, which copies.
const { baseBytes, bundleOf, full, options } = shippedProtoDefs();
const KILLER_BEE = 85;
const WARHAWK = 80;
const SCATTERGUN = 'c_scattergun';

const scopes: ProtoDefOperationScope[] = [
  { weaponKey: 'c_flamethrower', wear: 0, operationIndex: 0 },
  { weaponKey: 'c_flamethrower', wear: 2, operationIndex: 2 },
  { weaponKey: 'tf_weapon_minigun', wear: 0, operationIndex: 5 },
  { weaponKey: 'tf_weapon_minigun', wear: 1, operationIndex: 6 },
];

/** The first texture layer the operation at index exposes for a transform. */
function firstLayer(bundle: ProtoDefKitBundle, index: number) {
  const messages = operationMessages(bundle, index);
  assert.ok(messages, 'the operation should exist');
  const layer = discoverLayerTransforms(messages).layers.targets[0];
  assert.ok(layer, 'the operation should expose a layer to transform');
  return layer;
}

test('scope selection prefers an exact match, then the weapon, then the first scope', () => {
  assert.deepEqual(selectActiveScope(scopes, { weaponKey: 'c_flamethrower', wear: 2 }), scopes[1]);
  assert.deepEqual(
    selectActiveScope(scopes, { weaponKey: 'tf_weapon_minigun', wear: 4 }),
    scopes[2],
    'a weapon with no matching wear uses its first wear',
  );
  assert.deepEqual(
    selectActiveScope(scopes, { weaponKey: 'unknown_weapon', wear: 3 }),
    scopes[0],
    'a weapon with no scope at all falls back to the first scope',
  );
  assert.deepEqual(selectActiveScope(scopes, undefined), scopes[0], 'no viewer scope uses the first scope');
  assert.equal(selectActiveScope([], { weaponKey: 'c_flamethrower', wear: 2 }), null, 'a top-level paint has no scope');
});

test('a top-level paint always edits operation 0, and only a per-wear paint has scopes', () => {
  const top = bundleOf(109);
  assert.equal(activeOperationIndex(top, { weaponKey: 'c_flamethrower', wear: 2 }), 0);
  assert.equal(topLevelMessages(top)?.operation, top.operations[0]);
  assert.equal(topLevelMessages(bundleOf(WARHAWK)), null, 'a per-wear paint has no single definition and operation pair');
});

test('a no-op edit returns the same bundle object', () => {
  const warhawk = bundleOf(WARHAWK);
  const index = activeOperationIndex(warhawk, { weaponKey: 'c_flamethrower', wear: 2 });
  assert.equal(
    applyBundleEdit(warhawk, index, (messages) => messages),
    warhawk,
    'an edit that changes nothing returns the bundle unchanged',
  );
});

test('a real edit leaves the input bundle unchanged', () => {
  const warhawk = bundleOf(WARHAWK);
  const index = activeOperationIndex(warhawk, { weaponKey: 'c_flamethrower', wear: 2 });
  const priorOperation = warhawk.operations[index];
  assert.ok(priorOperation, 'the scoped operation should exist');
  const before = structuredClone(warhawk);
  const edited = applyBundleEdit(warhawk, index, (messages) => ({
    definition: messages.definition,
    operation: { ...messages.operation, operation_node: [] },
  }));

  assert.notEqual(edited.operations[index], priorOperation, 'the scoped operation should change');
  assert.deepEqual(warhawk, before, 'the input bundle must not be mutated');
});

test('a Killer Bee wear 0 edit changes and previews only that wear', () => {
  const bundle = bundleOf(KILLER_BEE);
  const index = activeOperationIndex(bundle, { weaponKey: SCATTERGUN, wear: 0 });
  const layer = firstLayer(bundle, index);
  const edited = applyBundleEdit(bundle, index, (messages) => setTextureTransformFlip(messages, layer.target, 'u', true));
  for (let wear = 1; wear < bundle.operations.length; wear += 1) {
    assert.equal(edited.operations[wear], bundle.operations[wear], `wear ${wear} should be the same object`);
  }

  const rebuilt = decodeProtoDefsFromJson(baseBytes, serializeProtoDefKitBundle(edited).fragments, options);
  const recipe = (decoded: typeof full, wear: number) => resolveKitRecipe(decoded, KILLER_BEE, SCATTERGUN, 'red', wear);
  assert.notDeepEqual(recipe(rebuilt, 0), recipe(full, 0), 'wear 0 should show the edit');
  for (let wear = 1; wear < 5; wear += 1) {
    assert.deepEqual(recipe(rebuilt, wear), recipe(full, wear), `wear ${wear} should keep its stock operation`);
  }
});

test('writing a transform value that is already there leaves the bundle content the same', () => {
  const bundle = bundleOf(KILLER_BEE);
  const index = activeOperationIndex(bundle, { weaponKey: SCATTERGUN, wear: 0 });
  const layer = firstLayer(bundle, index);
  const flip = (from: ProtoDefKitBundle) => applyBundleEdit(from, index, (messages) => setTextureTransformFlip(messages, layer.target, 'u', true));
  const rotate = (from: ProtoDefKitBundle) => applyBundleEdit(from, index, (messages) => (
    setTextureTransformRange(messages, layer.target, 'rotation', { mode: 'fixed', min: 45, max: 45 })
  ));

  const flipped = flip(bundle);
  assert.equal(sameBundleContent(bundle, flipped), false, 'a real edit differs');
  const flippedAgain = flip(flipped);
  assert.notEqual(flippedAgain, flipped, 'the mutation still hands back a new bundle');
  assert.equal(sameBundleContent(flipped, flippedAgain), true);

  const rotated = rotate(flipped);
  assert.equal(sameBundleContent(flipped, rotated), false);
  assert.equal(sameBundleContent(rotated, rotate(rotated)), true);
});
