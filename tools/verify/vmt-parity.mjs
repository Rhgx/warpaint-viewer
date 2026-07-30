// Stock parity check for the browser's VMT reader.
//
//   node tools/verify/vmt-parity.mjs
//
// src/source/vmt.ts re-implements, for imported Source packages, the VMT ->
// material mapping tools/extract/warpaints.mjs performs at build time. The two have to
// agree, so this replays every VMT the pipeline staged (staging/vmt, written
// by resolveWeaponMaterials) through the browser parser and diffs the result
// against what the pipeline actually baked into public/data/manifest.json.
//
// Runs the TypeScript through a vite SSR bundle, the same trick
// tools/verify/protodefs.mjs uses.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
const STAGING = path.join(ROOT, 'staging');
const VMT_DIR = path.join(STAGING, 'vmt');
const BUILD_DIR = path.join(STAGING, 'vmt-verify');

function bundleParser() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const entry = path.join(STAGING, 'vmt-verify-entry.ts');
  fs.writeFileSync(
    entry,
    "export { parseWeaponMaterialVmt } from '../src/source/vmt';\n",
  );
  // Spawn vite's bin through node rather than npx, which resolves differently
  // on Windows and inside git worktrees.
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('vite ssr build of the VMT parser failed');
  return pathToFileURL(path.join(BUILD_DIR, 'vmt-verify-entry.js')).href;
}

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

console.log('[verify] bundling the browser VMT parser ...');
const { parseWeaponMaterialVmt } = await import(bundleParser());

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
if (!checked) console.log('[verify] no staged VMTs found; run tools/extract/warpaints.mjs to populate staging/vmt');

process.exit(mismatched ? 1 : 0);
