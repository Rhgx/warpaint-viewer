// Exhaustive Edit compatibility matrix for every local example war paint.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const EXAMPLES = path.join(ROOT, '.tmp', 'example-warpaints');
const BUILD_DIR = path.join(ROOT, 'staging', 'example-warpaints-verify');

function bundleImplementation() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const entry = path.join(ROOT, 'staging', 'example-warpaints-verify-entry.ts');
  fs.writeFileSync(entry,
    "export { decodeProtoDefsFromJson, extractKitMessages, resolveKitRecipeWithProvenance } from '../src/protodefs/decoder';\n"
    + "export { discoverGroupSelectTargets } from '../src/editor/groupTargets';\n"
    + "export { discoverStickerPlacementTargets } from '../src/editor/stickerTargets';\n",
  );
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) throw new Error('Vite could not bundle the example compatibility verifier.');
  return pathToFileURL(path.join(BUILD_DIR, 'example-warpaints-verify-entry.js')).href;
}

async function fragmentsFromZip(filePath) {
  const reader = new ZipReader(new BlobReader(new Blob([fs.readFileSync(filePath)])));
  try {
    const entries = await reader.getEntries();
    return Promise.all(entries
      .filter((entry) => !entry.directory && entry.filename.toLowerCase().endsWith('.json'))
      .map(async (entry) => ({ name: entry.filename, text: await entry.getData(new TextWriter()) })));
  } finally {
    await reader.close();
  }
}

const archives = fs.existsSync(EXAMPLES)
  ? fs.readdirSync(EXAMPLES).filter((name) => name.toLowerCase().endsWith('.zip')).sort()
  : [];
if (archives.length === 0) {
  console.log('[verify] no local example war paints found; skipping compatibility matrix');
  process.exit(0);
}

const implementation = await import(bundleImplementation());
const baseBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public', 'data', 'protodefs-base.bin')));
const itemDefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'item-defs.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'manifest.json'), 'utf8'));
const failures = [];
let weaponCount = 0;
let recipeCount = 0;
let groupTargetCount = 0;
let stickerTargetCount = 0;
let viewOnlyWeaponCount = 0;
const viewOnlyByArchive = new Map();

for (const archive of archives) {
  const fragments = await fragmentsFromZip(path.join(EXAMPLES, archive));
  let decoded;
  try {
    decoded = implementation.decodeProtoDefsFromJson(baseBytes, fragments, {
      weaponsByItemDef: itemDefs,
      builtInIds: manifest.paintkits.map((kit) => kit.id),
    });
  } catch (cause) {
    failures.push(`${archive}: definitions could not be imported (${cause instanceof Error ? cause.message : cause})`);
    continue;
  }
  for (const kit of decoded.index.kits) {
    const kitInfo = decoded.kitsByDefindex.get(kit.defindex);
    const messages = implementation.extractKitMessages(decoded, kit.defindex);
    if (!kitInfo || !messages) {
      failures.push(`${archive}: paint ${kit.defindex} could not expose its editable messages`);
      continue;
    }
    const weaponKeys = [...new Set(kitInfo.slots.map((slot) => slot.weaponKey))].sort();
    for (const weaponKey of weaponKeys) {
      weaponCount += 1;
      let weaponHasEditableSurface = false;
      for (const team of ['red', 'blu']) {
        for (let wearIndex = 0; wearIndex < 5; wearIndex += 1) {
          const label = `${archive} / ${weaponKey} / ${team} / wear ${wearIndex}`;
          const resolved = implementation.resolveKitRecipeWithProvenance(
            decoded,
            kit.defindex,
            weaponKey,
            team,
            wearIndex,
          );
          if (!resolved) {
            failures.push(`${label}: recipe did not resolve`);
            continue;
          }
          recipeCount += 1;
          const groups = implementation.discoverGroupSelectTargets(messages, resolved.provenance);
          const stickers = implementation.discoverStickerPlacementTargets(messages, resolved);
          groupTargetCount += groups.targets.length;
          stickerTargetCount += stickers.length;
          if (groups.targets.length > 0) {
            if (groups.targets.some((target) => target.canToggle)) weaponHasEditableSurface = true;
          }
          if (stickers.length > 0) {
            if (stickers.some((target) => target.editable)) weaponHasEditableSurface = true;
          }
        }
      }
      if (!weaponHasEditableSurface) {
        viewOnlyWeaponCount += 1;
        viewOnlyByArchive.set(archive, (viewOnlyByArchive.get(archive) ?? 0) + 1);
      }
    }
  }
}

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
assert.deepEqual(failures, [], `Example compatibility failures:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
console.log(
  `[verify] ${archives.length} example packs, ${weaponCount} weapons, ${recipeCount} team/wear recipes, `
  + `${groupTargetCount} group targets, ${stickerTargetCount} sticker targets passed; `
  + `${viewOnlyWeaponCount} weapons are intentionally view-only`
  + (viewOnlyWeaponCount > 0
    ? ` (${[...viewOnlyByArchive].map(([archive, count]) => `${archive}: ${count}`).join(', ')})`
    : ''),
);
