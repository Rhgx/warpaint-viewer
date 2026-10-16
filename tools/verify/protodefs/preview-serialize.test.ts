// The compact preview fragments must decode to the same recipes as the strict export fragments.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { serializeProtoDefKitBundle, serializeProtoDefKitBundlePreview } from '../../../src/editor/export/jsonExport';
import { decodeProtoDefsFromJson, resolveKitRecipe, type DecodedContainer } from '../../../src/protodefs/decoder';
import { shippedProtoDefs } from '../fixtures';

const { weaponsByItemDef, options, baseBytes, bundleOf } = shippedProtoDefs();

const WEARS = 5;

// Every weapon, team and wear the kit can show: the recipes a preview must reproduce.
function recipesOf(decoded: DecodedContainer, defindex: number): unknown[] {
  const weapons = decoded.index.kits.find((kit) => kit.defindex === defindex)?.weapons ?? [];
  assert.ok(weapons.length > 0, `kit ${defindex} should list weapons`);
  const recipes: unknown[] = [];
  for (const weaponKey of weapons) {
    for (const team of ['red', 'blu'] as const) {
      for (let wear = 0; wear < WEARS; wear += 1) {
        recipes.push(resolveKitRecipe(decoded, defindex, weaponKey, team, wear));
      }
    }
  }
  return recipes;
}

for (const defindex of [80, 109]) {
  test(`compact preview fragments decode to the same recipes as strict fragments for kit ${defindex}`, () => {
    const bundle = bundleOf(defindex);
    const strict = decodeProtoDefsFromJson(baseBytes, serializeProtoDefKitBundle(bundle).fragments, options);
    const preview = decodeProtoDefsFromJson(baseBytes, serializeProtoDefKitBundlePreview(bundle).fragments, options);
    const expected = recipesOf(strict, defindex);
    assert.ok(expected.some((recipe) => recipe !== null), 'at least one recipe should resolve');
    assert.deepStrictEqual(recipesOf(preview, defindex), expected);
  });
}

test('skipping the team check leaves the preview recipes unchanged for a 45-slot paint', () => {
  // Kit 105 has 45 slots and no has_team_textures flag, so the team check runs for it.
  const fragments = serializeProtoDefKitBundlePreview(bundleOf(105)).fragments;
  // With no built-in ids every kit is new, which is when the team check runs.
  const withCheck = decodeProtoDefsFromJson(baseBytes, fragments, { weaponsByItemDef, builtInIds: [] });
  const withoutCheck = decodeProtoDefsFromJson(baseBytes, fragments, { weaponsByItemDef, builtInIds: [], computeTeamFlags: false });
  assert.deepStrictEqual(recipesOf(withoutCheck, 105), recipesOf(withCheck, 105));
  assert.ok(withoutCheck.index.kits.some((kit) => kit.defindex === 105), 'kit 105 should still be indexed');
});
