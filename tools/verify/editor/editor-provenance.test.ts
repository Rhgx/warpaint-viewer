// Focused contract check for the Phase 0 editor foundation.
//
// This bundles the real TypeScript modules with Vite, then resolves a small
// Black Box-like fixture through them. It deliberately does not duplicate the
// resolver or mutation logic in JavaScript.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  assignSelectGroupExclusively,
  EditorMutationAmbiguityError,
  setStickerDestQuad,
  toggleSelectGroupId,
} from '../../../src/editor/mutations';
import { resolveKitRecipeWithProvenance, type DecodedContainer } from '../../../src/protodefs/decoder';
import type { ApplyStickerNode, RecipeNode, SelectNode } from '../../../src/compositor/types';
import {
  type CombineStageMsg,
  type ItemDefinitionMsg,
  type ItemMsg,
  type OperationMsg,
  type OperationNodeMsg,
  type PaintkitDefinitionMsg,
  type SelectStageMsg,
  type VarDefMsg,
  type VarFieldMsg,
} from '../../../src/protodefs/messages';
import { buildResolveCtx } from '../../../src/protodefs/resolve';
import type { ProtoDefKitMessages, ProtoDefRecipeWithProvenance } from '../../../src/protodefs/types';

type FixtureItem = ItemMsg & {
  data: { variable: VarFieldMsg[] };
};

type FixtureDefinition = PaintkitDefinitionMsg & {
  blackbox: FixtureItem;
  scattergun?: FixtureItem;
};

type FixtureSelectStage = SelectStageMsg;

type FixtureCombineStage = CombineStageMsg & {
  operation_node: OperationNodeMsg[];
};

type FixtureOperation = OperationMsg & Record<string, unknown> & {
  operation_node: OperationNodeMsg[];
};

type FixtureMessages = ProtoDefKitMessages & {
  definition: FixtureDefinition;
  operation: FixtureOperation;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFixtureMessages(messages: ProtoDefKitMessages): messages is FixtureMessages {
  return isRecord(messages.definition)
    && isRecord(messages.operation)
    && Array.isArray(messages.operation.operation_node)
    && isRecord(messages.definition.blackbox);
}

function fixtureMessages(messages: ProtoDefKitMessages): FixtureMessages {
  assert.ok(isFixtureMessages(messages), 'fixture messages must retain their editable shape');
  return messages;
}

function isFixtureCombineStage(value: CombineStageMsg): value is FixtureCombineStage {
  return Array.isArray(value.operation_node);
}

function rootCombine(messages: FixtureMessages): FixtureCombineStage {
  const root = messages.operation.operation_node[0];
  assert.ok(root?.stage?.combine_multiply, 'fixture must have a root multiply stage');
  const combine = root.stage.combine_multiply;
  assert.ok(isFixtureCombineStage(combine), 'fixture multiply stage must have child nodes');
  return combine;
}

function selectStage(messages: FixtureMessages, occurrence = 0): FixtureSelectStage {
  const stage = rootCombine(messages).operation_node[occurrence]?.stage?.select;
  assert.ok(stage, `fixture must have select stage ${occurrence}`);
  return stage;
}

function definitionVariables(messages: FixtureMessages): VarDefMsg[] {
  const variables = messages.definition.header.variables;
  assert.ok(Array.isArray(variables), 'fixture definition variables must remain an array');
  return variables;
}

function recipeSelect(recipe: ProtoDefRecipeWithProvenance | null): SelectNode['select'] | undefined {
  function findSelect(node: RecipeNode): SelectNode | undefined {
    if (node.type === 'select') return node;
    if ('nodes' in node) {
      for (const child of node.nodes) {
        const selected = findSelect(child);
        if (selected) return selected;
      }
    }
    return undefined;
  }
  return recipe ? findSelect(recipe.tree)?.select : undefined;
}

function recipeSticker(recipe: ProtoDefRecipeWithProvenance): ApplyStickerNode | undefined {
  function findSticker(node: RecipeNode): ApplyStickerNode | undefined {
    if (node.type === 'apply_sticker') return node;
    if ('nodes' in node) {
      for (const child of node.nodes) {
        const sticker = findSticker(child);
        if (sticker) return sticker;
      }
    }
    return undefined;
  }
  return findSticker(recipe.tree);
}

const implementation = {
  assignSelectGroupExclusively,
  buildResolveCtx,
  EditorMutationAmbiguityError,
  resolveKitRecipeWithProvenance,
  setStickerDestQuad,
  toggleSelectGroupId,
};

test('editor provenance and safe mutations', () => {

const operation: FixtureOperation = {
  header: { defindex: 700, variables: [] },
  operation_node: [
    {
      stage: {
        combine_multiply: {
          adjust_black: { variable: 'slot_value' },
          adjust_offset: { variable: 'item_value' },
          adjust_gamma: { variable: 'wear_value' },
          operation_node: [
            { stage: { texture_lookup: { texture: { variable: 'global_texture' } } } },
            { stage: { select: { groups: { string: 'models/weapons/c_blackbox/c_blackbox_groups' }, select: { string: '16' } } } },
            {
              stage: {
                apply_sticker: {
                  dest_tl: { variable: 'sticker_tl' },
                  dest_tr: { variable: 'sticker_tr' },
                  dest_bl: { variable: 'sticker_bl' },
                },
              },
            },
          ],
        },
      },
    },
  ],
};

const itemDefinition: ItemDefinitionMsg = {
  header: { defindex: 100, variables: { name: 'item_value', value: '128', inherit: true } },
  item_definition_index: 42,
  definition: { variable: { variable: 'wear_value', string: '2' } },
};
const slot: FixtureItem = {
  item_definition_template: { defindex: 100 },
  data: { variable: [{ variable: 'slot_value', string: '32' }] },
};
const definition: FixtureDefinition = {
  header: {
    defindex: 900,
    variables: [
      { name: 'global_texture', value: 'patterns/blackbox', inherit: true },
      { name: 'slot_value', value: '0', inherit: true },
      { name: 'item_value', value: '255', inherit: true },
      { name: 'wear_value', value: '1', inherit: true },
      { name: 'sticker_tl', value: '0 0', inherit: true },
      { name: 'sticker_tr', value: '1 0', inherit: true },
      { name: 'sticker_bl', value: '0 1', inherit: true },
    ],
  },
  operation_template: { defindex: 700 },
  blackbox: slot,
};

function decodedFor(messages: FixtureMessages): DecodedContainer {
  const currentOperation = messages.operation;
  const currentDefinition = messages.definition;
  const ctx = implementation.buildResolveCtx([currentOperation], [itemDefinition], []);
  return {
    ctx,
    kitsByDefindex: new Map([[900, { def: currentDefinition, slots: [{ item: currentDefinition.blackbox, itemDef: itemDefinition, weaponKey: 'blackbox' }] }]]),
    index: { kits: [], countsByType: {} },
  };
}

const original: FixtureMessages = structuredClone({ definition, operation });
const traced = implementation.resolveKitRecipeWithProvenance(decodedFor(original), 900, 'blackbox', 'red', 0);
assert.ok(traced, 'fixture should resolve');
assert.equal(traced.tree.type, 'combine_multiply');
const sourceFor = (suffix: string) => traced.provenance.find((entry) => entry.fieldPath.at(-1) === suffix)?.provenance;
assert.equal(sourceFor('texture')?.scope, 'global');
assert.equal(sourceFor('adjust_black')?.scope, 'weapon');
assert.equal(sourceFor('adjust_offset')?.scope, 'weapon');
assert.equal(sourceFor('adjust_offset')?.sourcePath[0], 'itemDefinition');
assert.equal(sourceFor('adjust_gamma')?.scope, 'wear');
assert.equal(sourceFor('groups')?.scope, 'literal');
assert.equal(sourceFor('dest_tl')?.scope, 'global');

const groupEdited = fixtureMessages(implementation.toggleSelectGroupId(original, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
}, 224));
assert.deepEqual(selectStage(original, 1).select, { string: '16' }, 'group edit must not mutate original');
assert.deepEqual(selectStage(groupEdited, 1).select, [{ string: '16' }, { string: '224' }]);
const groupRecipe = implementation.resolveKitRecipeWithProvenance(decodedFor(groupEdited), 900, 'blackbox', 'red', 0);
assert.ok(groupRecipe);
assert.deepEqual(recipeSelect(groupRecipe), [16, 224], 'Black Box-like group 224 should affect the resolved selector');
const groupRemoved = fixtureMessages(implementation.toggleSelectGroupId(groupEdited, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
}, 224));
const removedRecipe = implementation.resolveKitRecipeWithProvenance(decodedFor(groupRemoved), 900, 'blackbox', 'red', 0);
assert.deepEqual(
  recipeSelect(removedRecipe),
  [16, 0],
  'toggling an assigned group clears its slot without changing the selector array shape',
);

const padded = structuredClone(original);
selectStage(padded, 1).select = [
  { string: '16' }, { string: '0' }, { string: '0' },
];
const paddedEdited = fixtureMessages(implementation.toggleSelectGroupId(padded, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
}, 224));
assert.deepEqual(
  selectStage(paddedEdited, 1).select,
  [{ string: '16' }, { string: '224' }, { string: '0' }],
  'adding a group fills the first unused slot instead of growing a fixed selector array',
);

const variableBacked = structuredClone(original);
definitionVariables(variableBacked).push(
  { name: 'texture_layer_2_select_1', value: '16' },
  { name: 'texture_layer_2_select_2', value: '0' },
);
selectStage(variableBacked, 1).select = [
  { variable: 'texture_layer_2_select_1', string: '0' },
  { variable: 'texture_layer_2_select_2', string: '0' },
];
const variableEdited = fixtureMessages(implementation.toggleSelectGroupId(variableBacked, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
}, 224));
assert.equal(
  definitionVariables(variableBacked).at(-1)?.value,
  '0',
  'variable-backed group edits must not mutate their input definitions',
);
assert.equal(
  definitionVariables(variableEdited).at(-1)?.value,
  '224',
  'variable-backed group edits write the unique definition-header source slot',
);
assert.deepEqual(
  selectStage(variableEdited, 1).select,
  selectStage(variableBacked, 1).select,
  'variable-backed edits preserve authored operation fields',
);

// Weapon and wear definitions commonly override a paint operation's selector
// variables. The first edit must capture those effective values and mark them
// non-inheritable; otherwise the UI count changes while the renderer keeps
// using the weapon override. Removing the added area then has to round-trip
// to that original effective selector.
const inheritedVariableBacked = structuredClone(original);
definitionVariables(inheritedVariableBacked).push(
  { name: 'inherited_select_1', value: '0', inherit: true },
  { name: 'inherited_select_2', value: '0', inherit: true },
);
selectStage(inheritedVariableBacked, 1).select = [
  { variable: 'inherited_select_1' },
  { variable: 'inherited_select_2' },
];
const inheritedSlot = structuredClone(slot);
inheritedSlot.data.variable = [
  { variable: 'inherited_select_1', string: '16' },
  { variable: 'inherited_select_2', string: '0' },
];
inheritedVariableBacked.definition.blackbox = inheritedSlot;
inheritedVariableBacked.definition.scattergun = {
  item_definition_template: { defindex: 100 },
  data: { variable: [
    { variable: 'inherited_select_1', string: '48' },
    { variable: 'inherited_select_2', string: '64' },
  ] },
};
function decodedForInherited(messages: FixtureMessages): DecodedContainer {
  const ctx = implementation.buildResolveCtx([messages.operation], [itemDefinition], []);
  const scattergun = messages.definition.scattergun;
  assert.ok(scattergun, 'fixture must retain the scattergun slot');
  return {
    ctx,
    kitsByDefindex: new Map([[900, { def: messages.definition, slots: [
      { item: messages.definition.blackbox, itemDef: itemDefinition, weaponKey: 'blackbox' },
      { item: scattergun, itemDef: itemDefinition, weaponKey: 'scattergun' },
    ] }]]),
    index: { kits: [], countsByType: {} },
  };
}
assert.deepEqual(
  recipeSelect(implementation.resolveKitRecipeWithProvenance(decodedForInherited(inheritedVariableBacked), 900, 'blackbox', 'red', 0)),
  [16, 0],
  'fixture must start from the weapon-provided effective selector values',
);
const inheritedAdded = fixtureMessages(implementation.toggleSelectGroupId(inheritedVariableBacked, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
  effectiveSelectValues: [16, 0],
  valueSourcePaths: [
    ['definition', 'blackbox', 'data', 'variable', '0'],
    ['definition', 'blackbox', 'data', 'variable', '1'],
  ],
}, 224));
assert.deepEqual(
  recipeSelect(implementation.resolveKitRecipeWithProvenance(decodedForInherited(inheritedAdded), 900, 'blackbox', 'red', 0)),
  [16, 224],
  'an inherited selector edit must change the resolved model selector',
);
assert.deepEqual(
  definitionVariables(inheritedAdded).slice(-2).map((entry) => [entry.value, entry.inherit]),
  [['0', true], ['0', true]],
  'a weapon-scoped edit must leave the shared paint-kit defaults untouched',
);
assert.deepEqual(
  inheritedAdded.definition.blackbox.data.variable.slice(-2).map((entry) => entry.string),
  ['16', '224'],
  'the effective baseline must be written into only the active weapon slot',
);
const inheritedRemoved = fixtureMessages(implementation.toggleSelectGroupId(inheritedAdded, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
  effectiveSelectValues: [16, 224],
  valueSourcePaths: [
    ['definition', 'blackbox', 'data', 'variable', '0'],
    ['definition', 'blackbox', 'data', 'variable', '1'],
  ],
}, 224));
assert.deepEqual(
  recipeSelect(implementation.resolveKitRecipeWithProvenance(decodedForInherited(inheritedRemoved), 900, 'blackbox', 'red', 0)),
  [16, 0],
  'removing an edited inherited area must restore the effective baseline',
);
assert.deepEqual(
  recipeSelect(implementation.resolveKitRecipeWithProvenance(decodedForInherited(inheritedRemoved), 900, 'scattergun', 'red', 0)),
  [48, 64],
  'clearing one weapon must preserve another weapon slot\'s assigned groups',
);

// A paintable part is owned by one texture layer at a time. Reassigning it
// must clear the previous selector before adding the active one, and still be
// a single undoable snapshot at the hook boundary.
const overlappingLayers = structuredClone(original);
rootCombine(overlappingLayers).operation_node = [
  { stage: { select: { groups: { string: 'models/weapons/c_blackbox/c_blackbox_groups' }, select: [{ string: '16' }, { string: '224' }] } } },
  { stage: { select: { groups: { string: 'models/weapons/c_blackbox/c_blackbox_groups' }, select: [{ string: '32' }, { string: '0' }] } } },
];
const reassigned = implementation.assignSelectGroupExclusively(overlappingLayers, {
  label: 'Top Layer',
  target: { groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups', occurrence: 1 },
}, [
  { label: 'Base Layer', target: { groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups', occurrence: 0 } },
  { label: 'Top Layer', target: { groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups', occurrence: 1 } },
], 224);
assert.equal(reassigned.action, 'moved');
assert.deepEqual(reassigned.displacedLabels, ['Base Layer']);
assert.deepEqual(
  rootCombine(fixtureMessages(reassigned.messages)).operation_node.map((_, index) => selectStage(fixtureMessages(reassigned.messages), index).select),
  [[{ string: '16' }, { string: '0' }], [{ string: '32' }, { string: '224' }]],
  'reassigning a part must clear its old layer before adding it to the active layer',
);
assert.deepEqual(
  selectStage(overlappingLayers).select,
  [{ string: '16' }, { string: '224' }],
  'exclusive assignment must not mutate the source snapshot',
);

// A visible selector can inherit values from a weapon definition. Reassigning
// one must freeze the complete visible baseline in both layers, rather than
// accidentally restoring the paint-kit defaults in the layer it clears.
const inheritedOverlap = structuredClone(inheritedVariableBacked);
inheritedOverlap.definition.header.variables = [
  { name: 'base_select_1', value: '0', inherit: true },
  { name: 'base_select_2', value: '0', inherit: true },
  { name: 'top_select_1', value: '0', inherit: true },
  { name: 'top_select_2', value: '0', inherit: true },
];
rootCombine(inheritedOverlap).operation_node = [
  { stage: { select: { groups: { string: 'models/weapons/c_blackbox/c_blackbox_groups' }, select: [{ variable: 'base_select_1' }, { variable: 'base_select_2' }] } } },
  { stage: { select: { groups: { string: 'models/weapons/c_blackbox/c_blackbox_groups' }, select: [{ variable: 'top_select_1' }, { variable: 'top_select_2' }] } } },
];
const inheritedMoved = implementation.assignSelectGroupExclusively(inheritedOverlap, {
  label: 'Top Layer',
  target: {
    groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups', occurrence: 1,
    effectiveSelectValues: [32, 0],
    valueSourcePaths: [
      ['definition', 'header', 'variables', '2'],
      ['definition', 'header', 'variables', '3'],
    ],
  },
}, [
  {
    label: 'Base Layer',
    target: {
      groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups', occurrence: 0,
      effectiveSelectValues: [16, 224],
      valueSourcePaths: [
        ['definition', 'header', 'variables', '0'],
        ['definition', 'header', 'variables', '1'],
      ],
    },
  },
], 224);
assert.deepEqual(
  definitionVariables(fixtureMessages(inheritedMoved.messages)).map((entry) => [entry.name, entry.value, entry.inherit]),
  [
    ['base_select_1', '16', false], ['base_select_2', '0', false],
    ['top_select_1', '32', false], ['top_select_2', '224', false],
  ],
  'reassigning inherited selectors must preserve and lock both visible baselines',
);

// Some shipped selectors inherit a full weapon-specific prefix but append
// shared zero slots in the operation. A full prefix must still be able to
// activate another slot through a weapon-local override.
const inheritedWithLiteralPadding = structuredClone(inheritedVariableBacked);
definitionVariables(inheritedWithLiteralPadding).push(
  { name: 'inherited_select_3', value: '0', inherit: false },
);
rootCombine(inheritedWithLiteralPadding).operation_node = [
  { stage: { select: {
    groups: { string: 'models/weapons/c_blackbox/c_blackbox_groups' },
    select: [{ variable: 'inherited_select_1' }, { variable: 'inherited_select_2' }, { variable: 'inherited_select_3' }],
  } } },
];
const paddedAdded = fixtureMessages(implementation.toggleSelectGroupId(inheritedWithLiteralPadding, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
  effectiveSelectValues: [16, 224, 0],
  inheritedSelectValues: [true, true, false],
  valueSourcePaths: [
    ['definition', 'blackbox', 'data', 'variable', '0'],
    ['definition', 'blackbox', 'data', 'variable', '1'],
    undefined,
  ],
  valueOverridePath: ['definition', 'blackbox', 'data', 'variable'],
}, 192));
assert.deepEqual(
  selectStage(paddedAdded).select,
  [{ variable: 'inherited_select_1' }, { variable: 'inherited_select_2' }, { variable: 'inherited_select_3' }],
  'shared selector padding must remain usable when every inherited slot is occupied',
);
assert.deepEqual(
  paddedAdded.definition.blackbox.data.variable.map((field) => [field.variable, field.string]),
  [['inherited_select_1', '16'], ['inherited_select_2', '224'], ['inherited_select_3', '192']],
  'using shared selector padding must create only a weapon-local override',
);
assert.equal(
  definitionVariables(paddedAdded).find((entry) => entry.name === 'inherited_select_3')?.inherit,
  true,
  'a newly used shared padding variable must inherit its weapon-local value',
);
assert.deepEqual(
  recipeSelect(implementation.resolveKitRecipeWithProvenance(decodedForInherited(paddedAdded), 900, 'blackbox', 'red', 0)),
  [16, 224, 192],
  'the activated shared slot must appear in the resolved weapon recipe',
);

const stickerEdited = fixtureMessages(implementation.setStickerDestQuad(original, {}, {
  tl: [0.2, 0.3], tr: [0.8, 0.3], bl: [0.2, 0.9],
}));
assert.equal(definitionVariables(original)[4]?.value, '0 0', 'sticker edit must not mutate original');
assert.equal(definitionVariables(stickerEdited)[4]?.value, '0.2 0.3');
const stickerRecipe = implementation.resolveKitRecipeWithProvenance(decodedFor(stickerEdited), 900, 'blackbox', 'red', 0);
assert.ok(stickerRecipe);
const stickerNode = recipeSticker(stickerRecipe);
assert.deepEqual(stickerNode?.destTl, [0.2, 0.3]);
assert.deepEqual(stickerNode?.destTr, [0.8, 0.3]);
assert.deepEqual(stickerNode?.destBl, [0.2, 0.9]);

const ambiguous = structuredClone(original);
rootCombine(ambiguous).operation_node.push({ stage: { select: { groups: { string: 'other_groups' }, select: { string: '32' } } } });
assert.throws(() => implementation.toggleSelectGroupId(ambiguous, {}, 48), implementation.EditorMutationAmbiguityError);

});
