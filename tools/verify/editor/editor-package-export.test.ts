// Verifies that editor export produces one re-importable ZIP, preserves source
// files, and replaces the selected kit's JSON fragments in place.

import assert from 'node:assert/strict';
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { test } from 'vitest';
import { exportEditedPackage } from '../../../src/editor/export/packageExport';
import { decodeProtoDefs, extractKitMessages } from '../../../src/protodefs/decoder';
import { normalizeProtoDefFragments } from '../../../src/protodefs/jsonFragments';
import type { ProtoDefKitBundle, ProtoDefKitMessages } from '../../../src/protodefs/types';
import type { SourcePackage } from '../../../src/source/contracts';
import { shippedProtoDefs } from '../fixtures';

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

function singleOperationBundle(kit: ProtoDefKitMessages): ProtoDefKitBundle {
  return { definition: kit.definition, operations: [kit.operation], itemDefinitions: [], scopes: [] };
}

const encoder = new TextEncoder();

test('a JSON package export preserves other files and replaces the kit fragments in place', async () => {
  const sourcePackage = fixturePackage('fixture', 'Fixture.zip', new Map([
    ['materials/patterns/sample.vtf', new Uint8Array([1, 2, 3, 4])],
    ['defs/custom_operation.json', encoder.encode(`${JSON.stringify(original.operation)}
`)],
    ['defs/custom_definition.json', encoder.encode(`${JSON.stringify(original.definition)}
`)],
    ['readme.txt', encoder.encode('keep me')],
  ]));

  const exported = await exportEditedPackage(singleOperationBundle(edited), { package: sourcePackage, name: 'Edited Paint' });
  assert.equal(exported.fileName, 'fixture-edited.zip');
  assert.deepEqual([...exported.replacedPaths].sort(), ['defs/custom_definition.json', 'defs/custom_operation.json']);
  assert.deepEqual(exported.addedPaths, []);
  const files = await unzip(exported.blob);
  assert.deepEqual(files.get('materials/patterns/sample.vtf'), new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(files.get('readme.txt'), encoder.encode('keep me'));
  const normalized = normalizeProtoDefFragments([
    { name: 'operation', text: textFile(files, 'defs/custom_operation.json') },
    { name: 'definition', text: textFile(files, 'defs/custom_definition.json') },
  ]);
  assert.deepEqual(normalized[0].value, edited.operation);
  assert.deepEqual(normalized[1].value, edited.definition);
});

test('a package proto_defs container is replaced with the edited kit spliced into it', async () => {
  const { full, fullBytes, options } = shippedProtoDefs();
  const armyGuns = extractKitMessages(full, 435);
  assert.ok(armyGuns, 'Army Guns should exist in the shipped definition container');
  // Local clone: the shared decoded container must stay untouched.
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
  const vpdPackage = fixturePackage('vpd-fixture', 'Container.zip', new Map([
    ['scripts/protodefs/proto_defs.vpd', fullBytes],
    ['materials/patterns/keep.vtf', new Uint8Array([9, 8, 7])],
  ]));
  const vpdExport = await exportEditedPackage(singleOperationBundle(editedContainerKit), { package: vpdPackage });
  assert.deepEqual(vpdExport.replacedPaths, ['scripts/protodefs/proto_defs.vpd']);
  const vpdOutput = await unzip(vpdExport.blob);
  assert.deepEqual(vpdOutput.get('materials/patterns/keep.vtf'), new Uint8Array([9, 8, 7]));
  const vpd = vpdOutput.get('scripts/protodefs/proto_defs.vpd');
  assert.ok(vpd instanceof Uint8Array);
  assert.match(JSON.stringify(extractKitMessages(decodeProtoDefs(vpd, options), 435)?.operation), /patterns\/editor_package_export_probe/);
}, 30_000); // Splices into the 9.8 MB proto_defs snapshot, which outruns the default under parallel load.
