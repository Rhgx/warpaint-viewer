import assert from 'node:assert/strict';
import path from 'node:path';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { test } from 'vitest';
import { serializeProtoDefKitMessages } from '../../../src/editor/export/jsonExport';
import { exportEditedPackage } from '../../../src/editor/export/packageExport';
import { decodeProtoDefsFromJson, extractKitMessages, resolveKitRecipe } from '../../../src/protodefs/decoder';
import { classifyProtoDefFragment } from '../../../src/protodefs/jsonFragments';
import { shippedProtoDefs } from '../fixtures';

const { options, baseBytes, full, bundleOf } = shippedProtoDefs();

// Killer Bee (85) is per-wear: five operations (one per wear of its weapon slot) and one item definition.
const KILLER_BEE = 85;

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
  const counts: Record<string, number> = {};
  for (const file of files) {
    const kind = String(classifyProtoDefFragment(file.text));
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  assert.deepEqual(counts, { operation: 5, itemDefinition: 1, definition: 1 });

  const fragments = files.map((file) => ({ name: path.posix.basename(file.name), text: file.text }));
  const rebuilt = decodeProtoDefsFromJson(baseBytes, fragments, options);
  for (const scope of bundle.scopes) {
    const expected = resolveKitRecipe(full, KILLER_BEE, scope.weaponKey, 'red', scope.wear);
    assert.ok(expected, `${scope.weaponKey} wear ${scope.wear} should resolve in the full container`);
    const actual = resolveKitRecipe(rebuilt, KILLER_BEE, scope.weaponKey, 'red', scope.wear);
    assert.deepStrictEqual(actual, expected, `${scope.weaponKey} wear ${scope.wear} differs in the exported package`);
  }
}, 120000);

test('a top-level paint exports the same files as the single-operation serializers', async () => {
  const messages = extractKitMessages(full, 109);
  assert.ok(messages, 'kit 109 should have a top-level operation');
  const expected = serializeProtoDefKitMessages(messages, { name: 'Top Level' });
  const exported = await exportEditedPackage(bundleOf(109), { name: 'Top Level' });
  assert.deepStrictEqual(await unzipText(exported.blob), [
    { name: `definitions/${expected.operation.name}`, text: expected.operation.text },
    { name: `definitions/${expected.definition.name}`, text: expected.definition.text },
  ]);
}, 120000);
