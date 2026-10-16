// Contract checks for conservative group-select target discovery.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { chooseBestSelectTargetForBucket, discoverGroupSelectTargets } from '../../../src/editor/layers/groupTargets';
import { toggleSelectGroupId } from '../../../src/editor/mutations';
import { dig } from '../fixtures';

const found = discoverGroupSelectTargets({
  definition: { header: { defindex: 1 } },
  operation: {
    header: { defindex: 2 },
    operation_node: { stage: { combine_multiply: { operation_node: [
      { stage: { select: { groups: { string: 'models/a_groups' }, select: [{ string: '16' }, { uint32: 0 }] } } },
      { stage: { apply_sticker: { operation_node: { stage: { select: { groups: { string: 'models/a_groups' }, select: { uint32: 32 } } } } } } },
      { stage: { select: { groups: { string: 'models/b_groups' }, select: [{ uint32: 48 }, { variable: 'shared_group' }] } } },
      { stage: { select: { groups: { string: 'models/c_groups' }, select: { uint32: 80 } } } },
      { stage: { select: { groups: { variable: 'groups_map' }, select: { uint32: 64 } } } },
      { operation_template: { defindex: 99 } },
    ] } } },
  },
});

test('discovery lists literal selectors and blocks variable-backed ones', () => {
  assert.deepEqual(found.targets.map((target) => target.target), [
    { groupsValue: 'models/a_groups', occurrence: 0 },
    { groupsValue: 'models/a_groups', occurrence: 1 },
    { groupsValue: 'models/b_groups', occurrence: 0 },
    { groupsValue: 'models/c_groups', occurrence: 0 },
  ]);
  assert.deepEqual(found.targets.map((target) => target.selectedGroupIds), [[16], [32], [48], [80]]);
  assert.deepEqual(found.targets.map((target) => target.canToggle), [true, true, false, true]);
  assert.deepEqual(found.targets[2].blockers, ['variable-select-value']);
  assert.equal(found.hasUnresolvedGroupsReferences, true);
  assert.equal(found.hasUnexpandedOperationTemplates, true);
});

// A selector is the mask input that follows the texture it controls. The UI
// must name that authored texture, including when it sits in a nested combine
// result, instead of exposing an implementation variable such as
// texture_layer_1_select_0.
test('a selector is labelled by the texture it masks', () => {
  const labelled = discoverGroupSelectTargets({
    definition: { header: { defindex: 3, variables: { name: 'nested_layer', value: 'patterns/workshop/example/p_nested_paint.vtf' } } },
    operation: {
      header: { defindex: 4, variables: { name: 'surface_layer', value: 'patterns/workshop/example/surface-stripe.webp' } },
      operation_node: { stage: { combine_lerp: { operation_node: [
        { stage: { texture_lookup: { texture: { string: 'patterns/blank_white' } } } },
        { stage: { texture_lookup: { texture: { variable: 'surface_layer' } } } },
        { stage: { select: { groups: { string: 'models/example_groups' }, select: { uint32: 16 } } } },
        { stage: { combine_multiply: { operation_node: { stage: { texture_lookup: { texture: { variable: 'nested_layer' } } } } } } },
        { stage: { select: { groups: { string: 'models/example_groups' }, select: { uint32: 32 } } } },
      ] } } },
    },
  });
  assert.deepEqual(labelled.targets.map((target) => [target.textureRef, target.label]), [
    ['patterns/workshop/example/surface-stripe.webp', 'Surface Stripe'],
    ['patterns/workshop/example/p_nested_paint.vtf', 'Nested Paint'],
  ]);
});

// Community paints such as Heatcast reserve more selector slots than each
// weapon overrides. Fixed, non-inherited tail slots do not need a weapon
// provenance path and must not make the complete layer read-only.
test('a selector with only part of it inherited per weapon stays editable', () => {
  const messages = {
    definition: {
      header: { defindex: 5, variables: [
        { name: 'layer_select_1', value: '0', inherit: true },
        { name: 'layer_select_2', value: '0', inherit: false },
        { name: 'layer_select_3', value: '0', inherit: true },
      ] },
      blackbox: { data: { variable: { variable: 'layer_select_1', string: '0' } } },
    },
    operation: {
      header: { defindex: 6 },
      operation_node: { stage: { combine_lerp: { operation_node: [
        { stage: { texture_lookup: { texture: { string: 'patterns/layer' } } } },
        { stage: { select: {
          groups: { string: 'models/example_groups' },
          select: [{ variable: 'layer_select_1' }, { variable: 'layer_select_2' }, { variable: 'layer_select_3' }],
        } } },
      ] } } },
    },
  };
  const weaponPath = ['definition', 'blackbox', 'data', 'variable'];
  const headerPath = ['definition', 'header', 'variables', '2', 'value'];
  const [target] = discoverGroupSelectTargets(messages, [
    { fieldPath: ['operation', 'layer_select_1'], provenance: {
      variableName: 'layer_select_1', effectiveValue: '0', sourcePath: weaponPath, editableSourcePath: weaponPath, scope: 'weapon', canOverride: true,
    } },
    { fieldPath: ['operation', 'layer_select_3'], provenance: {
      variableName: 'layer_select_3', effectiveValue: '0', sourcePath: headerPath, editableSourcePath: headerPath, scope: 'global', canOverride: true,
    } },
  ]).targets;
  assert.ok(target?.canToggle);
  assert.deepEqual(target.target.valueSourcePaths, [weaponPath, undefined, undefined]);
  assert.deepEqual(target.target.inheritedSelectValues, [true, false, false]);

  const edited = toggleSelectGroupId(messages, { ...target.target, effectiveSelectValues: [0, 0, 0] }, 32);
  assert.equal(dig(edited.definition, 'blackbox', 'data', 'variable', 'string'), '32');
  assert.equal(dig(edited.definition, 'header', 'variables', 1, 'value'), '0', 'non-inherited tail slots stay shared');
  assert.equal(dig(edited.definition, 'header', 'variables', 2, 'value'), '0', 'inherited padding is not rewritten per weapon');
});

test('a bucket picks the single editable selector that owns it', () => {
  assert.deepEqual(chooseBestSelectTargetForBucket(found, 16)?.target, { groupsValue: 'models/a_groups', occurrence: 0 });
  assert.deepEqual(chooseBestSelectTargetForBucket(found, 99, { groupsRef: 'models/c_groups' })?.target, { groupsValue: 'models/c_groups', occurrence: 0 });
  assert.equal(chooseBestSelectTargetForBucket(found, 99), null);
  assert.equal(chooseBestSelectTargetForBucket(found, 48), null);
  assert.equal(chooseBestSelectTargetForBucket(found, 0), null);
});
