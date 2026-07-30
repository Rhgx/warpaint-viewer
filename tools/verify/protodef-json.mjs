// Parity/smoke check for the JSON-fragment import path.
//
//   node tools/verify/protodef-json.mjs [path/to/fragment/dir]
//
// Community war paints are not distributed as proto_defs containers: they are
// JSON fragments (see src/protodefs/jsonFragments.ts for the tolerant format)
// meant to be layered over public/data/protodefs-base.bin (the stock
// operations/item definitions/variables tools/extract/warpaints.mjs's stepProtodefsBase
// carves out of proto_defs.vpd). This loads every fragment in a directory,
// groups them into packs by filename prefix, and for each pack resolves a
// recipe through src/protodefs/decoder.ts exactly the way the browser would,
// the same vite SSR bundling trick tools/verify/protodefs.mjs uses to run that
// TypeScript in Node.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
const STAGING = path.join(ROOT, 'staging');
const BUILD_DIR = path.join(STAGING, 'protodef-json-verify');
const DEFAULT_DIR = path.join(STAGING, 'examples');

function bundleDecoder() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const entry = path.join(STAGING, 'protodef-json-verify-entry.ts');
  fs.writeFileSync(
    entry,
    "export { decodeProtoDefsFromJson, resolveKitRecipe } from '../src/protodefs/decoder';\n"
    + "export { classifyProtoDefFragment } from '../src/protodefs/jsonFragments';\n",
  );
  // Same rationale as tools/verify/protodefs.mjs: spawn vite's bin through node
  // (not npx, which resolves differently on Windows and inside git worktrees).
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('vite ssr build of the decoder failed');
  return pathToFileURL(path.join(BUILD_DIR, 'protodef-json-verify-entry.js')).href;
}

// Fragment packs are named "<PackName>__<whatever the mod's own tool called
// it>.json" in every real pack seen so far (see staging/examples). Anything
// without that separator is its own single-file group, so a stray file next
// to a real pack cannot silently merge into it.
function packPrefix(fileName) {
  const stem = fileName.replace(/\.json$/i, '');
  const sep = stem.indexOf('__');
  return sep < 0 ? stem : stem.slice(0, sep);
}

const dir = process.argv[2] ?? DEFAULT_DIR;
if (!fs.existsSync(dir)) {
  console.error(`Fragment directory not found: ${dir}\nPass a directory as the first argument.`);
  process.exit(1);
}

console.log('[verify] bundling the browser decoder ...');
const { decodeProtoDefsFromJson, resolveKitRecipe, classifyProtoDefFragment } = await import(bundleDecoder());

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

let failures = 0;

for (const [prefix, fragments] of [...packs].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`\n[verify] pack "${prefix}" (${fragments.map((f) => f.name).join(', ')})`);

  for (const fragment of fragments) {
    const kind = classifyProtoDefFragment(fragment.text);
    console.log(`  ${fragment.name}: classified as ${kind ?? '(unrecognised)'}`);
    if (!kind) { failures += 1; console.error(`  [FAIL] "${fragment.name}" did not classify as either fragment kind.`); }
  }

  let decoded;
  try {
    decoded = decodeProtoDefsFromJson(baseBytes, fragments, { weaponsByItemDef, builtInIds });
  } catch (error) {
    failures += 1;
    console.error(`  [FAIL] decodeProtoDefsFromJson threw: ${error.message}`);
    continue;
  }

  const newKits = decoded.index.kits.filter((kit) => kit.isNew);
  if (newKits.length === 0) {
    failures += 1;
    console.error(`  [FAIL] pack "${prefix}" resolved no new kit at all (kits found: ${decoded.index.kits.length}).`);
    continue;
  }
  if (newKits.length > 1) {
    console.log(`  note: pack resolved ${newKits.length} new kits, reporting the first`);
  }

  const kit = newKits[0];
  console.log(`  kit name="${kit.name}" assigned defindex=${kit.defindex} isNew=${kit.isNew}`);
  console.log(`  weapons resolved: ${kit.weapons.length}${kit.unsupportedItemDefs.length ? ` (${kit.unsupportedItemDefs.length} unsupported item defs skipped)` : ''}`);

  if (kit.weapons.length === 0) {
    failures += 1;
    console.error(`  [FAIL] pack "${prefix}"'s kit has no resolvable weapon, so no recipe can be checked.`);
    continue;
  }

  const weaponKey = kit.weapons[0];
  const recipe = resolveKitRecipe(decoded, kit.defindex, weaponKey, 'red', 0);
  if (!recipe) {
    failures += 1;
    console.error(`  [FAIL] resolveKitRecipe(${kit.defindex}, "${weaponKey}", red, 0) returned null.`);
    continue;
  }

  const refs = [...recipe.textureRefs].sort();
  console.log(`  resolved weapon="${weaponKey}" team=red wear=0, texture refs (${refs.length}):`);
  for (const ref of refs) console.log(`    ${ref}`);

  const expectation = EXPECTED_REF_SUBSTRING.find((e) => e.prefix === prefix);
  if (expectation) {
    const found = refs.some((ref) => ref.toLowerCase().includes(expectation.substring.toLowerCase()));
    if (!found) {
      failures += 1;
      console.error(`  [FAIL] expected a texture ref containing "${expectation.substring}" for pack "${prefix}", found none.`);
    }
  }
}

console.log(failures === 0
  ? `\n[verify] PASS: all ${packs.size} pack(s) resolved.`
  : `\n[verify] FAIL: ${failures} problem(s) across ${packs.size} pack(s).`);
process.exit(failures === 0 ? 0 : 1);
