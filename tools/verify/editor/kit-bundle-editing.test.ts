// Per-wear editing contract: which operation the viewer's weapon and wear
// select, how one edit is written back into a bundle, and whether an edited
// operation previews for the weapon and wear that read it.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import type { Manifest } from '../../../src/data/types';
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
import {
  decodeProtoDefs,
  decodeProtoDefsFromJson,
  extractKitBundle,
  getKitWeaponSlots,
  resolveKitRecipe,
} from '../../../src/protodefs/decoder';
import type { ProtoDefKitBundle, ProtoDefOperationScope } from '../../../src/protodefs/types';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const weaponsByItemDef: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
const options = { weaponsByItemDef, builtInIds: manifest.paintkits.map((kit) => kit.id) };
const baseBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-base.bin')));
const full = decodeProtoDefs(new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-full.bin'))), options);

const KILLER_BEE = 85;
const WARHAWK = 80;
const SCATTERGUN = 'c_scattergun';

function bundleOf(defindex: number): ProtoDefKitBundle {
  const bundle = extractKitBundle(full, defindex);
  assert.ok(bundle, `kit ${defindex} should produce a bundle`);
  return bundle;
}

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

test('the viewer scope selects the matching Warhawk operation', () => {
  const warhawk = bundleOf(WARHAWK);
  const expected = warhawk.scopes.find((scope) => scope.weaponKey === 'c_flamethrower' && scope.wear === 2);
  assert.ok(expected, 'Warhawk should have a c_flamethrower wear 2 scope');
  const index = activeOperationIndex(warhawk, { weaponKey: 'c_flamethrower', wear: 2 });
  assert.equal(index, expected.operationIndex);
  assert.equal(operationMessages(warhawk, index)?.operation, warhawk.operations[index]);
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

test('a layer mutation on Killer Bee wear 0 leaves its other wears unchanged', () => {
  const bundle = bundleOf(KILLER_BEE);
  const index = activeOperationIndex(bundle, { weaponKey: SCATTERGUN, wear: 0 });
  const layer = firstLayer(bundle, index);

  const edited = applyBundleEdit(bundle, index, (messages) => setTextureTransformFlip(messages, layer.target, 'u', true));

  assert.notDeepEqual(edited.operations[index], bundle.operations[index], 'the wear 0 operation should change');
  for (let wear = 1; wear < bundle.operations.length; wear += 1) {
    assert.equal(edited.operations[wear], bundle.operations[wear], `wear ${wear} should be the same object`);
  }
  // The mutation clones the whole pair, so the definition is equal in content, not identity.
  assert.deepEqual(edited.definition, bundle.definition);
});

test('an edited per-wear operation previews only on the weapon and wear that read it', () => {
  const bundle = bundleOf(KILLER_BEE);
  const index = activeOperationIndex(bundle, { weaponKey: SCATTERGUN, wear: 0 });
  const layer = firstLayer(bundle, index);
  const edited = applyBundleEdit(bundle, index, (messages) => setTextureTransformFlip(messages, layer.target, 'u', true));

  const rebuilt = decodeProtoDefsFromJson(baseBytes, serializeProtoDefKitBundle(edited).fragments, options);
  const recipe = (decoded: typeof full, wear: number) => resolveKitRecipe(decoded, KILLER_BEE, SCATTERGUN, 'red', wear);
  assert.notDeepEqual(recipe(rebuilt, 0), recipe(full, 0), 'wear 0 should show the edit');
  for (let wear = 1; wear < 5; wear += 1) {
    assert.deepEqual(recipe(rebuilt, wear), recipe(full, wear), `wear ${wear} should keep its stock operation`);
  }
});

test('an unedited per-wear preview resolves every Warhawk scope like the stock container', () => {
  // The editor previews on open, so this preview source must match the stock one before any edit.
  const warhawk = bundleOf(WARHAWK);
  const rebuilt = decodeProtoDefsFromJson(baseBytes, serializeProtoDefKitBundle(warhawk).fragments, options);
  for (const scope of warhawk.scopes) {
    assert.deepEqual(
      resolveKitRecipe(rebuilt, WARHAWK, scope.weaponKey, 'red', scope.wear),
      resolveKitRecipe(full, WARHAWK, scope.weaponKey, 'red', scope.wear),
      `${scope.weaponKey} wear ${scope.wear} should match the stock container`,
    );
  }
});

test('a per-wear paint serializes every operation, item definition, and the definition', () => {
  const warhawk = bundleOf(WARHAWK);
  const { fragments } = serializeProtoDefKitBundle(warhawk);
  assert.equal(fragments.length, warhawk.operations.length + warhawk.itemDefinitions.length + 1);
});

test('weapon slots of a per-wear paint are located inside its definition', () => {
  const slots = getKitWeaponSlots(full, WARHAWK);
  assert.equal(new Set(slots.map((slot) => slot.weaponKey)).size, 3);
  assert.ok(slots.every((slot) => slot.path[0] === 'definition'), 'slot paths should start at the definition');
});
