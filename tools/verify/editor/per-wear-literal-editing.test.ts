// Per-wear sessions edit literal values in place: the sticker, group map, group
// id, transform and team artwork edits of one weapon and wear touch only that
// operation. A top-level paint keeps its discovery and gets no literal group map.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import type { Manifest } from '../../../src/data/types';
import {
  activeOperationIndex,
  applyBundleEdit,
  operationMessages,
  topLevelMessages,
} from '../../../src/editor/kitBundle';
import {
  assignSelectGroupExclusively,
  readTextureLayerTeamColors,
  setGroupTextureReference,
  setTextureLayerTeamColors,
  setTextureTransformRange,
  type SelectGroupAssignmentResult,
  type SelectGroupAssignmentTarget,
} from '../../../src/editor/mutations';
import { discoverGroupSelectTargets, discoverLiteralGroupTextureTarget, discoverGroupTextureTarget } from '../../../src/editor/layers/groupTargets';
import { discoverStickerPlacementTargets } from '../../../src/editor/sticker/stickerTargets';
import { discoverLayerTransforms } from '../../../src/editor/transform/transformTargets';
import {
  decodeProtoDefs,
  extractKitBundle,
  getKitWeaponSlots,
  resolveKitRecipeWithProvenance,
} from '../../../src/protodefs/decoder';
import type { ProtoDefKitBundle, ProtoDefKitMessages } from '../../../src/protodefs/types';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const weaponsByItemDef: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
const options = { weaponsByItemDef, builtInIds: manifest.paintkits.map((kit) => kit.id) };
const full = decodeProtoDefs(new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-full.bin'))), options);

const KILLER_BEE = 85;
const WARHAWK = 80;
const TOP_LEVEL = 300;

function bundleOf(defindex: number): ProtoDefKitBundle {
  const bundle = extractKitBundle(full, defindex);
  assert.ok(bundle, `kit ${defindex} should produce a bundle`);
  return bundle;
}

function operationAt(bundle: ProtoDefKitBundle, index: number): ProtoDefKitMessages {
  const messages = operationMessages(bundle, index);
  assert.ok(messages, `operation ${index} should exist`);
  return messages;
}

function assertOnlyOperationChanged(before: ProtoDefKitBundle, after: ProtoDefKitBundle, index: number): void {
  assert.notEqual(after.operations[index], before.operations[index], 'the scoped operation should change');
  after.operations.forEach((operation, position) => {
    if (position !== index) assert.equal(operation, before.operations[position], `operation ${position} should be reused`);
  });
  assert.deepEqual(after.scopes, before.scopes);
}

test('Killer Bee wear 0 exposes editable sticker targets for its literal operation', () => {
  const bundle = bundleOf(KILLER_BEE);
  const index = activeOperationIndex(bundle, { weaponKey: 'c_scattergun', wear: 0 });
  const stickers = discoverStickerPlacementTargets(
    operationAt(bundle, index),
    resolveKitRecipeWithProvenance(full, KILLER_BEE, 'c_scattergun', 'red', 0),
  );
  assert.equal(stickers.length, 5);
  assert.ok(stickers.every((sticker) => sticker.editable), 'every Killer Bee sticker should be movable');
});

test('Warhawk grenade launcher wear 1 discovers literal group targets but no variable group map', () => {
  const bundle = bundleOf(WARHAWK);
  const index = activeOperationIndex(bundle, { weaponKey: 'c_grenadelauncher', wear: 1 });
  const provenance = resolveKitRecipeWithProvenance(full, WARHAWK, 'c_grenadelauncher', 'red', 1)?.provenance;
  const discovery = discoverGroupSelectTargets(operationAt(bundle, index), provenance);
  const groupsRef = discovery.targets[0]?.groupsRef;

  assert.equal(discovery.targets.length, 4);
  assert.ok(discovery.targets.every((target) => target.canToggle && target.groupsRef === groupsRef));
  assert.equal(discoverGroupTextureTarget(provenance, groupsRef, ['operation', 'x']), null, 'a literal map has no variable to write');
  assert.deepEqual(discoverLiteralGroupTextureTarget(groupsRef, true), { kind: 'literal', groupsValue: groupsRef });
});

test('a group map rename edits only the scoped operation and every select stage that reads the map', () => {
  const bundle = bundleOf(WARHAWK);
  const index = activeOperationIndex(bundle, { weaponKey: 'c_grenadelauncher', wear: 1 });
  const groupsRef = discoverGroupSelectTargets(operationAt(bundle, index)).targets[0]?.groupsRef;
  assert.ok(groupsRef);
  const target = { kind: 'literal' as const, groupsValue: groupsRef };
  const renamed = 'patterns/combat/c_grenadelauncher_p40_groups_alt';

  const edited = applyBundleEdit(bundle, index, (messages) => setGroupTextureReference(messages, target, renamed));

  assertOnlyOperationChanged(bundle, edited, index);
  assert.deepEqual(edited.definition, bundle.definition, 'the shared definition is unchanged');
  const after = discoverGroupSelectTargets(operationAt(edited, index));
  assert.equal(after.targets.length, 4);
  assert.ok(after.targets.every((entry) => entry.groupsRef === renamed), 'all four stages now read the renamed map');
  assert.deepEqual(after.targets.map((entry) => entry.selectedGroupIds), [[32], [64], [80], [96]], 'the selected parts are kept');
});

test('a group id toggle on a literal select list edits only the scoped operation', () => {
  const bundle = bundleOf(WARHAWK);
  const index = activeOperationIndex(bundle, { weaponKey: 'c_grenadelauncher', wear: 1 });
  const discovery = discoverGroupSelectTargets(operationAt(bundle, index));
  const candidates: SelectGroupAssignmentTarget[] = discovery.targets.map((entry) => ({ target: entry.target, label: entry.label }));
  const active = candidates[0];

  const results: SelectGroupAssignmentResult[] = [];
  const edited = applyBundleEdit(bundle, index, (messages) => {
    const result = assignSelectGroupExclusively(messages, active, candidates, 16);
    results.push(result);
    return result.messages;
  });

  assert.equal(results[0]?.action, 'added', 'an unused id is added to the layer');
  assertOnlyOperationChanged(bundle, edited, index);
  assert.deepEqual(edited.definition, bundle.definition);
  const after = discoverGroupSelectTargets(operationAt(edited, index));
  assert.deepEqual(after.targets[0]?.selectedGroupIds, [16, 32]);
  assert.deepEqual(after.targets.slice(1).map((entry) => entry.selectedGroupIds), [[64], [80], [96]]);
});

test('a transform edit on a literal layer edits only the scoped operation', () => {
  const bundle = bundleOf(WARHAWK);
  const index = activeOperationIndex(bundle, { weaponKey: 'c_grenadelauncher', wear: 1 });
  const layer = discoverLayerTransforms(operationAt(bundle, index)).layers.targets[0];
  assert.ok(layer, 'the scoped operation should expose a transform layer');
  assert.equal(layer.blockers.length, 0);

  const edited = applyBundleEdit(bundle, index, (messages) => (
    setTextureTransformRange(messages, layer.target, 'rotation', { mode: 'fixed', min: 90, max: 90 })
  ));

  assertOnlyOperationChanged(bundle, edited, index);
  assert.deepEqual(edited.definition, bundle.definition);
  const after = discoverLayerTransforms(operationAt(edited, index)).layers.targets[0];
  assert.deepEqual(
    { mode: after?.rotation.mode, min: after?.rotation.min, max: after?.rotation.max },
    { mode: 'fixed', min: 90, max: 90 },
  );
});

test('team artwork on a literal layer is written in the scoped operation only', () => {
  const bundle = bundleOf(KILLER_BEE);
  const index = activeOperationIndex(bundle, { weaponKey: 'c_scattergun', wear: 0 });
  const layer = discoverLayerTransforms(operationAt(bundle, index)).layers.targets[0];
  assert.ok(layer);

  const edited = applyBundleEdit(bundle, index, (messages) => setTextureLayerTeamColors(messages, layer.target, true));

  assertOnlyOperationChanged(bundle, edited, index);
  assert.deepEqual(edited.definition, { ...bundle.definition, has_team_textures: true }, 'only the shared team flag changes');
  assert.equal(readTextureLayerTeamColors(operationAt(edited, index), layer.target)?.enabled, true);
});

test('a top-level paint keeps its group discovery and gets no literal group map', () => {
  const top = bundleOf(TOP_LEVEL);
  const messages = topLevelMessages(top);
  assert.ok(messages, 'a top-level paint exposes one definition and operation pair');
  const [slot] = getKitWeaponSlots(full, TOP_LEVEL);
  assert.ok(slot, 'the top-level paint should have a weapon slot');
  const recipe = resolveKitRecipeWithProvenance(full, TOP_LEVEL, slot.weaponKey, 'red', 0);
  const discovery = discoverGroupSelectTargets(messages, recipe?.provenance);

  assert.equal(discovery.targets.length, 3, 'group target count is unchanged');
  assert.equal(discovery.targets.filter((target) => target.canToggle).length, 3);
  assert.equal(discovery.hasUnresolvedGroupsReferences, false);
  const stickers = discoverStickerPlacementTargets(messages, recipe);
  assert.equal(stickers.length, 3, 'sticker target count is unchanged');
  assert.equal(discoverLayerTransforms(messages, recipe?.provenance).layers.targets.length, 3, 'transform layer count is unchanged');
  assert.equal(discoverLiteralGroupTextureTarget(discovery.targets[0]?.groupsRef, false), null);
});
