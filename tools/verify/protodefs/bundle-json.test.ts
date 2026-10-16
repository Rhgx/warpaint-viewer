import assert from 'node:assert/strict';
import { test } from 'vitest';
import { serializeProtoDefKitBundle, serializeProtoDefKitMessages } from '../../../src/editor/export/jsonExport';
import { decodeProtoDefsFromJson, extractKitMessages, resolveKitRecipe } from '../../../src/protodefs/decoder';
import { classifyProtoDefFragment, type ProtoDefFragmentKind } from '../../../src/protodefs/jsonFragments';
import { shippedProtoDefs } from '../fixtures';

const { options, baseBytes, full, bundleOf } = shippedProtoDefs();

function countKinds(kinds: (ProtoDefFragmentKind | null)[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of kinds) counts[String(kind)] = (counts[String(kind)] ?? 0) + 1;
  return counts;
}

for (const [defindex, expectedCounts] of [
  [85, { operation: 5, itemDefinition: 1, definition: 1 }],
  [80, { operation: 15, itemDefinition: 3, definition: 1 }],
] as const) {
  test(`per-wear kit ${defindex} serializes to fragments that re-decode like the full container`, () => {
    const bundle = bundleOf(defindex);
    const original = structuredClone(bundle);
    const { fragments } = serializeProtoDefKitBundle(bundle, { name: 'Per Wear' });
    assert.deepStrictEqual(bundle, original, 'serialization must not mutate the source bundle');

    const names = fragments.map((fragment) => fragment.name);
    assert.equal(new Set(names).size, names.length, 'fragment names must be unique');
    assert.deepStrictEqual(countKinds(fragments.map((fragment) => classifyProtoDefFragment(fragment.text))), expectedCounts);

    const rebuilt = decodeProtoDefsFromJson(baseBytes, fragments, options);
    assert.ok(rebuilt.index.kits.some((kit) => kit.defindex === defindex), `kit ${defindex} should be in the rebuilt index`);
    assert.ok(bundle.scopes.length > 0);
    for (const scope of bundle.scopes) {
      const expected = resolveKitRecipe(full, defindex, scope.weaponKey, 'red', scope.wear);
      assert.ok(expected, `${scope.weaponKey} wear ${scope.wear} should resolve in the full container`);
      const actual = resolveKitRecipe(rebuilt, defindex, scope.weaponKey, 'red', scope.wear);
      assert.deepStrictEqual(actual, expected, `${scope.weaponKey} wear ${scope.wear} differs after the JSON round trip`);
    }
  });
}

test('a top-level paint bundle serializes byte-identically to serializeProtoDefKitMessages', () => {
  const messages = extractKitMessages(full, 109);
  assert.ok(messages, 'kit 109 should have a top-level operation');
  const single = serializeProtoDefKitMessages(messages, { name: 'Top Level' });
  const bundled = serializeProtoDefKitBundle(bundleOf(109), { name: 'Top Level' });
  assert.deepStrictEqual(bundled.fragments, [single.operation, single.definition]);
});
