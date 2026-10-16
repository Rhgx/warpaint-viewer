import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import type { Manifest } from '../../src/data/types';
import { decodeProtoDefs, extractKitBundle, type DecodedContainer } from '../../src/protodefs/decoder';
import { asItem, type HeaderMsg, type ItemDefinitionMsg, type OperationNodeMsg } from '../../src/protodefs/messages';
import { buildResolveCtx } from '../../src/protodefs/resolve';
import type { ProtoDefKitBundle, ProtoDefKitMessages } from '../../src/protodefs/types';

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

/** Reads a nested field of an untyped message (mutation results are plain records), or undefined. */
export function dig(value: unknown, ...path: Array<string | number>): unknown {
  return path.reduce<unknown>((node, key) => (node !== null && typeof node === 'object' ? Reflect.get(node, key) : undefined), value);
}

type CloseExpected = number | readonly CloseExpected[] | { readonly [key: string]: CloseExpected };

/** Asserts a number, or every listed element or field of `expected` (recursively), matches `actual` within 1e-9. */
export function close(actual: unknown, expected: CloseExpected, message: string): void {
  if (typeof expected === 'number') {
    assert.ok(typeof actual === 'number' && Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${String(actual)}`);
    return;
  }
  for (const [key, value] of Object.entries(expected)) close(dig(actual, key), value, `${message} ${key}`);
}

// Minimal authored operation nodes for operation-graph tests.
export const textureNode = (name: string): OperationNodeMsg => ({ stage: { texture_lookup: { texture: { string: name } } } });
export const selectNode = (group = 32): OperationNodeMsg => ({ stage: { select: { groups: { string: 'groups' }, select: [{ uint32: group }] } } });
export const addNode = (children: OperationNodeMsg[]): OperationNodeMsg => ({ stage: { combine_add: { operation_node: children } } });
export const lerpNode = (children: OperationNodeMsg[]): OperationNodeMsg => ({ stage: { combine_lerp: { operation_node: children } } });

function hasHeader(value: Record<string, unknown>): value is Record<string, unknown> & { header: HeaderMsg } {
  return typeof dig(value, 'header', 'defindex') === 'number';
}

/** A one-kit container over synthetic messages; each named weapon slot the definition holds reads `itemDefinition`. */
export function syntheticContainer(messages: ProtoDefKitMessages, itemDefinition: ItemDefinitionMsg, weaponKeys: readonly string[]): DecodedContainer {
  const { definition, operation } = messages;
  assert.ok(hasHeader(definition) && hasHeader(operation), 'synthetic messages need numeric header defindexes');
  const slots = weaponKeys.flatMap((weaponKey) => {
    const item = asItem(definition[weaponKey]);
    return item ? [{ item, itemDef: itemDefinition, weaponKey }] : [];
  });
  return {
    ctx: buildResolveCtx([operation], [itemDefinition], []),
    kitsByDefindex: new Map([[definition.header.defindex, { def: definition, slots }]]),
    index: { kits: [], countsByType: {} },
  };
}
