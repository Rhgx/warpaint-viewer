import assert from 'node:assert/strict';
import path from 'node:path';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { test } from 'vitest';
import { exportEditedPackage } from '../../../src/editor/export/packageExport';
import { decodeProtoDefsFromJson } from '../../../src/protodefs/decoder';
import { classifyProtoDefFragment } from '../../../src/protodefs/jsonFragments';
import { shippedProtoDefs } from '../fixtures';

const { options, baseBytes, bundleOf } = shippedProtoDefs();

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
  assert.ok(rebuilt.index.kits.some((kit) => kit.defindex === KILLER_BEE), 'the exported package decodes back to Killer Bee');
}, 120000);
