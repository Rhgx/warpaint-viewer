// Focused contract check for the Phase 0 editor foundation.
//
// This bundles the real TypeScript modules with Vite, then resolves a small
// Black Box-like fixture through them. It deliberately does not duplicate the
// resolver or mutation logic in JavaScript.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGING = path.join(ROOT, 'staging');
const BUILD_DIR = path.join(STAGING, 'editor-provenance-verify');

function bundleImplementation() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const entry = path.join(STAGING, 'editor-provenance-verify-entry.ts');
  fs.writeFileSync(entry,
    "export { resolveKitRecipeWithProvenance } from '../src/protodefs/decoder';\n"
    + "export { buildResolveCtx } from '../src/protodefs/resolve';\n"
    + "export { toggleSelectGroupId, assignSelectGroupExclusively, setStickerDestQuad, EditorMutationAmbiguityError } from '../src/editor/mutations';\n",
  );
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(process.execPath, [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) throw new Error('Vite could not bundle the TypeScript editor implementation.');
  return pathToFileURL(path.join(BUILD_DIR, 'editor-provenance-verify-entry.js')).href;
}

const implementation = await import(bundleImplementation());

const operation = {
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

const definition = {
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
};

const itemDefinition = {
  header: { defindex: 100, variables: { name: 'item_value', value: '128', inherit: true } },
  item_definition_index: 42,
  definition: { variable: { variable: 'wear_value', string: '2' } },
};
const slot = {
  item_definition_template: { defindex: 100 },
  data: { variable: { variable: 'slot_value', string: '32' } },
};
definition.blackbox = slot;

function decodedFor(messages) {
  const currentOperation = messages.operation;
  const currentDefinition = messages.definition;
  const ctx = implementation.buildResolveCtx([currentOperation], [itemDefinition], []);
  return {
    ctx,
    kitsByDefindex: new Map([[900, { def: currentDefinition, slots: [{ item: currentDefinition.blackbox, itemDef: itemDefinition, weaponKey: 'blackbox' }] }]]),
  };
}

const original = structuredClone({ definition, operation });
const traced = implementation.resolveKitRecipeWithProvenance(decodedFor(original), 900, 'blackbox', 'red', 0);
assert.ok(traced, 'fixture should resolve');
assert.equal(traced.tree.type, 'combine_multiply');
const sourceFor = (suffix) => traced.provenance.find((entry) => entry.fieldPath.at(-1) === suffix)?.provenance;
assert.equal(sourceFor('texture')?.scope, 'global');
assert.equal(sourceFor('adjust_black')?.scope, 'weapon');
assert.equal(sourceFor('adjust_offset')?.scope, 'weapon');
assert.equal(sourceFor('adjust_offset')?.sourcePath[0], 'itemDefinition');
assert.equal(sourceFor('adjust_gamma')?.scope, 'wear');
assert.equal(sourceFor('groups')?.scope, 'literal');
assert.equal(sourceFor('dest_tl')?.scope, 'global');

const groupEdited = implementation.toggleSelectGroupId(original, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
}, 224);
assert.deepEqual(original.operation.operation_node[0].stage.combine_multiply.operation_node[1].stage.select.select, { string: '16' }, 'group edit must not mutate original');
assert.deepEqual(groupEdited.operation.operation_node[0].stage.combine_multiply.operation_node[1].stage.select.select, [{ string: '16' }, { string: '224' }]);
const groupRecipe = implementation.resolveKitRecipeWithProvenance(decodedFor(groupEdited), 900, 'blackbox', 'red', 0);
assert.ok(groupRecipe);
const groupNode = groupRecipe.tree.nodes.find((node) => node.type === 'select');
assert.deepEqual(groupNode?.select, [16, 224], 'Black Box-like group 224 should affect the resolved selector');
const groupRemoved = implementation.toggleSelectGroupId(groupEdited, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
}, 224);
const removedRecipe = implementation.resolveKitRecipeWithProvenance(decodedFor(groupRemoved), 900, 'blackbox', 'red', 0);
assert.deepEqual(
  removedRecipe?.tree.nodes.find((node) => node.type === 'select')?.select,
  [16, 0],
  'toggling an assigned group clears its slot without changing the selector array shape',
);

const padded = structuredClone(original);
padded.operation.operation_node[0].stage.combine_multiply.operation_node[1].stage.select.select = [
  { string: '16' }, { string: '0' }, { string: '0' },
];
const paddedEdited = implementation.toggleSelectGroupId(padded, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
}, 224);
assert.deepEqual(
  paddedEdited.operation.operation_node[0].stage.combine_multiply.operation_node[1].stage.select.select,
  [{ string: '16' }, { string: '224' }, { string: '0' }],
  'adding a group fills the first unused slot instead of growing a fixed selector array',
);

const variableBacked = structuredClone(original);
variableBacked.definition.header.variables.push(
  { name: 'texture_layer_2_select_1', value: '16' },
  { name: 'texture_layer_2_select_2', value: '0' },
);
variableBacked.operation.operation_node[0].stage.combine_multiply.operation_node[1].stage.select.select = [
  { variable: 'texture_layer_2_select_1', string: '0' },
  { variable: 'texture_layer_2_select_2', string: '0' },
];
const variableEdited = implementation.toggleSelectGroupId(variableBacked, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
}, 224);
assert.equal(
  variableBacked.definition.header.variables.at(-1).value,
  '0',
  'variable-backed group edits must not mutate their input definitions',
);
assert.equal(
  variableEdited.definition.header.variables.at(-1).value,
  '224',
  'variable-backed group edits write the unique definition-header source slot',
);
assert.deepEqual(
  variableEdited.operation.operation_node[0].stage.combine_multiply.operation_node[1].stage.select.select,
  variableBacked.operation.operation_node[0].stage.combine_multiply.operation_node[1].stage.select.select,
  'variable-backed edits preserve authored operation fields',
);

// Weapon and wear definitions commonly override a paint operation's selector
// variables. The first edit must capture those effective values and mark them
// non-inheritable; otherwise the UI count changes while the renderer keeps
// using the weapon override. Removing the added area then has to round-trip
// to that original effective selector.
const inheritedVariableBacked = structuredClone(original);
inheritedVariableBacked.definition.header.variables.push(
  { name: 'inherited_select_1', value: '0', inherit: true },
  { name: 'inherited_select_2', value: '0', inherit: true },
);
inheritedVariableBacked.operation.operation_node[0].stage.combine_multiply.operation_node[1].stage.select.select = [
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
function decodedForInherited(messages) {
  const ctx = implementation.buildResolveCtx([messages.operation], [itemDefinition], []);
  return {
    ctx,
    kitsByDefindex: new Map([[900, { def: messages.definition, slots: [
      { item: messages.definition.blackbox, itemDef: itemDefinition, weaponKey: 'blackbox' },
      { item: messages.definition.scattergun, itemDef: itemDefinition, weaponKey: 'scattergun' },
    ] }]]),
  };
}
assert.deepEqual(
  implementation.resolveKitRecipeWithProvenance(decodedForInherited(inheritedVariableBacked), 900, 'blackbox', 'red', 0)
    ?.tree.nodes.find((node) => node.type === 'select')?.select,
  [16, 0],
  'fixture must start from the weapon-provided effective selector values',
);
const inheritedAdded = implementation.toggleSelectGroupId(inheritedVariableBacked, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
  effectiveSelectValues: [16, 0],
  valueSourcePaths: [
    ['definition', 'blackbox', 'data', 'variable', '0'],
    ['definition', 'blackbox', 'data', 'variable', '1'],
  ],
}, 224);
assert.deepEqual(
  implementation.resolveKitRecipeWithProvenance(decodedForInherited(inheritedAdded), 900, 'blackbox', 'red', 0)
    ?.tree.nodes.find((node) => node.type === 'select')?.select,
  [16, 224],
  'an inherited selector edit must change the resolved model selector',
);
assert.deepEqual(
  inheritedAdded.definition.header.variables.slice(-2).map((entry) => [entry.value, entry.inherit]),
  [['0', true], ['0', true]],
  'a weapon-scoped edit must leave the shared paint-kit defaults untouched',
);
assert.deepEqual(
  inheritedAdded.definition.blackbox.data.variable.slice(-2).map((entry) => entry.string),
  ['16', '224'],
  'the effective baseline must be written into only the active weapon slot',
);
const inheritedRemoved = implementation.toggleSelectGroupId(inheritedAdded, {
  groupsValue: 'models/weapons/c_blackbox/c_blackbox_groups',
  effectiveSelectValues: [16, 224],
  valueSourcePaths: [
    ['definition', 'blackbox', 'data', 'variable', '0'],
    ['definition', 'blackbox', 'data', 'variable', '1'],
  ],
}, 224);
assert.deepEqual(
  implementation.resolveKitRecipeWithProvenance(decodedForInherited(inheritedRemoved), 900, 'blackbox', 'red', 0)
    ?.tree.nodes.find((node) => node.type === 'select')?.select,
  [16, 0],
  'removing an edited inherited area must restore the effective baseline',
);
assert.deepEqual(
  implementation.resolveKitRecipeWithProvenance(decodedForInherited(inheritedRemoved), 900, 'scattergun', 'red', 0)
    ?.tree.nodes.find((node) => node.type === 'select')?.select,
  [48, 64],
  'clearing one weapon must preserve another weapon slot\'s assigned groups',
);

// A paintable part is owned by one texture layer at a time. Reassigning it
// must clear the previous selector before adding the active one, and still be
// a single undoable snapshot at the hook boundary.
const overlappingLayers = structuredClone(original);
overlappingLayers.operation.operation_node[0].stage.combine_multiply.operation_node = [
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
  reassigned.messages.operation.operation_node[0].stage.combine_multiply.operation_node.map((node) => node.stage.select.select),
  [[{ string: '16' }, { string: '0' }], [{ string: '32' }, { string: '224' }]],
  'reassigning a part must clear its old layer before adding it to the active layer',
);
assert.deepEqual(
  overlappingLayers.operation.operation_node[0].stage.combine_multiply.operation_node[0].stage.select.select,
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
inheritedOverlap.operation.operation_node[0].stage.combine_multiply.operation_node = [
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
  inheritedMoved.messages.definition.header.variables.map((entry) => [entry.name, entry.value, entry.inherit]),
  [
    ['base_select_1', '16', false], ['base_select_2', '0', false],
    ['top_select_1', '32', false], ['top_select_2', '224', false],
  ],
  'reassigning inherited selectors must preserve and lock both visible baselines',
);

const stickerEdited = implementation.setStickerDestQuad(original, {}, {
  tl: [0.2, 0.3], tr: [0.8, 0.3], bl: [0.2, 0.9],
});
assert.equal(original.definition.header.variables[4].value, '0 0', 'sticker edit must not mutate original');
assert.equal(stickerEdited.definition.header.variables[4].value, '0.2 0.3');
const stickerRecipe = implementation.resolveKitRecipeWithProvenance(decodedFor(stickerEdited), 900, 'blackbox', 'red', 0);
assert.ok(stickerRecipe);
const stickerNode = stickerRecipe.tree.nodes.find((node) => node.type === 'apply_sticker');
assert.deepEqual(stickerNode?.destTl, [0.2, 0.3]);
assert.deepEqual(stickerNode?.destTr, [0.8, 0.3]);
assert.deepEqual(stickerNode?.destBl, [0.2, 0.9]);

const ambiguous = structuredClone(original);
ambiguous.operation.operation_node[0].stage.combine_multiply.operation_node.push({ stage: { select: { groups: { string: 'other_groups' }, select: { string: '32' } } } });
assert.throws(() => implementation.toggleSelectGroupId(ambiguous, {}, 48), implementation.EditorMutationAmbiguityError);

console.log('[verify] PASS: provenance tracks global/weapon/wear/literal values; cloned group and sticker edits re-resolve safely.');
