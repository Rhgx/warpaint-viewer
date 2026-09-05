// Sticker placement discovery/mutation contract. Bundles the production
// TypeScript implementation, then verifies a real resolver round trip rather
// than reimplementing proto resolution in JavaScript.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import type { RecipeNode } from '../../../src/compositor/types';
import {
  addStickerStages,
  moveStickerStages,
  removeStickerStages,
  setStickerDestQuad,
  type StickerQuad,
} from '../../../src/editor/mutations';
import { discoverStickerPlacementTargets } from '../../../src/editor/stickerTargets';
import {
  decodeProtoDefs,
  extractKitMessages,
  resolveKitRecipeWithProvenance,
  type DecodedContainer,
} from '../../../src/protodefs/decoder';
import { applyImplicitStickerSpecs } from '../../../src/protodefs/implicitStickerSpecs';
import {
  asItem,
  type CombineStageMsg,
  type ItemDefinitionMsg,
  type ItemMsg,
  type OperationMsg,
  type PaintkitDefinitionMsg,
  type StickerStageMsg,
} from '../../../src/protodefs/messages';
import { buildResolveCtx } from '../../../src/protodefs/resolve';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const implementation = {
  applyImplicitStickerSpecs,
  buildResolveCtx,
  decodeProtoDefs,
  discoverStickerPlacementTargets,
  addStickerStages,
  extractKitMessages,
  moveStickerStages,
  removeStickerStages,
  resolveKitRecipeWithProvenance,
  setStickerDestQuad,
};

test('sticker placement discovery and mutation', () => {

const implicitSpecRecipe: Extract<RecipeNode, { type: 'apply_sticker' }> = {
  type: 'apply_sticker',
  stickers: [
    { base: 'textures/patterns/reported_sticker.webp' },
    { base: 'textures/patterns/explicit.webp', spec: 'textures/patterns/custom_spec.webp' },
  ],
  nodes: [{ type: 'texture_lookup', texture: 'textures/patterns/surface.webp' }],
};
assert.equal(
  implementation.applyImplicitStickerSpecs(
    implicitSpecRecipe,
    (reference) => reference === 'textures/patterns/reported_sticker_s.webp',
  ),
  1,
  'one available implicit specular is attached to the editable recipe',
);
assert.equal(implicitSpecRecipe.stickers[0].spec, 'textures/patterns/reported_sticker_s.webp');
assert.equal(implicitSpecRecipe.stickers[1].spec, 'textures/patterns/custom_spec.webp', 'an explicit specular always wins');

type FixtureOperation = OperationMsg & Record<string, unknown>;
type FixtureDefinition = PaintkitDefinitionMsg & Record<string, unknown> & { blackbox: ItemMsg; scattergun: ItemMsg };
type FixtureMessages = { definition: FixtureDefinition; operation: FixtureOperation };

const operation: FixtureOperation = {
  header: { defindex: 701, variables: [] },
  operation_node: [{ stage: { combine_multiply: { operation_node: [
    { stage: { apply_sticker: {
      sticker: { base: { variable: 'sticker_base' }, weight: { variable: 'sticker_weight' }, spec: { variable: 'sticker_spec' } },
      dest_tl: { variable: 'sticker_tl' }, dest_tr: { variable: 'sticker_tr' }, dest_bl: { variable: 'sticker_bl' },
      operation_node: { stage: { texture_lookup: { texture: { string: 'patterns/surface' } } } },
    } } },
    { stage: { combine_add: { operation_node: { stage: { apply_sticker: {
      sticker: { base: { string: 'stickers/second' }, weight: { string: '1' } },
      dest_tl: { string: '0.1 0.1' }, dest_tr: { string: '0.3 0.1' }, dest_bl: { string: '0.1 0.4' },
    } } } } } },
  ] } } }],
};
const itemDefinition: ItemDefinitionMsg = { header: { defindex: 100, variables: [] }, item_definition_index: 42 };
const blackbox: ItemMsg = { item_definition_template: { defindex: 100 }, data: { variable: [
  { variable: 'sticker_base', string: 'stickers/weapon_base' },
  { variable: 'sticker_weight', string: '7' },
  { variable: 'sticker_spec', string: 'stickers/weapon_spec' },
  { variable: 'sticker_tl', string: '0.2 0.3' },
  { variable: 'sticker_tr', string: '0.8 0.3' },
  { variable: 'sticker_bl', string: '0.2 0.9' },
] } };
const scattergun: ItemMsg = {
  item_definition_template: { defindex: 100 },
  data: { variable: [
    { variable: 'sticker_base', string: 'stickers/weapon_base' },
    { variable: 'sticker_weight', string: '7' },
    { variable: 'sticker_spec', string: 'stickers/weapon_spec' },
    { variable: 'sticker_tl', string: '0.1 0.15' },
    { variable: 'sticker_tr', string: '0.6 0.15' },
    { variable: 'sticker_bl', string: '0.1 0.65' },
  ] },
};
const definition: FixtureDefinition = {
  header: { defindex: 901, variables: [
    { name: 'sticker_base', value: 'stickers/authored_base', inherit: true },
    { name: 'sticker_weight', value: '2', inherit: true },
    { name: 'sticker_spec', value: 'stickers/authored_spec', inherit: true },
    { name: 'sticker_tl', value: '0 0', inherit: true },
    { name: 'sticker_tr', value: '1 0', inherit: true },
    { name: 'sticker_bl', value: '0 1', inherit: true },
  ] },
  operation_template: { defindex: 701 },
  blackbox,
  scattergun,
};

function fixtureDefinition(value: Record<string, unknown>): FixtureDefinition {
  const blackboxItem = asItem(value.blackbox);
  const scattergunItem = asItem(value.scattergun);
  const header = value.header;
  const operationTemplate = value.operation_template;
  if (!blackboxItem || !scattergunItem || !header || typeof header !== 'object' || Array.isArray(header)
    || !operationTemplate || typeof operationTemplate !== 'object' || Array.isArray(operationTemplate)) {
    throw new TypeError('Sticker target fixture no longer has its expected definition shape.');
  }
  const definitionHeader = header as { defindex?: unknown };
  const template = operationTemplate as { defindex?: unknown };
  if (typeof definitionHeader.defindex !== 'number' || typeof template.defindex !== 'number') {
    throw new TypeError('Sticker target fixture has an invalid definition header.');
  }
  return value as unknown as FixtureDefinition;
}

function fixtureOperation(value: Record<string, unknown>): FixtureOperation {
  const header = value.header;
  const operationHeader = header && typeof header === 'object' && !Array.isArray(header)
    ? header as { defindex?: unknown }
    : undefined;
  if (typeof operationHeader?.defindex !== 'number') {
    throw new TypeError('Sticker target fixture no longer has its expected operation shape.');
  }
  return value as unknown as FixtureOperation;
}

function decodedDefinition(value: Record<string, unknown>): PaintkitDefinitionMsg {
  const header = value.header;
  const decodedHeader = header && typeof header === 'object' && !Array.isArray(header)
    ? header as { defindex?: unknown }
    : undefined;
  if (typeof decodedHeader?.defindex !== 'number') {
    throw new TypeError('Decoded paintkit definition has no numeric header defindex.');
  }
  return value as unknown as PaintkitDefinitionMsg;
}

function requiredArray<T>(value: T | T[] | undefined, label: string): T[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must remain an array in this fixture.`);
  return value;
}

function fixtureStickerCombine(operation: FixtureOperation): CombineStageMsg {
  const root = requiredArray(operation.operation_node, 'Fixture operation nodes')[0];
  const combine = root?.stage?.combine_multiply;
  if (!combine) throw new TypeError('Sticker target fixture no longer has its root multiply stage.');
  return combine;
}

function fixtureStickerStage(operation: FixtureOperation): StickerStageMsg {
  const node = requiredArray(fixtureStickerCombine(operation).operation_node, 'Fixture multiply nodes')[0];
  const stage = node?.stage?.apply_sticker;
  if (!stage) throw new TypeError('Sticker target fixture no longer has its primary sticker stage.');
  return stage;
}

function decodedFor(messages: ProtoDefKitMessages): DecodedContainer {
  const fixture = fixtureDefinition(messages.definition);
  const fixtureOperationMessage = fixtureOperation(messages.operation);
  return {
    ctx: implementation.buildResolveCtx([fixtureOperationMessage], [itemDefinition], []),
    kitsByDefindex: new Map([[901, { def: fixture, slots: [
      { item: fixture.blackbox, itemDef: itemDefinition, weaponKey: 'blackbox' },
      { item: fixture.scattergun, itemDef: itemDefinition, weaponKey: 'scattergun' },
    ] }]]),
    index: { kits: [], countsByType: {} },
  };
}
function resolve(messages: ProtoDefKitMessages, weaponKey = 'blackbox') {
  const result = implementation.resolveKitRecipeWithProvenance(decodedFor(messages), 901, weaponKey, 'red', 0);
  assert.ok(result, 'fixture should resolve through the production decoder');
  return result;
}

const original: FixtureMessages = structuredClone({ definition, operation });
const targets = implementation.discoverStickerPlacementTargets(original, resolve(original));
assert.equal(targets.length, 2, 'direct nested sticker stages should retain deterministic depth-first occurrences');
const first = targets[0];
assert.deepEqual(first.occurrences, [0], 'an ordinary sticker owns its single authored occurrence');
assert.equal(first.editable, true);
assert.deepEqual(first.quad, { tl: [0.2, 0.3], tr: [0.8, 0.3], bl: [0.2, 0.9] });
assert.equal(first.stickers[0].base.authoredValue, 'stickers/authored_base');
assert.equal(first.stickers[0].base.resolvedValue, 'stickers/weapon_base');
assert.equal(first.stickers[0].weight.authoredValue, '2');
assert.equal(first.stickers[0].weight.resolvedValue, '7');
assert.equal(first.stickers[0].spec.authoredValue, 'stickers/authored_spec');
assert.equal(first.stickers[0].spec.resolvedValue, 'stickers/weapon_spec');
assert.equal(targets[1].editable, true, 'literal corner fields should be editable too');

const duplicated = implementation.addStickerStages(
  original,
  { stagePaths: first.stagePaths },
  first.quad!,
  'stickers/new_artwork',
);
const duplicatedTargets = implementation.discoverStickerPlacementTargets(duplicated, resolve(duplicated));
assert.equal(duplicatedTargets.length, 3, 'duplicating a sticker adds an independent apply_sticker stage');
assert.deepEqual(duplicatedTargets[1].quad, first.quad, 'the duplicate starts at the selected sticker placement');
assert.notEqual(
  duplicatedTargets[1].destTl.variableName,
  duplicatedTargets[0].destTl.variableName,
  'the duplicate receives independent placement variables',
);
assert.equal(duplicatedTargets[1].stickers[0].base.resolvedValue, 'stickers/new_artwork');
assert.equal(duplicatedTargets[1].canMoveEarlier, true);

const shiftedDuplicateQuad: StickerQuad = { tl: [0.3, 0.25], tr: [0.7, 0.25], bl: [0.3, 0.75] };
const shiftedDuplicate = implementation.setStickerDestQuad(
  duplicated,
  duplicatedTargets[1].target,
  shiftedDuplicateQuad,
);
const movedEarlier = implementation.moveStickerStages(
  shiftedDuplicate,
  { stagePaths: implementation.discoverStickerPlacementTargets(shiftedDuplicate, resolve(shiftedDuplicate))[1].stagePaths },
  -1,
);
assert.deepEqual(
  implementation.discoverStickerPlacementTargets(movedEarlier, resolve(movedEarlier))[0].quad,
  shiftedDuplicateQuad,
  'reordering swaps the complete authored sticker stage',
);
const withoutDuplicate = implementation.removeStickerStages(
  movedEarlier,
  { stagePaths: implementation.discoverStickerPlacementTargets(movedEarlier, resolve(movedEarlier))[0].stagePaths },
);
assert.equal(
  implementation.discoverStickerPlacementTargets(withoutDuplicate, resolve(withoutDuplicate)).length,
  2,
  'removing a sticker deletes its authored stage',
);

const soleStickerWrapper: FixtureMessages = structuredClone({ definition, operation: {
  header: { defindex: 701, variables: [] },
  operation_node: { stage: { apply_sticker: {
    sticker: { base: { string: 'stickers/only' } },
    dest_tl: { string: '0 0' }, dest_tr: { string: '1 0' }, dest_bl: { string: '0 1' },
    operation_node: { stage: { texture_lookup: { texture: { string: 'patterns/surface' } } } },
  } } },
} });
const soleTarget = implementation.discoverStickerPlacementTargets(soleStickerWrapper, resolve(soleStickerWrapper))[0];
const withoutSoleSticker = implementation.removeStickerStages(
  soleStickerWrapper,
  { stagePaths: soleTarget.stagePaths },
);
const promotedSurface = fixtureOperation(withoutSoleSticker.operation).operation_node;
assert.ok(promotedSurface && !Array.isArray(promotedSurface));
assert.equal(
  implementation.discoverStickerPlacementTargets(withoutSoleSticker, resolve(withoutSoleSticker)).length,
  0,
  'removing the sole sticker deletes its authored stage',
);
assert.equal(
  promotedSurface.stage?.texture_lookup?.texture?.string,
  'patterns/surface',
  'removing the sole sticker preserves the wrapped paint recipe',
);

const stickerWrapperWithSibling: FixtureMessages = structuredClone({ definition, operation: {
  header: { defindex: 701, variables: [] },
  operation_node: [
    { stage: { texture_lookup: { texture: { string: 'patterns/sibling' } } } },
    { stage: { apply_sticker: {
      sticker: { base: { string: 'stickers/only' } },
      dest_tl: { string: '0 0' }, dest_tr: { string: '1 0' }, dest_bl: { string: '0 1' },
      operation_node: { stage: { texture_lookup: { texture: { string: 'patterns/wrapped' } } } },
    } } },
  ],
} });
const siblingTarget = implementation.discoverStickerPlacementTargets(
  stickerWrapperWithSibling,
  resolve(stickerWrapperWithSibling),
)[0];
const withoutSiblingSticker = implementation.removeStickerStages(
  stickerWrapperWithSibling,
  { stagePaths: siblingTarget.stagePaths },
);
assert.deepEqual(
  requiredArray(fixtureOperation(withoutSiblingSticker.operation).operation_node, 'Sibling fixture nodes')
    .map((node) => node.stage?.texture_lookup?.texture?.string),
  ['patterns/sibling', 'patterns/wrapped'],
  'removing a sticker with siblings preserves both the siblings and its wrapped paint recipe',
);

const duplicatedWear = structuredClone(original);
const duplicateCombine = fixtureStickerCombine(duplicatedWear.operation);
const duplicateNodes = requiredArray(duplicateCombine.operation_node, 'Fixture multiply nodes');
duplicateNodes.push(structuredClone(duplicateNodes[0]));
const logicalWearTargets = implementation.discoverStickerPlacementTargets(duplicatedWear, resolve(duplicatedWear));
assert.equal(logicalWearTargets.length, 2, 'wear-branch copies must not appear as separate logical stickers');
assert.deepEqual(
  logicalWearTargets[0].occurrences,
  [0, 2],
  'one logical sticker retains every duplicated wear-branch occurrence',
);

const movedQuad: StickerQuad = { tl: [0.4, 0.2], tr: [0.9, 0.4], bl: [0.2, 0.8] };
const moved = implementation.setStickerDestQuad(original, first.target, movedQuad);
assert.equal(requiredArray(original.definition.header.variables, 'Definition variables')[3]?.value, '0 0', 'placement mutation must never mutate its input');
assert.deepEqual(
  requiredArray(fixtureDefinition(moved.definition).header.variables, 'Definition variables')
    .slice(3).map((entry) => [entry.value, entry.inherit]),
  [['0 0', true], ['1 0', true], ['0 1', true]],
  'a weapon-scoped placement must not rewrite the shared paint-kit defaults',
);
assert.deepEqual(
  requiredArray(fixtureDefinition(moved.definition).blackbox.data?.variable, 'Blackbox variables')
    .slice(3).map((entry) => entry.string),
  ['0.4 0.2', '0.9 0.4', '0.2 0.8'],
  'an edited placement must write only the active weapon slot',
);
const movedTarget = implementation.discoverStickerPlacementTargets(moved, resolve(moved))[0];
assert.deepEqual(movedTarget.quad, movedQuad, 'production re-resolution must preserve the moved quad over weapon overrides');
const otherWeaponTarget = implementation.discoverStickerPlacementTargets(moved, resolve(moved, 'scattergun'))[0];
assert.deepEqual(
  otherWeaponTarget.quad,
  { tl: [0.1, 0.15], tr: [0.6, 0.15], bl: [0.1, 0.65] },
  'moving a sticker on one weapon must preserve another weapon slot\'s placement',
);

const sharedDestination = structuredClone(original);
const stage = fixtureStickerStage(sharedDestination.operation);
stage.dest_tr = { variable: 'sticker_tl' };
const rejected = implementation.discoverStickerPlacementTargets(sharedDestination, resolve(sharedDestination))[0];
assert.equal(rejected.editable, false, 'a shared destination variable is an unsafe affine target');
assert.ok(rejected.reason);
assert.match(rejected.reason, /same setting/i);

const unresolvedDestination = structuredClone(original);
fixtureStickerStage(unresolvedDestination.operation).dest_bl = { variable: 'missing_destination' };
const unresolved = implementation.discoverStickerPlacementTargets(unresolvedDestination, resolve(unresolvedDestination))[0];
assert.equal(unresolved.editable, false, 'unresolvable destination data must be read-only rather than guessed');
assert.ok(unresolved.reason);
assert.match(unresolved.reason, /missing|not numbers/i);

// Army Guns is the canonical shipped case that declares matching sticker
// destination variable names in both the definition and operation headers.
// Provenance must select the actual winning local source rather than making
// every one of its stickers read-only just because the names repeat.
const fullPath = path.join(ROOT, 'public', 'data', 'protodefs-full.bin');
const itemDefsPath = path.join(ROOT, 'public', 'data', 'item-defs.json');
const manifestPath = path.join(ROOT, 'public', 'data', 'manifest.json');
if (fs.existsSync(fullPath) && fs.existsSync(itemDefsPath) && fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const decoded = implementation.decodeProtoDefs(new Uint8Array(fs.readFileSync(fullPath)), {
    weaponsByItemDef: JSON.parse(fs.readFileSync(itemDefsPath, 'utf8')),
    builtInIds: manifest.paintkits.map((kit: { id: number }) => kit.id),
  });
  const armyGuns = implementation.extractKitMessages(decoded, 435);
  const armyInfo = decoded.kitsByDefindex.get(435);
  assert.ok(armyGuns && armyInfo?.slots.length, 'Army Guns must be present in shipped proto_defs');
  const weaponKey = armyInfo.slots[0].weaponKey;
  const armyResolved = implementation.resolveKitRecipeWithProvenance(decoded, 435, weaponKey, 'red', 0);
  assert.ok(armyResolved, 'Army Guns must resolve for a supported weapon');
  const armyTargets = implementation.discoverStickerPlacementTargets(armyGuns, armyResolved);
  assert.ok(armyTargets.length > 0, 'Army Guns must expose sticker stages');
  assert.ok(armyTargets.some((target) => target.editable), 'Army Guns should expose at least one editable sticker placement');
  const editableArmyTarget = armyTargets.find((target) => target.editable);
  assert.ok(editableArmyTarget?.quad);
  const movedArmyQuad: StickerQuad = {
    tl: [editableArmyTarget.quad.tl[0] + 0.01, editableArmyTarget.quad.tl[1]] ,
    tr: editableArmyTarget.quad.tr,
    bl: editableArmyTarget.quad.bl,
  };
  const movedArmy = implementation.setStickerDestQuad(armyGuns, editableArmyTarget.target, movedArmyQuad);
  assert.notEqual(movedArmy, armyGuns, 'Army Guns placement must mutate a detached snapshot');
  const activeSlot = armyInfo.slots.find((entry) => entry.weaponKey === weaponKey);
  const namedSlotKey = Object.keys(armyGuns.definition).find((key) => armyGuns.definition[key] === activeSlot?.item);
  const repeatedSlotIndex = Array.isArray(armyGuns.definition.item)
    ? armyGuns.definition.item.indexOf(activeSlot?.item)
    : -1;
  armyInfo.def = decodedDefinition(movedArmy.definition);
  if (activeSlot && namedSlotKey) {
    const movedSlot = asItem(movedArmy.definition[namedSlotKey]);
    assert.ok(movedSlot, 'Army Guns named slot must remain an item after mutation');
    activeSlot.item = movedSlot;
  }
  if (activeSlot && repeatedSlotIndex >= 0) {
    const movedItems = movedArmy.definition.item;
    const movedSlot = Array.isArray(movedItems) ? asItem(movedItems[repeatedSlotIndex]) : undefined;
    assert.ok(movedSlot, 'Army Guns repeated slot must remain an item after mutation');
    activeSlot.item = movedSlot;
  }
  const movedArmyOperation = fixtureOperation(movedArmy.operation);
  decoded.ctx.opByIdx.set(movedArmyOperation.header.defindex, movedArmyOperation);
  const movedArmyResolved = implementation.resolveKitRecipeWithProvenance(decoded, 435, weaponKey, 'red', 0);
  const movedArmyTargets = implementation.discoverStickerPlacementTargets(movedArmy, movedArmyResolved);
  assert.deepEqual(
    movedArmyTargets[editableArmyTarget.occurrence]?.quad,
    movedArmyQuad,
    'Army Guns must re-resolve the authored placement instead of retaining its weapon override',
  );
  console.log(`[verify] shipped Army Guns: ${armyTargets.filter((target) => target.editable).length}/${armyTargets.length} editable stickers`);
}

});
