import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import type { Manifest } from '../../src/data/types';
import { decodeProtoDefs, extractKitBundle } from '../../src/protodefs/decoder';
import type { ProtoDefKitBundle } from '../../src/protodefs/types';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

let shipped: ReturnType<typeof loadShippedProtoDefs> | undefined;

function loadShippedProtoDefs() {
  const weaponsByItemDef: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
  const options = { weaponsByItemDef, builtInIds: manifest.paintkits.map((kit) => kit.id) };
  const baseBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-base.bin')));
  const fullBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-full.bin')));
  const full = decodeProtoDefs(fullBytes, options);
  const bundleOf = (defindex: number): ProtoDefKitBundle => {
    const bundle = extractKitBundle(full, defindex);
    assert.ok(bundle, `kit ${defindex} should produce a bundle`);
    return bundle;
  };
  return { manifest, weaponsByItemDef, options, baseBytes, fullBytes, full, bundleOf };
}

/** The shipped proto_defs data, decoded once per test worker. Treat it as read-only. */
export function shippedProtoDefs(): ReturnType<typeof loadShippedProtoDefs> {
  shipped ??= loadShippedProtoDefs();
  return shipped;
}

export async function fixtureFragments(filePath: string): Promise<Array<{ name: string; text: string }>> {
  const reader = new ZipReader(new BlobReader(new Blob([fs.readFileSync(filePath)])));
  try {
    const entries = await reader.getEntries();
    return await Promise.all(entries
      .filter((entry) => !entry.directory && 'getData' in entry && entry.filename.toLowerCase().endsWith('.json'))
      .map(async (entry) => {
        if (!('getData' in entry)) throw new Error(`Fixture entry ${entry.filename} cannot be read.`);
        return { name: entry.filename, text: await entry.getData(new TextWriter()) };
      }));
  } finally {
    await reader.close();
  }
}

export function fixturePaintkitIds(value: unknown): number[] {
  if (!value || typeof value !== 'object' || !('paintkits' in value) || !Array.isArray(value.paintkits)) return [];
  return value.paintkits.flatMap((kit) => (
    kit && typeof kit === 'object' && 'id' in kit && typeof kit.id === 'number' ? [kit.id] : []
  ));
}

