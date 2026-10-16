import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { decodeProtoDefsFromJson, resolveKitRecipe } from '../../../src/protodefs/decoder';
import { classifyProtoDefFragment } from '../../../src/protodefs/jsonFragments';
import { ROOT, shippedProtoDefs } from '../fixtures';

const DEFAULT_DIR = path.join(ROOT, 'staging', 'examples');

// Fragment packs are named "<PackName>__<tool-specific name>.json". A file without
// that separator is its own group, so a stray file cannot merge into a real pack.
function packPrefix(fileName) {
  const stem = fileName.replace(/\.json$/i, '');
  const sep = stem.indexOf('__');
  return sep < 0 ? stem : stem.slice(0, sep);
}

// A texture each shipped example pack must resolve, matched case-insensitively.
const EXPECTED_REF_SUBSTRING = [
  { prefix: 'Skinned Submission', substring: 'patterns/skinned/skin_main' },
  { prefix: 'Invisible_V2', substring: 'invisible_warpaint/black' },
  { prefix: 'FlakFurnished', substring: 'patterns/ffv3/logo' },
];

test('community fragment packs resolve', (context) => {
  const dir = process.env.TF2_FRAGMENT_DIR ?? DEFAULT_DIR;
  if (!fs.existsSync(dir)) {
    assert.ok(!process.env.TF2_FRAGMENT_DIR, `Missing fragment directory: ${dir}`);
    context.skip('No community fragment fixtures');
    return;
  }
  const { options, baseBytes } = shippedProtoDefs();

  const packs = new Map();
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const prefix = packPrefix(file);
    packs.set(prefix, [...(packs.get(prefix) ?? []), { name: file, text: fs.readFileSync(path.join(dir, file), 'utf8') }]);
  }

  for (const [prefix, fragments] of packs) {
    for (const fragment of fragments) {
      assert.ok(classifyProtoDefFragment(fragment.text), `Unrecognised fragment: ${fragment.name}`);
    }

    const decoded = decodeProtoDefsFromJson(baseBytes, fragments, options);
    const kit = decoded.index.kits.find((entry) => entry.isNew);
    assert.ok(kit, `No new kit resolved for ${prefix}`);
    assert.ok(kit.weapons.length > 0, `No supported weapons in ${prefix}`);

    const weaponKey = kit.weapons[0];
    const recipe = resolveKitRecipe(decoded, kit.defindex, weaponKey, 'red', 0);
    assert.ok(recipe, `No recipe resolved for ${prefix}/${weaponKey}`);

    const expectation = EXPECTED_REF_SUBSTRING.find((e) => e.prefix === prefix);
    if (expectation) {
      const found = recipe.textureRefs.some((ref) => ref.toLowerCase().includes(expectation.substring.toLowerCase()));
      assert.ok(found, `Missing expected texture reference for ${prefix}`);
    }
  }
}, 30000);
