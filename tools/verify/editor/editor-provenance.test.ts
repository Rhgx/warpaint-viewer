// Focused contract check for the editor's provenance tracing and safe select
// mutations, resolved through the real decoder against a small Black Box-like
// fixture.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RecipeNode } from '../../../src/compositor/types';
import {
  assignSelectGroupExclusively,
  EditorMutationAmbiguityError,
  toggleSelectGroupId,
} from '../../../src/editor/mutations';
import { resolveKitRecipeWithProvenance } from '../../../src/protodefs/decoder';
import type { ItemDefinitionMsg, OperationNodeMsg, VarDefMsg, VarFieldMsg } from '../../../src/protodefs/messages';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';
import { dig, syntheticContainer } from '../fixtures';

const GROUPS = 'models/weapons/c_blackbox/c_blackbox_groups';
const BASE_VARIABLES: VarDefMsg[] = [
  { name: 'global_texture', value: 'patterns/blackbox', inherit: true },
  { name: 'slot_value', value: '0', inherit: true },
  { name: 'item_value', value: '255', inherit: true },
  { name: 'wear_value', value: '1', inherit: true },
  { name: 'sticker_tl', value: '0 0', inherit: true },
];
const INHERITED_VARIABLES: VarDefMsg[] = [
  ...BASE_VARIABLES,
  { name: 'inherited_select_1', value: '0', inherit: true },
  { name: 'inherited_select_2', value: '0', inherit: true },
];
const INHERITED_SLOT: VarFieldMsg[] = [
  { variable: 'inherited_select_1', string: '16' },
  { variable: 'inherited_select_2', string: '0' },
];
const INHERITED_SELECT: VarFieldMsg[] = [{ variable: 'inherited_select_1' }, { variable: 'inherited_select_2' }];
const BLACKBOX_PATHS = [['definition', 'blackbox', 'data', 'variable', '0'], ['definition', 'blackbox', 'data', 'variable', '1']];

const itemDefinition: ItemDefinitionMsg = {
  header: { defindex: 100, variables: { name: 'item_value', value: '128', inherit: true } },
  item_definition_index: 42,
  definition: { variable: { variable: 'wear_value', string: '2' } },
};
const decodedFor = (messages: ProtoDefKitMessages) => syntheticContainer(messages, itemDefinition, ['blackbox', 'scattergun']);

const layer = (select: VarFieldMsg | VarFieldMsg[]): OperationNodeMsg => ({ stage: { select: { groups: { string: GROUPS }, select } } });

function kit(
  layers: OperationNodeMsg[],
  variables = BASE_VARIABLES,
  blackbox: VarFieldMsg[] = [{ variable: 'slot_value', string: '32' }],
  scattergun?: VarFieldMsg[],
) {
  const slot = (variable: VarFieldMsg[]) => ({ item_definition_template: { defindex: 100 }, data: { variable } });
  return structuredClone({
    definition: {
      header: { defindex: 900, variables },
      operation_template: { defindex: 700 },
      blackbox: slot(blackbox),
      ...(scattergun ? { scattergun: slot(scattergun) } : {}),
    },
    operation: {
      header: { defindex: 700, variables: [] },
      operation_node: [{ stage: { combine_multiply: {
        adjust_black: { variable: 'slot_value' },
        adjust_offset: { variable: 'item_value' },
        adjust_gamma: { variable: 'wear_value' },
        operation_node: layers,
      } } }],
    },
  });
}

const original = kit([
  { stage: { texture_lookup: { texture: { variable: 'global_texture' } } } },
  layer({ string: '16' }),
  { stage: { apply_sticker: { dest_tl: { variable: 'sticker_tl' } } } },
]);

const selectAt = (messages: ProtoDefKitMessages, occurrence: number) =>
  dig(messages.operation, 'operation_node', 0, 'stage', 'combine_multiply', 'operation_node', occurrence, 'stage', 'select', 'select');

function resolvedSelect(messages: ProtoDefKitMessages, weaponKey = 'blackbox'): unknown {
  const find = (node: RecipeNode): unknown => (
    node.type === 'select' ? node.select : 'nodes' in node ? node.nodes.map(find).find(Boolean) : undefined
  );
  const recipe = resolveKitRecipeWithProvenance(decodedFor(messages), 900, weaponKey, 'red', 0);
  return recipe ? find(recipe.tree) : undefined;
}

test('provenance names the scope each field resolves from', () => {
  const traced = resolveKitRecipeWithProvenance(decodedFor(original), 900, 'blackbox', 'red', 0);
  assert.ok(traced, 'fixture should resolve');
  const sourceFor = (suffix: string) => traced.provenance.find((entry) => entry.fieldPath.at(-1) === suffix)?.provenance;
  assert.equal(sourceFor('texture')?.scope, 'global');
  assert.equal(sourceFor('adjust_black')?.scope, 'weapon');
  assert.equal(sourceFor('adjust_offset')?.scope, 'weapon');
  assert.equal(sourceFor('adjust_offset')?.sourcePath[0], 'itemDefinition');
  assert.equal(sourceFor('adjust_gamma')?.scope, 'wear');
  assert.equal(sourceFor('groups')?.scope, 'literal');
  assert.equal(sourceFor('dest_tl')?.scope, 'global');
});

test('toggling a literal group adds it, removes it in place, and fills padding first', () => {
  const added = toggleSelectGroupId(original, { groupsValue: GROUPS }, 224);
  assert.deepEqual(selectAt(original, 1), { string: '16' }, 'group edit must not mutate original');
  assert.deepEqual(selectAt(added, 1), [{ string: '16' }, { string: '224' }]);
  assert.deepEqual(resolvedSelect(added), [16, 224]);
  assert.deepEqual(
    resolvedSelect(toggleSelectGroupId(added, { groupsValue: GROUPS }, 224)),
    [16, 0],
    'toggling an assigned group clears its slot without changing the selector array shape',
  );

  const padded = kit([layer([{ string: '16' }, { string: '0' }, { string: '0' }])]);
  assert.deepEqual(
    selectAt(toggleSelectGroupId(padded, { groupsValue: GROUPS }, 224), 0),
    [{ string: '16' }, { string: '224' }, { string: '0' }],
    'adding a group fills the first unused slot instead of growing a fixed selector array',
  );

  const ambiguous = kit([layer({ string: '16' }), { stage: { select: { groups: { string: 'other_groups' }, select: { string: '32' } } } }]);
  assert.throws(() => toggleSelectGroupId(ambiguous, {}, 48), EditorMutationAmbiguityError);
});

test('a variable-backed group edit writes the definition-header source slot', () => {
  const select = [{ variable: 'texture_layer_2_select_1', string: '0' }, { variable: 'texture_layer_2_select_2', string: '0' }];
  const variableBacked = kit([layer(select)], [
    ...BASE_VARIABLES,
    { name: 'texture_layer_2_select_1', value: '16' },
    { name: 'texture_layer_2_select_2', value: '0' },
  ]);
  const edited = toggleSelectGroupId(variableBacked, { groupsValue: GROUPS }, 224);
  const last = BASE_VARIABLES.length + 1;
  assert.equal(dig(variableBacked.definition, 'header', 'variables', last, 'value'), '0', 'the input definition must not be mutated');
  assert.equal(dig(edited.definition, 'header', 'variables', last, 'value'), '224');
  assert.deepEqual(selectAt(edited, 0), select, 'variable-backed edits preserve authored operation fields');
});

// Weapon and wear definitions commonly override a paint operation's selector
// variables. The first edit must capture those effective values and mark them
// non-inheritable; otherwise the UI count changes while the renderer keeps
// using the weapon override. Removing the added area then has to round-trip
// to that original effective selector.
test('an inherited selector edit stays weapon-scoped and round-trips', () => {
  const inherited = kit([layer(INHERITED_SELECT)], INHERITED_VARIABLES, INHERITED_SLOT, [
    { variable: 'inherited_select_1', string: '48' },
    { variable: 'inherited_select_2', string: '64' },
  ]);
  assert.deepEqual(resolvedSelect(inherited), [16, 0], 'fixture must start from the weapon-provided effective selector values');

  const added = toggleSelectGroupId(inherited, { groupsValue: GROUPS, effectiveSelectValues: [16, 0], valueSourcePaths: BLACKBOX_PATHS }, 224);
  assert.deepEqual(resolvedSelect(added), [16, 224], 'an inherited selector edit must change the resolved model selector');
  assert.deepEqual(dig(added.definition, 'header', 'variables'), INHERITED_VARIABLES, 'shared paint-kit defaults stay untouched');
  assert.deepEqual(dig(added.definition, 'blackbox', 'data', 'variable', 1, 'string'), '224', 'only the active weapon slot is written');

  const removed = toggleSelectGroupId(added, { groupsValue: GROUPS, effectiveSelectValues: [16, 224], valueSourcePaths: BLACKBOX_PATHS }, 224);
  assert.deepEqual(resolvedSelect(removed), [16, 0], 'removing an edited inherited area must restore the effective baseline');
  assert.deepEqual(resolvedSelect(removed, 'scattergun'), [48, 64], 'another weapon slot keeps its assigned groups');
});

// A paintable part is owned by one texture layer at a time. Reassigning it
// must clear the previous selector before adding the active one.
test('exclusive assignment moves a part between layers and locks inherited baselines', () => {
  const target = (occurrence: number) => ({ groupsValue: GROUPS, occurrence });
  const overlapping = kit([layer([{ string: '16' }, { string: '224' }]), layer([{ string: '32' }, { string: '0' }])]);
  const reassigned = assignSelectGroupExclusively(overlapping, { label: 'Top Layer', target: target(1) }, [
    { label: 'Base Layer', target: target(0) },
    { label: 'Top Layer', target: target(1) },
  ], 224);
  assert.equal(reassigned.action, 'moved');
  assert.deepEqual(reassigned.displacedLabels, ['Base Layer']);
  assert.deepEqual([selectAt(reassigned.messages, 0), selectAt(reassigned.messages, 1)], [
    [{ string: '16' }, { string: '0' }], [{ string: '32' }, { string: '224' }],
  ]);
  assert.deepEqual(selectAt(overlapping, 0), [{ string: '16' }, { string: '224' }], 'the source snapshot is not mutated');

  // A visible selector can inherit values from a weapon definition. Reassigning
  // one must freeze the complete visible baseline in both layers, rather than
  // accidentally restoring the paint-kit defaults in the layer it clears.
  const headerPaths = (first: number) => [['definition', 'header', 'variables', `${first}`], ['definition', 'header', 'variables', `${first + 1}`]];
  const inherited = kit([
    layer([{ variable: 'base_select_1' }, { variable: 'base_select_2' }]),
    layer([{ variable: 'top_select_1' }, { variable: 'top_select_2' }]),
  ], ['base_select_1', 'base_select_2', 'top_select_1', 'top_select_2'].map((name) => ({ name, value: '0', inherit: true })));
  const moved = assignSelectGroupExclusively(inherited, {
    label: 'Top Layer',
    target: { ...target(1), effectiveSelectValues: [32, 0], valueSourcePaths: headerPaths(2) },
  }, [{ label: 'Base Layer', target: { ...target(0), effectiveSelectValues: [16, 224], valueSourcePaths: headerPaths(0) } }], 224);
  assert.deepEqual(dig(moved.messages.definition, 'header', 'variables'), [
    { name: 'base_select_1', value: '16', inherit: false }, { name: 'base_select_2', value: '0', inherit: false },
    { name: 'top_select_1', value: '32', inherit: false }, { name: 'top_select_2', value: '224', inherit: false },
  ]);
});

// Some shipped selectors inherit a full weapon-specific prefix but append
// shared zero slots in the operation. A full prefix must still be able to
// activate another slot through a weapon-local override.
test('a full inherited prefix activates shared literal padding through a weapon-local override', () => {
  const padded = kit(
    [layer([...INHERITED_SELECT, { variable: 'inherited_select_3' }])],
    [...INHERITED_VARIABLES, { name: 'inherited_select_3', value: '0', inherit: false }],
    INHERITED_SLOT,
  );
  const added = toggleSelectGroupId(padded, {
    groupsValue: GROUPS,
    effectiveSelectValues: [16, 224, 0],
    inheritedSelectValues: [true, true, false],
    valueSourcePaths: [...BLACKBOX_PATHS, undefined],
    valueOverridePath: ['definition', 'blackbox', 'data', 'variable'],
  }, 192);
  assert.deepEqual(selectAt(added, 0), [...INHERITED_SELECT, { variable: 'inherited_select_3' }], 'the operation selector is unchanged');
  assert.deepEqual(dig(added.definition, 'blackbox', 'data', 'variable'), [
    { variable: 'inherited_select_1', string: '16' },
    { variable: 'inherited_select_2', string: '224' },
    { variable: 'inherited_select_3', string: '192' },
  ]);
  assert.equal(dig(added.definition, 'header', 'variables', INHERITED_VARIABLES.length, 'inherit'), true, 'the padding variable now inherits');
  assert.deepEqual(resolvedSelect(added), [16, 224, 192]);
});
