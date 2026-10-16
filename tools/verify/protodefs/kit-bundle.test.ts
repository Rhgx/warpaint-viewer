import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import type { Manifest } from '../../../src/data/types';
import {
  decodeProtoDefs,
  decodeProtoDefsFromJson,
  extractKitBundle,
  extractKitMessages,
  resolveKitRecipe,
} from '../../../src/protodefs/decoder';
import { classifyProtoDefFragment } from '../../../src/protodefs/jsonFragments';
import type { ProtoDefKitBundle } from '../../../src/protodefs/types';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const weaponsByItemDef: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
const options = { weaponsByItemDef, builtInIds: manifest.paintkits.map((kit) => kit.id) };
const baseBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-base.bin')));
const full = decodeProtoDefs(new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-full.bin'))), options);

function bundleOf(defindex: number): ProtoDefKitBundle {
  const bundle = extractKitBundle(full, defindex);
  assert.ok(bundle, `kit ${defindex} should produce a bundle`);
  return bundle;
}

test('a per-wear paint bundles each weapon slot at every wear', () => {
  const warhawk = bundleOf(80);
  assert.equal(new Set(warhawk.scopes.map((scope) => scope.weaponKey)).size, 3);
  assert.equal(warhawk.scopes.length, 15);
  assert.equal(warhawk.operations.length, 15);
  assert.equal(warhawk.itemDefinitions.length, 3);

  const killerBee = bundleOf(85);
  assert.equal(killerBee.scopes.length, 5);
  assert.equal(killerBee.operations.length, 5);
  assert.equal(killerBee.itemDefinitions.length, 1);

  const woodsy = bundleOf(13);
  assert.equal(woodsy.scopes.length, 5);
  assert.equal(woodsy.operations.length, 5);
});

test('a top-level paint bundles exactly what extractKitMessages returns', () => {
  const bundle = bundleOf(109);
  const messages = extractKitMessages(full, 109);
  assert.ok(messages, 'kit 109 should have a top-level operation');
  assert.deepStrictEqual(bundle.definition, messages.definition);
  assert.equal(bundle.operations.length, 1);
  assert.deepStrictEqual(bundle.operations[0], messages.operation);
  assert.equal(bundle.itemDefinitions.length, 0);
  assert.equal(bundle.scopes.length, 0);
});

test('a per-wear paint rebuilt from JSON fragments resolves every scope like the full container', () => {
  const bundle = bundleOf(85);
  const fragments = [
    ...bundle.operations.map((operation, index) => ({ name: `operation_${index}.json`, text: JSON.stringify(operation) })),
    ...bundle.itemDefinitions.map((itemDefinition, index) => ({ name: `item_definition_${index}.json`, text: JSON.stringify(itemDefinition) })),
    { name: 'definition.json', text: JSON.stringify(bundle.definition) },
  ];
  for (const itemDefinition of bundle.itemDefinitions) {
    assert.equal(classifyProtoDefFragment(JSON.stringify(itemDefinition)), 'itemDefinition');
  }
  const rebuilt = decodeProtoDefsFromJson(baseBytes, fragments, options);
  assert.ok(rebuilt.index.kits.some((kit) => kit.defindex === 85), 'kit 85 should be in the rebuilt index');

  for (const scope of bundle.scopes) {
    const expected = resolveKitRecipe(full, 85, scope.weaponKey, 'red', scope.wear);
    assert.ok(expected, `${scope.weaponKey} wear ${scope.wear} should resolve in the full container`);
    const actual = resolveKitRecipe(rebuilt, 85, scope.weaponKey, 'red', scope.wear);
    assert.deepStrictEqual(actual, expected, `${scope.weaponKey} wear ${scope.wear} differs after the JSON round trip`);
  }
});
