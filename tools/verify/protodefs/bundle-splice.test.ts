import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseProtoDefGroups,
  spliceProtoDefBundle,
  spliceProtoDefs,
  usedDefindexes,
} from '../../../src/export/protoWrite';
import { decodeProtoDefs, resolveKitRecipe } from '../../../src/protodefs/decoder';
import { shippedProtoDefs } from '../fixtures';

// Highest stock defindexes in the shipped snapshot; appended ids must sit above them.
const STOCK_MAX_OPERATION = 931;
const STOCK_MAX_ITEM_DEFINITION = 209;
const STOCK_MAX_PAINTKIT = 442;

const { fullBytes: BASE, options: OPTIONS, full, bundleOf } = shippedProtoDefs();

function defindexOf(defType: number, payload: Uint8Array): number | undefined {
  return [...usedDefindexes([{ defType, payloads: [payload] }], defType)][0];
}

for (const sourceDefindex of [85, 80]) {
  test(`appending per-wear kit ${sourceDefindex} reproduces every recipe under fresh ids`, () => {
    const bundle = bundleOf(sourceDefindex);
    const appended = spliceProtoDefBundle({ baseBytes: BASE, bundle, mode: 'append' });

    assert.ok(appended.operationDefindexes.every((defindex) => defindex > STOCK_MAX_OPERATION), `operations: ${appended.operationDefindexes}`);
    assert.ok(appended.itemDefinitionDefindexes.every((defindex) => defindex > STOCK_MAX_ITEM_DEFINITION), `item definitions: ${appended.itemDefinitionDefindexes}`);
    assert.ok(appended.paintkitDefindex > STOCK_MAX_PAINTKIT, `paint kit: ${appended.paintkitDefindex}`);

    const decoded = decodeProtoDefs(appended.bytes, OPTIONS);
    assert.equal(decoded.index.kits.length, full.index.kits.length + 1);
    for (const scope of bundle.scopes) {
      const expected = resolveKitRecipe(full, sourceDefindex, scope.weaponKey, 'red', scope.wear);
      const actual = resolveKitRecipe(decoded, appended.paintkitDefindex, scope.weaponKey, 'red', scope.wear);
      assert.deepStrictEqual(actual, expected, `${scope.weaponKey} wear ${scope.wear} differs after append`);
    }
  }, 120000);
}

test('overwriting kit 85 with its own bundle keeps every recipe and leaves other blocks byte for byte', () => {
  const bundle = bundleOf(85);
  const overwritten = spliceProtoDefBundle({ baseBytes: BASE, bundle, mode: 'overwrite', targetDefindex: 85 });
  assert.ok(overwritten.replaced && overwritten.paintkitDefindex === 85, 'overwrite reports the kit it replaced');

  const decoded = decodeProtoDefs(overwritten.bytes, OPTIONS);
  assert.equal(decoded.index.kits.length, full.index.kits.length, 'overwrite does not change the kit count');
  for (const scope of bundle.scopes) {
    const expected = resolveKitRecipe(full, 85, scope.weaponKey, 'red', scope.wear);
    const actual = resolveKitRecipe(decoded, 85, scope.weaponKey, 'red', scope.wear);
    assert.deepStrictEqual(actual, expected, `${scope.weaponKey} wear ${scope.wear} differs after overwrite`);
  }

  const before = parseProtoDefGroups(BASE);
  const after = parseProtoDefGroups(overwritten.bytes);
  assert.equal(after.length, before.length);
  const targetIds = new Map<number, Set<number>>([
    [7, new Set(overwritten.operationDefindexes)],
    [8, new Set(overwritten.itemDefinitionDefindexes)],
    [9, new Set([85])],
  ]);
  before.forEach((group, groupIndex) => {
    const counterpart = after[groupIndex];
    assert.equal(counterpart.defType, group.defType);
    assert.equal(counterpart.payloads.length, group.payloads.length, `block ${group.defType} keeps its length`);
    const ids = targetIds.get(group.defType) ?? new Set<number>();
    let replaced = 0;
    group.payloads.forEach((payload, index) => {
      const defindex = ids.size > 0 ? defindexOf(group.defType, payload) : undefined;
      if (defindex !== undefined && ids.has(defindex)) {
        replaced += 1;
        return;
      }
      assert.equal(
        Buffer.compare(Buffer.from(counterpart.payloads[index]), Buffer.from(payload)),
        0,
        `block ${group.defType} entry ${index} changed outside the target`,
      );
    });
    assert.equal(replaced, ids.size, `block ${group.defType} replaces exactly the target's ${ids.size} entries`);
  });
});

test('overwriting kit 85 with the Warhawk bundle is refused', () => {
  assert.throws(
    () => spliceProtoDefBundle({ baseBytes: BASE, bundle: bundleOf(80), mode: 'overwrite', targetDefindex: 85 }),
    /weapon slots do not match/,
  );
});

test('a top-level paint through spliceProtoDefBundle matches spliceProtoDefs byte for byte', () => {
  const bundle = bundleOf(109);
  const viaBundle = spliceProtoDefBundle({ baseBytes: BASE, bundle, mode: 'append' });
  const direct = spliceProtoDefs({
    baseBytes: BASE,
    operation: bundle.operations[0],
    definition: bundle.definition,
    mode: 'append',
  });
  assert.equal(Buffer.compare(Buffer.from(viaBundle.bytes), Buffer.from(direct.bytes)), 0);
}, 120000);
