// Opens real community war paint ZIPs through the browser Source package
// layer and reports how each is read.
//
//   node tools/verify-source-packages.mjs [path/to/packs/dir]
//
// src/source/zip.ts and src/source/provider.ts are TypeScript that import
// @zip.js/zip.js and rely on the File/Blob globals; Node 22 provides both, so
// (as in tools/verify-protodefs.mjs) the module is bundled with vite's SSR
// build and then run directly rather than reimplemented here.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = path.join(ROOT, 'staging');
const BUILD_DIR = path.join(STAGING, 'source-packages-verify');
const DEFAULT_PACKS_DIR = 'C:/Users/TR/Downloads/example-warapints';

const PACKS = ['Invisible_V2.zip', 'Skinned Submission.zip', 'FlakFurnished.ZIP', 'ghastly_guns.ZIP'];
const REFS = [
  'patterns/skinned/skin_main',
  'invisible_warpaint/black',
  'patterns/FFV3/logo',
  'patterns/FFV3/tf2logo',
  'patterns/ghostgun/albedo_overlay',
  'patterns/ghostgun/light_green_solid',
];

function bundleModule() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const entry = path.join(STAGING, 'source-packages-verify-entry.ts');
  fs.writeFileSync(entry, [
    "export { openZipSourcePackage } from '../src/source/zip';",
    "export { SourceTextureProvider } from '../src/source/provider';",
    "export { sourceTextureCandidates, sourceTextureIdentity } from '../src/source/paths';",
    "export { collectPackageFiles } from '../src/export/bundle';",
    "export { collectMaterialFiles } from '../src/export/bundle';",
    "export { exportPathFor } from '../src/export/plan';",
    '',
  ].join('\n'));
  // Spawn vite's bin through node rather than npx: npx resolves differently on
  // Windows and this script also runs from git worktrees, where node_modules is
  // found by walking up rather than sitting alongside.
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('vite ssr build of the Source package layer failed');
  return pathToFileURL(path.join(BUILD_DIR, 'source-packages-verify-entry.js')).href;
}

console.log('[verify] bundling the browser Source package layer ...');
const {
  collectPackageFiles,
  collectMaterialFiles,
  exportPathFor,
  openZipSourcePackage,
  SourceTextureProvider,
  sourceTextureCandidates,
  sourceTextureIdentity,
} = await import(bundleModule());

const packsDir = process.argv[2] ?? DEFAULT_PACKS_DIR;
let ok = true;

for (const fileName of PACKS) {
  const fullPath = path.join(packsDir, fileName);
  console.log(`\n=== ${fileName} ===`);
  if (!fs.existsSync(fullPath)) {
    console.error(`[verify] not found: ${fullPath}`);
    ok = false;
    continue;
  }

  const buffer = fs.readFileSync(fullPath);
  const nativeFile = new File([buffer], fileName);

  let opened;
  try {
    opened = await openZipSourcePackage(nativeFile);
  } catch (error) {
    console.error(`[verify] failed to open: ${error?.message ?? error}`);
    ok = false;
    continue;
  }

  const { package: pkg, diagnostics, suggestedPaintkitId } = opened;
  const wrapperDiagnostic = diagnostics.find((diagnostic) => diagnostic.id === 'zip-wrapper-root');
  const rootIsMaterialsDiagnostic = diagnostics.find((diagnostic) => diagnostic.id === 'zip-root-is-materials');

  console.log(`wrapper prefix: ${wrapperDiagnostic ? wrapperDiagnostic.detail : '(none)'}`);
  console.log(`rootIsMaterials: ${pkg.rootIsMaterials}`);
  console.log(`indexed entries: ${pkg.entries.size}`);
  console.log(`suggested paintkit id: ${suggestedPaintkitId ?? '(none)'}`);
  if (rootIsMaterialsDiagnostic) console.log(`note: ${rootIsMaterialsDiagnostic.message}`);
  for (const diagnostic of diagnostics) {
    if (diagnostic.id === 'zip-wrapper-root' || diagnostic.id === 'zip-root-is-materials') continue;
    console.log(`diagnostic[${diagnostic.level}] ${diagnostic.id}: ${diagnostic.message}${diagnostic.detail ? ` (${diagnostic.detail})` : ''}`);
  }

  // Drive resolution through the real provider (Task 3's exact-then-name-match
  // path), not a reimplementation, so a decode failure under Node (VTF
  // decoding needs a Worker, which is not exercised here) cannot mask a wrong
  // resolution: the provider records the resolution kind before it ever tries
  // to decode pixels.
  const provider = new SourceTextureProvider((ref) => `builtin:${ref}`);
  provider.mount(pkg, diagnostics);
  console.log('refs:');
  for (const ref of REFS) {
    let identity;
    let candidates;
    try {
      identity = sourceTextureIdentity(ref);
      candidates = sourceTextureCandidates(ref);
    } catch {
      console.log(`  ${ref}: invalid ref`);
      continue;
    }
    const exactPath = candidates.find((candidate) => pkg.has(candidate));
    await provider.resolve(ref);
    const snapshot = provider.snapshot();
    let outcome;
    if (exactPath) outcome = `exact hit -> ${exactPath}`;
    else if (snapshot.nameMatchedPaths.has(identity)) outcome = `name-matched -> ${snapshot.nameMatchedPaths.get(identity)}`;
    else if (snapshot.ambiguousNameMatches.has(identity)) outcome = 'ambiguous (left unmatched)';
    else outcome = 'unmatched (built-in fallback)';
    console.log(`  ${ref}: ${outcome}`);

    const packagePath = provider.packagePathFor(ref);
    if (packagePath) {
      const writeAs = exportPathFor(ref);
      const copied = await collectPackageFiles(
        [{ path: packagePath, writeAs }],
        (entryPath) => pkg.read(entryPath),
        new Set(),
      );
      if (copied.length !== 1 || copied[0].path !== writeAs) {
        console.error(`  [FAIL] export mapped ${packagePath} to ${copied[0]?.path ?? '(nothing)'}, expected ${writeAs}`);
        ok = false;
      } else {
        console.log(`    export -> ${copied[0].path}`);
      }
    }
  }

  if (fileName.toLowerCase() === 'ghastly_guns.zip') {
    const requested = 'models/paintkits/ghost/c_shotgun';
    const materialPath = `materials/${requested}.vmt`;
    const materialFiles = await collectMaterialFiles(
      [requested],
      (entryPath) => provider.packagePathForFile(entryPath),
      (entryPath) => pkg.read(entryPath),
    );
    if (!materialFiles.files.some((file) => file.path === materialPath)) {
      console.error(`  [FAIL] loose c_shotgun.vmt was not exported as ${materialPath}`);
      ok = false;
    } else {
      console.log(`  material export -> ${materialPath}`);
    }
  }
  provider.dispose();
}

console.log(ok ? '\n[verify] PASS: every pack opened.' : '\n[verify] FAIL: at least one pack could not be opened.');
process.exit(ok ? 0 : 1);
