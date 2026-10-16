// Sticker placement discovery/mutation contract, verified through a real
// resolver round trip rather than reimplementing proto resolution.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RecipeNode } from '../../../src/compositor/types';
import {
  addStickerStages,
  moveStickerStages,
  removeStickerStages,
  setStickerDestQuad,
  type StickerQuad,
} from '../../../src/editor/mutations';
import { discoverStickerPlacementTargets } from '../../../src/editor/sticker/stickerTargets';
import { resolveKitRecipeWithProvenance } from '../../../src/protodefs/decoder';
import { applyImplicitStickerSpecs } from '../../../src/protodefs/implicitStickerSpecs';
import type { ItemDefinitionMsg, OperationNodeMsg, StickerStageMsg, VarDefMsg, VarFieldMsg } from '../../../src/protodefs/messages';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';
import { dig, syntheticContainer, textureNode } from '../fixtures';

const itemDefinition: ItemDefinitionMsg = { header: { defindex: 100, variables: [] }, item_definition_index: 42 };
const DEFINITION_VARIABLES: VarDefMsg[] = [
  { name: 'sticker_base', value: 'stickers/authored_base', inherit: true },
  { name: 'sticker_weight', value: '2', inherit: true },
  { name: 'sticker_spec', value: 'stickers/authored_spec', inherit: true },
  { name: 'sticker_tl', value: '0 0', inherit: true },
  { name: 'sticker_tr', value: '1 0', inherit: true },
  { name: 'sticker_bl', value: '0 1', inherit: true },
];
const slot = (tl: string, tr: string, bl: string) => ({ item_definition_template: { defindex: 100 }, data: { variable: [
  { variable: 'sticker_base', string: 'stickers/weapon_base' },
  { variable: 'sticker_weight', string: '7' },
  { variable: 'sticker_spec', string: 'stickers/weapon_spec' },
  { variable: 'sticker_tl', string: tl },
  { variable: 'sticker_tr', string: tr },
  { variable: 'sticker_bl', string: bl },
] satisfies VarFieldMsg[] } });

function kit(operation_node: OperationNodeMsg | OperationNodeMsg[]) {
  return structuredClone({
    definition: {
      header: { defindex: 901, variables: DEFINITION_VARIABLES },
      operation_template: { defindex: 701 },
      blackbox: slot('0.2 0.3', '0.8 0.3', '0.2 0.9'),
      scattergun: slot('0.1 0.15', '0.6 0.15', '0.1 0.65'),
    },
    operation: { header: { defindex: 701, variables: [] }, operation_node },
  });
}

const primary = (stage: Partial<StickerStageMsg> = {}): OperationNodeMsg => ({ stage: { apply_sticker: {
  sticker: { base: { variable: 'sticker_base' }, weight: { variable: 'sticker_weight' }, spec: { variable: 'sticker_spec' } },
  dest_tl: { variable: 'sticker_tl' }, dest_tr: { variable: 'sticker_tr' }, dest_bl: { variable: 'sticker_bl' },
  operation_node: textureNode('patterns/surface'),
  ...stage,
} } });
const second: OperationNodeMsg = { stage: { combine_add: { operation_node: { stage: { apply_sticker: {
  sticker: { base: { string: 'stickers/second' }, weight: { string: '1' } },
  dest_tl: { string: '0.1 0.1' }, dest_tr: { string: '0.3 0.1' }, dest_bl: { string: '0.1 0.4' },
} } } } } };
const multiply = (children: OperationNodeMsg[]): OperationNodeMsg[] => [{ stage: { combine_multiply: { operation_node: children } } }];
const literalSticker = (wrapped: string): OperationNodeMsg => ({ stage: { apply_sticker: {
  sticker: { base: { string: 'stickers/only' } },
  dest_tl: { string: '0 0' }, dest_tr: { string: '1 0' }, dest_bl: { string: '0 1' },
  operation_node: textureNode(wrapped),
} } });

function targetsOf(messages: ProtoDefKitMessages, weaponKey = 'blackbox') {
  const resolved = resolveKitRecipeWithProvenance(syntheticContainer(messages, itemDefinition, ['blackbox', 'scattergun']), 901, weaponKey, 'red', 0);
  assert.ok(resolved, 'fixture should resolve through the production decoder');
  return discoverStickerPlacementTargets(messages, resolved);
}

const original = kit(multiply([primary(), second]));

test('a missing specular is filled from the implicit _s texture, an explicit one wins', () => {
  const recipe: Extract<RecipeNode, { type: 'apply_sticker' }> = {
    type: 'apply_sticker',
    stickers: [
      { base: 'textures/patterns/reported_sticker.webp' },
      { base: 'textures/patterns/explicit.webp', spec: 'textures/patterns/custom_spec.webp' },
    ],
    nodes: [{ type: 'texture_lookup', texture: 'textures/patterns/surface.webp' }],
  };
  assert.equal(applyImplicitStickerSpecs(recipe, (reference) => reference === 'textures/patterns/reported_sticker_s.webp'), 1);
  assert.deepEqual(recipe.stickers.map((sticker) => sticker.spec), ['textures/patterns/reported_sticker_s.webp', 'textures/patterns/custom_spec.webp']);
});

test('discovery reports authored and resolved values in depth-first order', () => {
  const [first, nested] = targetsOf(original);
  assert.deepEqual(first.occurrences, [0], 'an ordinary sticker owns its single authored occurrence');
  assert.equal(first.editable, true);
  assert.deepEqual(first.quad, { tl: [0.2, 0.3], tr: [0.8, 0.3], bl: [0.2, 0.9] });
  const { base, weight, spec } = first.stickers[0];
  assert.deepEqual([base, weight, spec].map((field) => [field.authoredValue, field.resolvedValue]), [
    ['stickers/authored_base', 'stickers/weapon_base'],
    ['2', '7'],
    ['stickers/authored_spec', 'stickers/weapon_spec'],
  ]);
  assert.equal(nested.editable, true, 'literal corner fields should be editable too');
});

test('add, reorder and remove whole sticker stages', () => {
  const first = targetsOf(original)[0];
  assert.ok(first.quad);
  const duplicated = addStickerStages(original, { stagePaths: first.stagePaths }, first.quad, 'stickers/new_artwork');
  const duplicatedTargets = targetsOf(duplicated);
  assert.equal(duplicatedTargets.length, 3, 'duplicating a sticker adds an independent apply_sticker stage');
  assert.deepEqual(duplicatedTargets[1].quad, first.quad, 'the duplicate starts at the selected sticker placement');
  assert.notEqual(duplicatedTargets[1].destTl.variableName, duplicatedTargets[0].destTl.variableName, 'independent placement variables');
  assert.equal(duplicatedTargets[1].stickers[0].base.resolvedValue, 'stickers/new_artwork');
  assert.equal(duplicatedTargets[1].canMoveEarlier, true);

  const shiftedQuad: StickerQuad = { tl: [0.3, 0.25], tr: [0.7, 0.25], bl: [0.3, 0.75] };
  const shifted = setStickerDestQuad(duplicated, duplicatedTargets[1].target, shiftedQuad);
  const movedEarlier = moveStickerStages(shifted, { stagePaths: targetsOf(shifted)[1].stagePaths }, -1);
  assert.deepEqual(targetsOf(movedEarlier)[0].quad, shiftedQuad, 'reordering swaps the complete authored sticker stage');
  const removed = removeStickerStages(movedEarlier, { stagePaths: targetsOf(movedEarlier)[0].stagePaths });
  assert.equal(targetsOf(removed).length, 2, 'removing a sticker deletes its authored stage');

  const sole = kit(literalSticker('patterns/surface'));
  const withoutSole = removeStickerStages(sole, { stagePaths: targetsOf(sole)[0].stagePaths });
  assert.equal(targetsOf(withoutSole).length, 0);
  assert.deepEqual(withoutSole.operation.operation_node, textureNode('patterns/surface'), 'the wrapped paint recipe is promoted');

  const withSibling = kit([textureNode('patterns/sibling'), literalSticker('patterns/wrapped')]);
  const withoutSibling = removeStickerStages(withSibling, { stagePaths: targetsOf(withSibling)[0].stagePaths });
  assert.deepEqual(withoutSibling.operation.operation_node, [textureNode('patterns/sibling'), textureNode('patterns/wrapped')],
    'removing a sticker with siblings preserves both the siblings and its wrapped paint recipe');
});

test('wear-branch copies are one logical sticker', () => {
  const targets = targetsOf(kit(multiply([primary(), second, primary()])));
  assert.equal(targets.length, 2, 'wear-branch copies must not appear as separate logical stickers');
  assert.deepEqual(targets[0].occurrences, [0, 2], 'one logical sticker retains every duplicated wear-branch occurrence');
});

test('moving a weapon-scoped sticker writes only the active weapon slot', () => {
  const movedQuad: StickerQuad = { tl: [0.4, 0.2], tr: [0.9, 0.4], bl: [0.2, 0.8] };
  const moved = setStickerDestQuad(original, targetsOf(original)[0].target, movedQuad);
  assert.deepEqual(dig(original.definition, 'header', 'variables'), DEFINITION_VARIABLES, 'the input is not mutated');
  assert.deepEqual(dig(moved.definition, 'header', 'variables'), DEFINITION_VARIABLES, 'shared paint-kit defaults are not rewritten');
  assert.deepEqual([3, 4, 5].map((index) => dig(moved.definition, 'blackbox', 'data', 'variable', index, 'string')), ['0.4 0.2', '0.9 0.4', '0.2 0.8']);
  assert.deepEqual(targetsOf(moved)[0].quad, movedQuad, 're-resolution keeps the moved quad over weapon overrides');
  assert.deepEqual(targetsOf(moved, 'scattergun')[0].quad, { tl: [0.1, 0.15], tr: [0.6, 0.15], bl: [0.1, 0.65] }, 'another weapon keeps its placement');
});

test('shared or unresolved destination variables are read-only', () => {
  const shared = targetsOf(kit(multiply([primary({ dest_tr: { variable: 'sticker_tl' } }), second])))[0];
  assert.equal(shared.editable, false, 'a shared destination variable is an unsafe affine target');
  assert.match(shared.reason ?? '', /same setting/i);
  const unresolved = targetsOf(kit(multiply([primary({ dest_bl: { variable: 'missing_destination' } }), second])))[0];
  assert.equal(unresolved.editable, false, 'unresolvable destination data must be read-only rather than guessed');
  assert.match(unresolved.reason ?? '', /missing|not numbers/i);
});
