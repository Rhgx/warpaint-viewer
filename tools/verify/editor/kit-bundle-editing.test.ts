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
  selectActiveScope,
  topLevelMessages,
} from '../../../src/editor/kitBundle';
import { setTextureTransformFlip } from '../../../src/editor/mutations';
import { discoverLayerTransforms } from '../../../src/editor/transform/transformTargets';
import { decodeProtoDefsFromJson, resolveKitRecipe } from '../../../src/protodefs/decoder';
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

test('a write-back changes only the scoped operation and keeps the definition', () => {
  const warhawk = bundleOf(WARHAWK);
  const index = activeOperationIndex(warhawk, { weaponKey: 'c_flamethrower', wear: 2 });
  const priorOperation = warhawk.operations[index];
  assert.ok(priorOperation, 'the scoped operation should exist');
  const edited = applyBundleEdit(warhawk, index, (messages) => ({
    definition: messages.definition,
    operation: { ...messages.operation, operation_node: [] },
  }));

  assert.deepEqual(edited.operations[index].operation_node, []);
  assert.notDeepEqual(priorOperation.operation_node, [], 'the input bundle must not be mutated');
  edited.operations.forEach((operation, position) => {
    if (position !== index) assert.equal(operation, warhawk.operations[position], `operation ${position} should be reused`);
  });
  assert.equal(edited.definition, warhawk.definition, 'the shared definition is preserved');
  assert.equal(edited.itemDefinitions, warhawk.itemDefinitions);
  assert.deepEqual(edited.scopes, warhawk.scopes);
  assert.equal(
    applyBundleEdit(warhawk, index, (messages) => messages),
    warhawk,
    'an edit that changes nothing returns the bundle unchanged',
  );
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
