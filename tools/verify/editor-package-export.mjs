// Verifies that editor export produces one re-importable ZIP, preserves source
// files, and replaces the selected kit's JSON fragments in place.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'editor-package-export-verify');

function bundleImplementation() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const entry = path.join(ROOT, 'staging', 'editor-package-export-verify-entry.ts');
  fs.writeFileSync(entry,
    "export { exportEditedPackage } from '../src/editor/packageExport';\n"
    + "export { normalizeProtoDefFragments } from '../src/protodefs/jsonFragments';\n"
    + "export { decodeProtoDefs, extractKitMessages } from '../src/protodefs/decoder';\n",
  );
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) throw new Error('Vite could not bundle the editor package exporter.');
  return pathToFileURL(path.join(BUILD_DIR, 'editor-package-export-verify-entry.js')).href;
}

async function unzip(blob) {
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const output = new Map();
    for (const entry of await reader.getEntries()) {
      if (entry.directory) continue;
      output.set(entry.filename, entry.filename.endsWith('.json')
        ? await entry.getData(new TextWriter())
        : await entry.getData(new Uint8ArrayWriter()));
    }
    return output;
  } finally {
    await reader.close();
  }
}

const implementation = await import(bundleImplementation());
const original = {
  operation: {
    header: { defindex: 700 },
    operation_node: { stage: { texture_lookup: { texture: { string: 'patterns/original' } } } },
  },
  definition: {
    header: { defindex: 900 },
    operation_template: { defindex: 700 },
    blackbox: { item_definition_template: { defindex: 1 } },
  },
};
const edited = structuredClone(original);
edited.operation.operation_node.stage.texture_lookup.texture.string = 'patterns/edited';

const encoder = new TextEncoder();
const sourceFiles = new Map([
  ['materials/patterns/sample.vtf', new Uint8Array([1, 2, 3, 4])],
  ['defs/custom_operation.json', encoder.encode(`${JSON.stringify(original.operation)}\n`)],
  ['defs/custom_definition.json', encoder.encode(`${JSON.stringify(original.definition)}\n`)],
  ['readme.txt', encoder.encode('keep me')],
]);
const sourcePackage = {
  id: 'fixture', name: 'Fixture.zip', format: 'zip', rootIsMaterials: false,
  entries: new Map([...sourceFiles].map(([entryPath, bytes]) => [entryPath, { path: entryPath, size: bytes.length }])),
  has: (entryPath) => sourceFiles.has(entryPath),
  read: async (entryPath) => new Uint8Array(sourceFiles.get(entryPath)),
  dispose() {},
};

const exported = await implementation.exportEditedPackage(edited, { package: sourcePackage, name: 'Edited Paint' });
assert.equal(exported.fileName, 'fixture-edited.zip');
assert.deepEqual([...exported.replacedPaths].sort(), ['defs/custom_definition.json', 'defs/custom_operation.json']);
assert.deepEqual(exported.addedPaths, []);
const files = await unzip(exported.blob);
assert.deepEqual(files.get('materials/patterns/sample.vtf'), new Uint8Array([1, 2, 3, 4]));
assert.deepEqual(files.get('readme.txt'), encoder.encode('keep me'));
const normalized = implementation.normalizeProtoDefFragments([
  { name: 'operation', text: files.get('defs/custom_operation.json') },
  { name: 'definition', text: files.get('defs/custom_definition.json') },
]);
assert.equal(normalized[0].value.operation_node.stage.texture_lookup.texture.string, 'patterns/edited');
assert.deepEqual(normalized[1].value, edited.definition);

const minimal = await implementation.exportEditedPackage(edited, { name: 'Standalone Paint' });
const minimalFiles = await unzip(minimal.blob);
assert.equal(minimal.fileName, 'standalone_paint-edited.zip');
assert.deepEqual([...minimalFiles.keys()].sort(), [
  'definitions/standalone_paint__definition.json',
  'definitions/standalone_paint__operation.json',
]);

const fullPath = path.join(ROOT, 'public', 'data', 'protodefs-full.bin');
const itemDefsPath = path.join(ROOT, 'public', 'data', 'item-defs.json');
const manifestPath = path.join(ROOT, 'public', 'data', 'manifest.json');
if (fs.existsSync(fullPath) && fs.existsSync(itemDefsPath) && fs.existsSync(manifestPath)) {
  const fullBytes = new Uint8Array(fs.readFileSync(fullPath));
  const itemDefs = JSON.parse(fs.readFileSync(itemDefsPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const decoded = implementation.decodeProtoDefs(fullBytes, {
    weaponsByItemDef: itemDefs,
    builtInIds: manifest.paintkits.map((kit) => kit.id),
  });
  const armyGuns = implementation.extractKitMessages(decoded, 435);
  assert.ok(armyGuns, 'Army Guns should exist in the shipped definition container');
  const editedContainerKit = structuredClone(armyGuns);
  const replaceFirstTexture = (value) => {
    if (!value || typeof value !== 'object') return false;
    if (!Array.isArray(value) && value.texture && typeof value.texture === 'object'
      && typeof value.texture.string === 'string') {
      value.texture.string = 'patterns/editor_package_export_probe';
      return true;
    }
    return Object.values(value).some(replaceFirstTexture);
  };
  assert.equal(replaceFirstTexture(editedContainerKit.operation), true, 'fixture operation should contain a texture reference');
  const vpdFiles = new Map([
    ['scripts/protodefs/proto_defs.vpd', fullBytes],
    ['materials/patterns/keep.vtf', new Uint8Array([9, 8, 7])],
  ]);
  const vpdPackage = {
    id: 'vpd-fixture', name: 'Container.zip', format: 'zip', rootIsMaterials: false,
    entries: new Map([...vpdFiles].map(([entryPath, bytes]) => [entryPath, { path: entryPath, size: bytes.length }])),
    has: (entryPath) => vpdFiles.has(entryPath),
    read: async (entryPath) => new Uint8Array(vpdFiles.get(entryPath)),
    dispose() {},
  };
  const vpdExport = await implementation.exportEditedPackage(editedContainerKit, { package: vpdPackage });
  assert.deepEqual(vpdExport.replacedPaths, ['scripts/protodefs/proto_defs.vpd']);
  const vpdOutput = await unzip(vpdExport.blob);
  assert.deepEqual(vpdOutput.get('materials/patterns/keep.vtf'), new Uint8Array([9, 8, 7]));
  const rewritten = implementation.decodeProtoDefs(vpdOutput.get('scripts/protodefs/proto_defs.vpd'), {
    weaponsByItemDef: itemDefs,
    builtInIds: manifest.paintkits.map((kit) => kit.id),
  });
  assert.match(
    JSON.stringify(implementation.extractKitMessages(rewritten, 435)?.operation),
    /patterns\/editor_package_export_probe/,
    'a package proto_defs container must be replaced with the edited kit spliced into it',
  );
}

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
console.log('[verify] editor package ZIP export passed');
