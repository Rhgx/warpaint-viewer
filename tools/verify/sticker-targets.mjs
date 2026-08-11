// Sticker placement discovery/mutation contract. Bundles the production
// TypeScript implementation, then verifies a real resolver round trip rather
// than reimplementing proto resolution in JavaScript.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'sticker-targets-verify');

function bundleImplementation() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const entry = path.join(ROOT, 'staging', 'sticker-targets-verify-entry.ts');
  fs.writeFileSync(entry,
    "export { decodeProtoDefs, extractKitMessages, resolveKitRecipeWithProvenance } from '../src/protodefs/decoder';\n"
    + "export { buildResolveCtx } from '../src/protodefs/resolve';\n"
    + "export { discoverStickerPlacementTargets } from '../src/editor/stickerTargets';\n"
    + "export { setStickerDestQuad } from '../src/editor/mutations';\n"
    + "export { SnapshotHistory } from '../src/editor/history';\n",
  );
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(process.execPath, [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) throw new Error('Vite could not bundle sticker target implementation.');
  return pathToFileURL(path.join(BUILD_DIR, 'sticker-targets-verify-entry.js')).href;
}

const implementation = await import(bundleImplementation());

const operation = {
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
const definition = {
  header: { defindex: 901, variables: [
    { name: 'sticker_base', value: 'stickers/authored_base', inherit: true },
    { name: 'sticker_weight', value: '2', inherit: true },
    { name: 'sticker_spec', value: 'stickers/authored_spec', inherit: true },
    { name: 'sticker_tl', value: '0 0', inherit: true },
    { name: 'sticker_tr', value: '1 0', inherit: true },
    { name: 'sticker_bl', value: '0 1', inherit: true },
  ] },
  operation_template: { defindex: 701 },
};
const itemDefinition = { header: { defindex: 100, variables: [] }, item_definition_index: 42 };
const slot = { item_definition_template: { defindex: 100 }, data: { variable: [
  { variable: 'sticker_base', string: 'stickers/weapon_base' },
  { variable: 'sticker_weight', string: '7' },
  { variable: 'sticker_spec', string: 'stickers/weapon_spec' },
  { variable: 'sticker_tl', string: '0.2 0.3' },
  { variable: 'sticker_tr', string: '0.8 0.3' },
  { variable: 'sticker_bl', string: '0.2 0.9' },
] } };
definition.blackbox = slot;
definition.scattergun = {
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

function decodedFor(messages) {
  return {
    ctx: implementation.buildResolveCtx([messages.operation], [itemDefinition], []),
    kitsByDefindex: new Map([[901, { def: messages.definition, slots: [
      { item: messages.definition.blackbox, itemDef: itemDefinition, weaponKey: 'blackbox' },
      { item: messages.definition.scattergun, itemDef: itemDefinition, weaponKey: 'scattergun' },
    ] }]]),
  };
}
function resolve(messages, weaponKey = 'blackbox') {
  const result = implementation.resolveKitRecipeWithProvenance(decodedFor(messages), 901, weaponKey, 'red', 0);
  assert.ok(result, 'fixture should resolve through the production decoder');
  return result;
}

const original = structuredClone({ definition, operation });
const targets = implementation.discoverStickerPlacementTargets(original, resolve(original));
assert.equal(targets.length, 2, 'direct nested sticker stages should retain deterministic depth-first occurrences');
const first = targets[0];
assert.equal(first.editable, true);
assert.deepEqual(first.quad, { tl: [0.2, 0.3], tr: [0.8, 0.3], bl: [0.2, 0.9] });
assert.equal(first.stickers[0].base.authoredValue, 'stickers/authored_base');
assert.equal(first.stickers[0].base.resolvedValue, 'stickers/weapon_base');
assert.equal(first.stickers[0].weight.authoredValue, '2');
assert.equal(first.stickers[0].weight.resolvedValue, '7');
assert.equal(first.stickers[0].spec.authoredValue, 'stickers/authored_spec');
assert.equal(first.stickers[0].spec.resolvedValue, 'stickers/weapon_spec');
assert.equal(targets[1].editable, true, 'literal corner fields should be editable too');

const movedQuad = { tl: [0.4, 0.2], tr: [0.9, 0.4], bl: [0.2, 0.8] };
const moved = implementation.setStickerDestQuad(original, first.target, movedQuad);
assert.equal(original.definition.header.variables[3].value, '0 0', 'placement mutation must never mutate its input');
assert.deepEqual(
  moved.definition.header.variables.slice(3).map((entry) => [entry.value, entry.inherit]),
  [['0 0', true], ['1 0', true], ['0 1', true]],
  'a weapon-scoped placement must not rewrite the shared paint-kit defaults',
);
assert.deepEqual(
  moved.definition.blackbox.data.variable.slice(3).map((entry) => entry.string),
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

const history = new implementation.SnapshotHistory();
history.record(original);
const undone = history.undo(moved);
assert.deepEqual(undone, original, 'one placement operation restores all three corners with one undo');
assert.equal(history.canUndo, false);
assert.deepEqual(history.redo(undone), moved, 'redo restores the complete placement snapshot');

const sharedDestination = structuredClone(original);
const stage = sharedDestination.operation.operation_node[0].stage.combine_multiply.operation_node[0].stage.apply_sticker;
stage.dest_tr = { variable: 'sticker_tl' };
const rejected = implementation.discoverStickerPlacementTargets(sharedDestination, resolve(sharedDestination))[0];
assert.equal(rejected.editable, false, 'a shared destination variable is an unsafe affine target');
assert.match(rejected.reason, /share variable/i);

const unresolvedDestination = structuredClone(original);
unresolvedDestination.operation.operation_node[0].stage.combine_multiply.operation_node[0].stage.apply_sticker.dest_bl = { variable: 'missing_destination' };
const unresolved = implementation.discoverStickerPlacementTargets(unresolvedDestination, resolve(unresolvedDestination))[0];
assert.equal(unresolved.editable, false, 'unresolvable destination data must be read-only rather than guessed');
assert.match(unresolved.reason, /unresolved|invalid/i);

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
    builtInIds: manifest.paintkits.map((kit) => kit.id),
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
  const movedArmyQuad = {
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
  armyInfo.def = movedArmy.definition;
  if (activeSlot && namedSlotKey) activeSlot.item = movedArmy.definition[namedSlotKey];
  if (activeSlot && repeatedSlotIndex >= 0) activeSlot.item = movedArmy.definition.item[repeatedSlotIndex];
  decoded.ctx.opByIdx.set(movedArmy.operation.header.defindex, movedArmy.operation);
  const movedArmyResolved = implementation.resolveKitRecipeWithProvenance(decoded, 435, weaponKey, 'red', 0);
  const movedArmyTargets = implementation.discoverStickerPlacementTargets(movedArmy, movedArmyResolved);
  assert.deepEqual(
    movedArmyTargets[editableArmyTarget.occurrence]?.quad,
    movedArmyQuad,
    'Army Guns must re-resolve the authored placement instead of retaining its weapon override',
  );
  console.log(`[verify] shipped Army Guns: ${armyTargets.filter((target) => target.editable).length}/${armyTargets.length} editable stickers`);
}

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
console.log('[verify] sticker targets passed');
