import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeProtoDefsFromJson, resolveKitRecipe } from '../../src/protodefs/decoder';
import { classifyProtoDefFragment } from '../../src/protodefs/jsonFragments';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
const STAGING = path.join(ROOT, 'staging');
const DEFAULT_DIR = path.join(STAGING, 'examples');

// Fragment packs are named "<PackName>__<whatever the mod's own tool called
// it>.json" in every real pack seen so far (see staging/examples). Anything
// without that separator is its own single-file group, so a stray file next
// to a real pack cannot silently merge into it.
function packPrefix(fileName) {
  const stem = fileName.replace(/\.json$/i, '');
  const sep = stem.indexOf('__');
  return sep < 0 ? stem : stem.slice(0, sep);
}

test('community fragment packs resolve', (context) => {
  const dir = process.env.TF2_FRAGMENT_DIR ?? DEFAULT_DIR;
  if (!fs.existsSync(dir)) {
    assert.ok(!process.env.TF2_FRAGMENT_DIR, `Missing fragment directory: ${dir}`);
    context.skip('No community fragment fixtures');
    return;
  }

  const baseBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-base.bin')));
  const weaponsByItemDef = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
  const builtInIds = manifest.paintkits.map((kit) => kit.id);

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const packs = new Map(); // prefix -> [{ name, text }]
  for (const file of files) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const prefix = packPrefix(file);
    const list = packs.get(prefix) ?? [];
    list.push({ name: file, text });
    packs.set(prefix, list);
  }

  console.log(`[verify] found ${files.length} fragment(s) across ${packs.size} pack(s) in ${dir}`);

  // A pack's own report can call out an expected texture ref as a sanity check
  // beyond "it resolved something": these three are the packs this script ships
  // with (staging/examples), matched case-insensitively since a mod's own VTF
  // casing (e.g. "FFV3") does not have to match how this comment writes it.
  const EXPECTED_REF_SUBSTRING = [
    { prefix: 'Skinned Submission', substring: 'patterns/skinned/skin_main' },
    { prefix: 'Invisible_V2', substring: 'invisible_warpaint/black' },
    { prefix: 'FlakFurnished', substring: 'patterns/ffv3/logo' },
  ];

  for (const [prefix, fragments] of [...packs].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`\n[verify] pack "${prefix}" (${fragments.map((f) => f.name).join(', ')})`);

    for (const fragment of fragments) {
      const kind = classifyProtoDefFragment(fragment.text);
      console.log(`  ${fragment.name}: classified as ${kind ?? '(unrecognised)'}`);
      assert.ok(kind, `Unrecognised fragment: ${fragment.name}`);
    }

    const decoded = decodeProtoDefsFromJson(baseBytes, fragments, { weaponsByItemDef, builtInIds });

    const newKits = decoded.index.kits.filter((kit) => kit.isNew);
    assert.ok(newKits.length > 0, `No new kit resolved for ${prefix}`);
    if (newKits.length > 1) {
      console.log(`  note: pack resolved ${newKits.length} new kits, reporting the first`);
    }

    const kit = newKits[0];
    console.log(`  kit name="${kit.name}" assigned defindex=${kit.defindex} isNew=${kit.isNew}`);
    console.log(`  weapons resolved: ${kit.weapons.length}${kit.unsupportedItemDefs.length ? ` (${kit.unsupportedItemDefs.length} unsupported item defs skipped)` : ''}`);

    assert.ok(kit.weapons.length > 0, `No supported weapons in ${prefix}`);

    const weaponKey = kit.weapons[0];
    const recipe = resolveKitRecipe(decoded, kit.defindex, weaponKey, 'red', 0);
    assert.ok(recipe, `No recipe resolved for ${prefix}/${weaponKey}`);

    const refs = [...recipe.textureRefs].sort();
    console.log(`  resolved weapon="${weaponKey}" team=red wear=0, texture refs (${refs.length}):`);
    for (const ref of refs) console.log(`    ${ref}`);

    const expectation = EXPECTED_REF_SUBSTRING.find((e) => e.prefix === prefix);
    if (expectation) {
      const found = refs.some((ref) => ref.toLowerCase().includes(expectation.substring.toLowerCase()));
      assert.ok(found, `Missing expected texture reference for ${prefix}`);
    }
  }

}, 30000);
