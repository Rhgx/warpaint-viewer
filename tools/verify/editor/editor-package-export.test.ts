// Verifies that editor export produces one re-importable ZIP, preserves source
// files, and replaces the selected kit's JSON fragments in place.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { test } from 'vitest';
import { exportEditedPackage } from '../../../src/editor/packageExport';
import { decodeProtoDefs, extractKitMessages } from '../../../src/protodefs/decoder';
import { normalizeProtoDefFragments } from '../../../src/protodefs/jsonFragments';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';
import type { SourcePackage } from '../../../src/source/contracts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function unzip(blob: Blob): Promise<Map<string, string | Uint8Array>> {
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const output = new Map<string, string | Uint8Array>();
    for (const entry of await reader.getEntries()) {
      if (entry.directory || !('getData' in entry)) continue;
      output.set(entry.filename, entry.filename.endsWith('.json')
        ? await entry.getData(new TextWriter())
        : await entry.getData(new Uint8ArrayWriter()));
    }
    return output;
  } finally {
    await reader.close();
  }
}

function textFile(files: ReadonlyMap<string, string | Uint8Array>, name: string): string {
  const value = files.get(name);
  if (typeof value !== 'string') throw new Error(`${name} should be a text ZIP entry`);
  return value;
}

function bytesFile(files: ReadonlyMap<string, string | Uint8Array>, name: string): Uint8Array {
  const value = files.get(name);
  assert.ok(value instanceof Uint8Array, `${name} should be a binary ZIP entry`);
  return value;
}

function fixturePackage(id: string, name: string, files: ReadonlyMap<string, Uint8Array>): SourcePackage {
  return {
    id,
    name,
    format: 'zip',
    rootIsMaterials: false,
    entries: new Map([...files].map(([entryPath, bytes]) => [entryPath, { path: entryPath, size: bytes.length }])),
    has: (entryPath: string) => files.has(entryPath),
    read: async (entryPath: string) => {
      const bytes = files.get(entryPath);
      if (!bytes) throw new Error(`Missing fixture entry: ${entryPath}`);
      return new Uint8Array(bytes);
    },
    dispose() {},
  };
}

function builtInIds(value: unknown): number[] {
  if (!value || typeof value !== 'object' || !('paintkits' in value) || !Array.isArray(value.paintkits)) return [];
  return value.paintkits.flatMap((kit) => (
    kit && typeof kit === 'object' && 'id' in kit && typeof kit.id === 'number' ? [kit.id] : []
  ));
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key];
  if (!field || typeof field !== 'object' || Array.isArray(field)) throw new Error(`${key} should be an object`);
  return field as Record<string, unknown>;
}

const implementation = { decodeProtoDefs, exportEditedPackage, extractKitMessages, normalizeProtoDefFragments };
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
} satisfies ProtoDefKitMessages;
const edited = structuredClone(original);
edited.operation.operation_node.stage.texture_lookup.texture.string = 'patterns/edited';

const encoder = new TextEncoder();
test('editor package ZIP export', async () => {
const sourceFiles = new Map([
  ['materials/patterns/sample.vtf', new Uint8Array([1, 2, 3, 4])],
  ['defs/custom_operation.json', encoder.encode(`${JSON.stringify(original.operation)}\n`)],
  ['defs/custom_definition.json', encoder.encode(`${JSON.stringify(original.definition)}\n`)],
  ['readme.txt', encoder.encode('keep me')],
]);
const sourcePackage = fixturePackage('fixture', 'Fixture.zip', sourceFiles);

const exported = await implementation.exportEditedPackage(edited, { package: sourcePackage, name: 'Edited Paint' });
assert.equal(exported.fileName, 'fixture-edited.zip');
assert.deepEqual([...exported.replacedPaths].sort(), ['defs/custom_definition.json', 'defs/custom_operation.json']);
assert.deepEqual(exported.addedPaths, []);
const files = await unzip(exported.blob);
assert.deepEqual(files.get('materials/patterns/sample.vtf'), new Uint8Array([1, 2, 3, 4]));
assert.deepEqual(files.get('readme.txt'), encoder.encode('keep me'));
const normalized = implementation.normalizeProtoDefFragments([
  { name: 'operation', text: textFile(files, 'defs/custom_operation.json') },
  { name: 'definition', text: textFile(files, 'defs/custom_definition.json') },
]);
const operationNode = objectField(normalized[0].value, 'operation_node');
const operationStage = objectField(operationNode, 'stage');
const textureLookup = objectField(operationStage, 'texture_lookup');
assert.equal(objectField(textureLookup, 'texture').string, 'patterns/edited');
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
    builtInIds: builtInIds(manifest),
  });
  const armyGuns = implementation.extractKitMessages(decoded, 435);
  assert.ok(armyGuns, 'Army Guns should exist in the shipped definition container');
  const editedContainerKit = structuredClone(armyGuns);
  const replaceFirstTexture = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false;
    if (!Array.isArray(value) && 'texture' in value && value.texture && typeof value.texture === 'object'
      && 'string' in value.texture && typeof value.texture.string === 'string') {
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
  const vpdPackage = fixturePackage('vpd-fixture', 'Container.zip', vpdFiles);
  const vpdExport = await implementation.exportEditedPackage(editedContainerKit, { package: vpdPackage });
  assert.deepEqual(vpdExport.replacedPaths, ['scripts/protodefs/proto_defs.vpd']);
  const vpdOutput = await unzip(vpdExport.blob);
  assert.deepEqual(vpdOutput.get('materials/patterns/keep.vtf'), new Uint8Array([9, 8, 7]));
  const rewritten = implementation.decodeProtoDefs(bytesFile(vpdOutput, 'scripts/protodefs/proto_defs.vpd'), {
    weaponsByItemDef: itemDefs,
    builtInIds: builtInIds(manifest),
  });
  assert.match(
    JSON.stringify(implementation.extractKitMessages(rewritten, 435)?.operation),
    /patterns\/editor_package_export_probe/,
    'a package proto_defs container must be replaced with the edited kit spliced into it',
  );
}

});
