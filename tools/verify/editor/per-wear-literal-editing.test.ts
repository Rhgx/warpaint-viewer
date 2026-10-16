// Per-wear sessions edit literal values in place: the sticker, group map, group
// id, transform and team artwork edits of one weapon and wear touch only that
// operation. A top-level paint keeps its discovery and gets no literal group map.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { activeOperationIndex, applyBundleEdit, operationMessages, topLevelMessages } from '../../../src/editor/kitBundle';
import {
  assignSelectGroupExclusively,
  readTextureLayerTeamColors,
  setGroupTextureReference,
  setTextureLayerTeamColors,
  setTextureTransformRange,
} from '../../../src/editor/mutations';
import { discoverGroupSelectTargets, discoverGroupTextureTarget, discoverLiteralGroupTextureTarget } from '../../../src/editor/layers/groupTargets';
import { discoverStickerPlacementTargets } from '../../../src/editor/sticker/stickerTargets';
import { discoverLayerTransforms } from '../../../src/editor/transform/transformTargets';
import { getKitWeaponSlots, resolveKitRecipeWithProvenance } from '../../../src/protodefs/decoder';
import type { ProtoDefKitBundle, ProtoDefKitMessages } from '../../../src/protodefs/types';
import { shippedProtoDefs } from '../fixtures';

// Read-only use of the shared decode: every edit below goes through applyBundleEdit, which copies.
const { bundleOf, full } = shippedProtoDefs();
const KILLER_BEE = 85;
const WARHAWK = 80;
const TOP_LEVEL = 300;

function operationAt(bundle: ProtoDefKitBundle, index: number): ProtoDefKitMessages {
  const messages = operationMessages(bundle, index);
  assert.ok(messages, `operation ${index} should exist`);
  return messages;
}

test('Killer Bee wear 0 stickers are all movable', () => {
  const bundle = bundleOf(KILLER_BEE);
  const index = activeOperationIndex(bundle, { weaponKey: 'c_scattergun', wear: 0 });
  const stickers = discoverStickerPlacementTargets(
    operationAt(bundle, index),
    resolveKitRecipeWithProvenance(full, KILLER_BEE, 'c_scattergun', 'red', 0),
  );
  assert.ok(stickers.length > 0 && stickers.every((sticker) => sticker.editable));
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

test('each literal edit changes only the scoped operation', () => {
  const warhawk = bundleOf(WARHAWK);
  const warhawkIndex = activeOperationIndex(warhawk, { weaponKey: 'c_grenadelauncher', wear: 1 });
  const groups = discoverGroupSelectTargets(operationAt(warhawk, warhawkIndex)).targets;
  const groupsRef = groups[0]?.groupsRef;
  assert.ok(groupsRef);
  const layer = discoverLayerTransforms(operationAt(warhawk, warhawkIndex)).layers.targets[0];
  assert.ok(layer && layer.blockers.length === 0);
  const killerBee = bundleOf(KILLER_BEE);
  const killerBeeIndex = activeOperationIndex(killerBee, { weaponKey: 'c_scattergun', wear: 0 });
  const teamLayer = discoverLayerTransforms(operationAt(killerBee, killerBeeIndex)).layers.targets[0];
  assert.ok(teamLayer);
  const renamed = 'patterns/combat/c_grenadelauncher_p40_groups_alt';
  const candidates = groups.map((entry) => ({ target: entry.target, label: entry.label }));

  const cases: Array<[string, ProtoDefKitBundle, number, (messages: ProtoDefKitMessages) => ProtoDefKitMessages, (after: ProtoDefKitMessages) => void]> = [
    ['group map rename', warhawk, warhawkIndex, (messages) => setGroupTextureReference(messages, { kind: 'literal', groupsValue: groupsRef }, renamed), (after) => {
      const targets = discoverGroupSelectTargets(after).targets;
      assert.ok(targets.every((entry) => entry.groupsRef === renamed), 'every stage reading the map is renamed');
      assert.deepEqual(targets.map((entry) => entry.selectedGroupIds), [[32], [64], [80], [96]], 'the selected parts are kept');
    }],
    ['group id toggle', warhawk, warhawkIndex, (messages) => assignSelectGroupExclusively(messages, candidates[0], candidates, 16).messages, (after) => {
      assert.deepEqual(discoverGroupSelectTargets(after).targets.map((entry) => entry.selectedGroupIds), [[16, 32], [64], [80], [96]]);
    }],
    ['transform', warhawk, warhawkIndex, (messages) => setTextureTransformRange(messages, layer.target, 'rotation', { mode: 'fixed', min: 90, max: 90 }), (after) => {
      const { mode, min, max } = discoverLayerTransforms(after).layers.targets[0]?.rotation ?? {};
      assert.deepEqual({ mode, min, max }, { mode: 'fixed', min: 90, max: 90 });
    }],
    ['team artwork', killerBee, killerBeeIndex, (messages) => setTextureLayerTeamColors(messages, teamLayer.target, true), (after) => {
      assert.equal(readTextureLayerTeamColors(after, teamLayer.target)?.enabled, true);
    }],
  ];
  for (const [label, before, index, edit, check] of cases) {
    const after = applyBundleEdit(before, index, edit);
    assert.notEqual(after.operations[index], before.operations[index], `${label}: the scoped operation should change`);
    after.operations.forEach((operation, position) => {
      if (position !== index) assert.equal(operation, before.operations[position], `${label}: operation ${position} should be reused`);
    });
    assert.deepEqual(after.scopes, before.scopes);
    // Team artwork also raises the shared has_team_textures flag; nothing else touches the definition.
    const definition = label === 'team artwork' ? { ...before.definition, has_team_textures: true } : before.definition;
    assert.deepEqual(after.definition, definition, `${label}: the shared definition is unchanged`);
    check(operationAt(after, index));
  }
});

test('a top-level paint keeps its group discovery and gets no literal group map', () => {
  const messages = topLevelMessages(bundleOf(TOP_LEVEL));
  assert.ok(messages, 'a top-level paint exposes one definition and operation pair');
  const [slot] = getKitWeaponSlots(full, TOP_LEVEL);
  assert.ok(slot, 'the top-level paint should have a weapon slot');
  const discovery = discoverGroupSelectTargets(messages, resolveKitRecipeWithProvenance(full, TOP_LEVEL, slot.weaponKey, 'red', 0)?.provenance);
  assert.ok(discovery.targets.length > 0 && discovery.targets.every((target) => target.canToggle));
  assert.equal(discovery.hasUnresolvedGroupsReferences, false);
  assert.equal(discoverLiteralGroupTextureTarget(discovery.targets[0]?.groupsRef, false), null);
});
