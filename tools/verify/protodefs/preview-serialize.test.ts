// The compact preview fragments must decode to the same recipes as the strict export fragments.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import type { Manifest } from '../../../src/data/types';
import { serializeProtoDefKitBundle, serializeProtoDefKitBundlePreview } from '../../../src/editor/export/jsonExport';
import {
  decodeProtoDefs,
  decodeProtoDefsFromJson,
  extractKitBundle,
  resolveKitRecipe,
  type DecodedContainer,
} from '../../../src/protodefs/decoder';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const weaponsByItemDef: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
const builtInIds = manifest.paintkits.map((kit) => kit.id);
const options = { weaponsByItemDef, builtInIds };
const baseBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-base.bin')));
const full = decodeProtoDefs(new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-full.bin'))), options);

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
    const bundle = extractKitBundle(full, defindex);
    assert.ok(bundle, `kit ${defindex} should produce a bundle`);
    const strict = decodeProtoDefsFromJson(baseBytes, serializeProtoDefKitBundle(bundle).fragments, options);
    const preview = decodeProtoDefsFromJson(baseBytes, serializeProtoDefKitBundlePreview(bundle).fragments, options);
    const expected = recipesOf(strict, defindex);
    assert.ok(expected.some((recipe) => recipe !== null), 'at least one recipe should resolve');
    assert.deepStrictEqual(recipesOf(preview, defindex), expected);
  });
}

test('skipping the team check leaves the preview recipes unchanged for a 45-slot paint', () => {
  // Kit 105 has 45 slots and no has_team_textures flag, so the team check runs for it.
  const bundle = extractKitBundle(full, 105);
  assert.ok(bundle, 'kit 105 should produce a bundle');
  const fragments = serializeProtoDefKitBundlePreview(bundle).fragments;
  // With no built-in ids every kit is new, which is when the team check runs.
  const withCheck = decodeProtoDefsFromJson(baseBytes, fragments, { weaponsByItemDef, builtInIds: [] });
  const withoutCheck = decodeProtoDefsFromJson(baseBytes, fragments, { weaponsByItemDef, builtInIds: [], computeTeamFlags: false });
  assert.deepStrictEqual(recipesOf(withoutCheck, 105), recipesOf(withCheck, 105));
  assert.ok(withoutCheck.index.kits.some((kit) => kit.defindex === 105), 'kit 105 should still be indexed');
});
