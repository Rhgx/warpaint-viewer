// Parity/smoke check for the browser's VMT reader.
//
//   node tools/verify-vmt.mjs [path/to/a/pack/of/vmts]
//
// src/source/vmt.ts re-implements, for imported Source packages, the VMT ->
// material mapping tools/extract.mjs performs at build time. The two have to
// agree, so this replays every VMT the pipeline staged (staging/vmt, written
// by resolveWeaponMaterials) through the browser parser and diffs the result
// against what the pipeline actually baked into public/data/manifest.json.
//
// It then smoke-tests a real community pack: pass a .zip and it is opened
// through src/source/zip.ts and queried for every weapon in the manifest, the
// way a mounted package is; pass a directory and every loose .vmt under it is
// parsed on its own. Community packs are where the interesting parameters are,
// since no stock weapon material uses them.
//
// Runs the TypeScript through a vite SSR bundle, the same trick
// tools/verify-protodefs.mjs uses.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
const STAGING = path.join(ROOT, 'staging');
const VMT_DIR = path.join(STAGING, 'vmt');
const BUILD_DIR = path.join(STAGING, 'vmt-verify');
const DEFAULT_PACK_DIR = path.join(STAGING, 'examples');

function bundleParser() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const entry = path.join(STAGING, 'vmt-verify-entry.ts');
  fs.writeFileSync(
    entry,
    "export { parseWeaponMaterialVmt, readPackageWeaponMaterial } from '../src/source/vmt';\n"
    + "export { openZipSourcePackage } from '../src/source/zip';\n",
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

function describe(parsed) {
  const { material } = parsed;
  return [
    material.phong ? `phong exp ${material.phongExponent ?? '-'} boost ${material.phongBoost}` : 'no phong',
    material.rimLight ? `rim ${material.rimLightExponent}/${material.rimLightBoost}` : null,
    material.halfLambert ? 'half-lambert' : null,
    material.alphaTest ? `alpha test ${material.alphaTestReference}` : null,
    material.emissiveBlend ? `emissive x${material.emissiveBlendStrength} ${material.emissiveBlendBaseTexture}` : null,
    material.selfIllum ? 'self-illum' : null,
  ].filter(Boolean).join(', ');
}

console.log('[verify] bundling the browser VMT parser ...');
const { parseWeaponMaterialVmt, readPackageWeaponMaterial, openZipSourcePackage } = await import(bundleParser());

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
if (!checked) console.log('[verify] no staged VMTs found; run tools/extract.mjs to populate staging/vmt');

const packPath = process.argv[2] ?? DEFAULT_PACK_DIR;
if (packPath.toLowerCase().endsWith('.zip')) {
  // The whole mount path, not just the parser: index the archive, then ask it
  // for each weapon's material exactly as SourceTextureProvider does.
  const bytes = fs.readFileSync(packPath);
  const file = new File([bytes], path.basename(packPath));
  const { package: pkg, diagnostics } = await openZipSourcePackage(file);
  console.log(`\n[verify] mounted ${pkg.name}: ${pkg.entries.size} entries, rootIsMaterials=${pkg.rootIsMaterials}`);
  for (const diagnostic of diagnostics) console.log(`    [${diagnostic.level}] ${diagnostic.message}`);

  let found = 0;
  for (const weapon of manifest.weapons) {
    const overrideId = manifest.paintkits.find((kit) => kit.materialOverrides?.[weapon.key])?.materialOverrides?.[weapon.key];
    const lookup = await readPackageWeaponMaterial(pkg, weapon.key, overrideId);
    if (lookup.status === 'none') continue;
    if (lookup.status !== 'found') {
      console.log(`  ${weapon.key}: ${lookup.status} ${JSON.stringify(lookup)}`);
      continue;
    }
    found += 1;
    const { material } = lookup;
    console.log(`  ${weapon.key} <- ${material.path}${material.nameMatched ? ' (by name)' : ''}`);
    console.log(`    ${describe(material)}`);
    if (material.missingTextures.length) console.log(`    not in this package: ${material.missingTextures.join(', ')}`);
    if (material.unsupported.length) console.log(`    not reproduced: ${material.unsupported.join(', ')}`);
  }
  console.log(`[verify] ${found} of ${manifest.weapons.length} weapons take their material from this package`);
  pkg.dispose();
} else {
  const packVmts = walk(packPath, '.vmt');
  console.log(`\n[verify] parsing ${packVmts.length} loose material${packVmts.length === 1 ? '' : 's'} under ${packPath}`);
  for (const full of packVmts) {
    const parsed = parseWeaponMaterialVmt(fs.readFileSync(full, 'utf8'));
    console.log(`  ${path.relative(packPath, full).replace(/\\/g, '/')}  [${parsed.shader}]`);
    console.log(`    ${describe(parsed)}`);
    console.log(`    textures: ${parsed.textureRefs.length ? parsed.textureRefs.join(', ') : 'none'}`);
    if (parsed.unsupported.length) console.log(`    not reproduced: ${parsed.unsupported.join(', ')}`);
  }
}

process.exit(mismatched ? 1 : 0);
