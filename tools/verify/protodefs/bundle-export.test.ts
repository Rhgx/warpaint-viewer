import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { test } from 'vitest';
import type { Manifest } from '../../../src/data/types';
import { serializeProtoDefKitMessages } from '../../../src/editor/export/jsonExport';
import { exportEditedPackage } from '../../../src/editor/export/packageExport';
import { buildDefinitionFiles, PACK_PROTO_DEFS_PATH } from '../../../src/export/definitions';
import { spliceProtoDefs } from '../../../src/export/protoWrite';
import {
  decodeProtoDefs,
  decodeProtoDefsFromJson,
  extractKitBundle,
  extractKitMessages,
  resolveKitRecipe,
} from '../../../src/protodefs/decoder';
import { classifyProtoDefFragment, type ProtoDefFragmentKind } from '../../../src/protodefs/jsonFragments';
import type { ProtoDefKitBundle } from '../../../src/protodefs/types';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const weaponsByItemDef: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
const options = { weaponsByItemDef, builtInIds: manifest.paintkits.map((kit) => kit.id) };
const BASE = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-full.bin')));
const JSON_BASE = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-base.bin')));
const full = decodeProtoDefs(BASE, options);

// Killer Bee (85) is per-wear: five operations (one per wear of its weapon slot) and one item definition.
const KILLER_BEE = 85;

function bundleOf(defindex: number): ProtoDefKitBundle {
  const bundle = extractKitBundle(full, defindex);
  assert.ok(bundle, `kit ${defindex} should produce a bundle`);
  return bundle;
}

function countKinds(texts: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const text of texts) {
    const kind: ProtoDefFragmentKind | null = classifyProtoDefFragment(text);
    counts[String(kind)] = (counts[String(kind)] ?? 0) + 1;
  }
  return counts;
}

async function unzipText(blob: Blob): Promise<{ name: string; text: string }[]> {
  const reader = new ZipReader(new BlobReader(blob));
  try {
    const output: { name: string; text: string }[] = [];
    for (const entry of await reader.getEntries()) {
      if (entry.directory || !('getData' in entry)) continue;
      output.push({ name: entry.filename, text: await entry.getData(new TextWriter()) });
    }
    return output;
  } finally {
    await reader.close();
  }
}

test('Killer Bee package export writes all five operations and its item definition', async () => {
  const bundle = bundleOf(KILLER_BEE);
  const exported = await exportEditedPackage(bundle, { name: 'Killer Bee Copy' });
  const files = await unzipText(exported.blob);
  assert.equal(files.length, 7, 'five operations, one item definition, one definition');
  assert.deepEqual(countKinds(files.map((file) => file.text)), { operation: 5, itemDefinition: 1, definition: 1 });

  const fragments = files.map((file) => ({ name: path.posix.basename(file.name), text: file.text }));
  const rebuilt = decodeProtoDefsFromJson(JSON_BASE, fragments, options);
  for (const scope of bundle.scopes) {
    const expected = resolveKitRecipe(full, KILLER_BEE, scope.weaponKey, 'red', scope.wear);
    assert.ok(expected, `${scope.weaponKey} wear ${scope.wear} should resolve in the full container`);
    const actual = resolveKitRecipe(rebuilt, KILLER_BEE, scope.weaponKey, 'red', scope.wear);
    assert.deepStrictEqual(actual, expected, `${scope.weaponKey} wear ${scope.wear} differs in the exported package`);
  }
}, 120000);

for (const [mode, targetDefindex] of [['append', undefined], ['overwrite', KILLER_BEE]] as const) {
  test(`Killer Bee ${mode} container resolves every scope's recipe like the source`, () => {
    const bundle = bundleOf(KILLER_BEE);
    const built = buildDefinitionFiles({ baseContainer: BASE, bundle, mode, targetDefindex });
    const container = built.files.find((file) => file.path === PACK_PROTO_DEFS_PATH);
    assert.ok(container, 'the build should carry a proto_defs container');
    assert.equal(built.replaced, mode === 'overwrite');

    const decoded = decodeProtoDefs(container.data, options);
    for (const scope of bundle.scopes) {
      const expected = resolveKitRecipe(full, KILLER_BEE, scope.weaponKey, 'red', scope.wear);
      const actual = resolveKitRecipe(decoded, built.paintkitDefindex, scope.weaponKey, 'red', scope.wear);
      assert.deepStrictEqual(actual, expected, `${scope.weaponKey} wear ${scope.wear} differs in the ${mode} container`);
    }
  }, 120000);
}

test('overwriting kit 85 with the Warhawk bundle is refused by the container build', () => {
  assert.throws(
    () => buildDefinitionFiles({ baseContainer: BASE, bundle: bundleOf(80), mode: 'overwrite', targetDefindex: KILLER_BEE }),
    /weapon slots do not match/,
  );
});

test('a top-level paint exports the same files as the single-operation serializers', async () => {
  const TOP_LEVEL = 109;
  const messages = extractKitMessages(full, TOP_LEVEL);
  assert.ok(messages, 'kit 109 should have a top-level operation');
  const bundle = bundleOf(TOP_LEVEL);

  const expected = serializeProtoDefKitMessages(messages, { name: 'Top Level' });
  const exported = await exportEditedPackage(bundle, { name: 'Top Level' });
  assert.deepStrictEqual(await unzipText(exported.blob), [
    { name: `definitions/${expected.operation.name}`, text: expected.operation.text },
    { name: `definitions/${expected.definition.name}`, text: expected.definition.text },
  ]);

  for (const [mode, targetDefindex] of [['append', undefined], ['overwrite', TOP_LEVEL]] as const) {
    const old = spliceProtoDefs({
      baseBytes: BASE,
      operation: messages.operation,
      definition: messages.definition,
      mode,
      targetDefindex,
    });
    const built = buildDefinitionFiles({ baseContainer: BASE, bundle, mode, targetDefindex });
    const container = built.files.find((file) => file.path === PACK_PROTO_DEFS_PATH);
    assert.ok(container, 'the build should carry a proto_defs container');
    assert.equal(Buffer.compare(Buffer.from(container.data), Buffer.from(old.bytes)), 0, `${mode} container changed`);
  }
}, 120000);
