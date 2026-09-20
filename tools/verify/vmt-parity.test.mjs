import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseWeaponMaterialVmt } from '../../src/source/vmt';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
const STAGING = path.join(ROOT, 'staging');
const VMT_DIR = path.join(STAGING, 'vmt');

function walk(dir, extension) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, extension));
    else if (entry.name.toLowerCase().endsWith(extension)) out.push(full);
  }
  return out;
}

// The pipeline writes only the fields it models; the browser parser adds the
// package-only ones (alpha test, emissive blend) that no stock VMT sets. Diff
// on the pipeline's own field list so an absent-vs-undefined difference in a
// field neither side uses cannot read as a regression.
function pick(material, keys) {
  return Object.fromEntries(keys.map((key) => [key, material[key] ?? null]));
}

test('staged VMTs match extracted materials', (context) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
  const weaponModels = fs.existsSync(path.join(STAGING, 'weapon_models.json'))
    ? JSON.parse(fs.readFileSync(path.join(STAGING, 'weapon_models.json'), 'utf8'))
    : {};

  // staged VMT path -> the material the pipeline derived from it.
  const expected = new Map();
  for (const weapon of manifest.weapons) {
    const model = weaponModels[weapon.key]?.[0];
    if (!model) continue;
    expected.set(`materials/${model.replace(/\\/g, '/').replace(/\.mdl$/i, '.vmt')}`.toLowerCase(), {
      label: weapon.key,
      material: weapon.material,
    });
  }
  for (const [id, material] of Object.entries(manifest.materials ?? {})) {
    expected.set(`materials/${id}.vmt`.toLowerCase(), { label: id, material });
  }

  let checked = 0;
  let mismatched = 0;
  for (const full of walk(VMT_DIR, '.vmt')) {
    const staged = path.relative(VMT_DIR, full).replace(/\\/g, '/').toLowerCase();
    const target = expected.get(staged);
    if (!target) continue;
    checked += 1;
    const keys = Object.keys(target.material);
    const actual = pick(parseWeaponMaterialVmt(fs.readFileSync(full, 'utf8')).material, keys);
    const wanted = pick(target.material, keys);
    if (JSON.stringify(actual) === JSON.stringify(wanted)) continue;
    mismatched += 1;
    console.log(`\n[mismatch] ${target.label}  (${staged})`);
    for (const key of keys) {
      const a = JSON.stringify(actual[key]);
      const b = JSON.stringify(wanted[key]);
      if (a !== b) console.log(`    ${key}: browser ${a} vs pipeline ${b}`);
    }
  }
  console.log(`\n[verify] stock materials: ${checked - mismatched}/${checked} identical to the pipeline`);
  if (!checked) context.skip('No matching staged VMTs');

  assert.equal(mismatched, 0, 'Stock material mismatches');

}, 30000);
