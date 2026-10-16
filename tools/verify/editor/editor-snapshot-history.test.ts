// Structural sharing for editor snapshots and the undo cap in SnapshotHistory.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import type { Manifest } from '../../../src/data/types';
import { SnapshotHistory } from '../../../src/editor/history';
import { applyBundleEdit, snapshotBundle } from '../../../src/editor/kitBundle';
import { decodeProtoDefs, extractKitBundle } from '../../../src/protodefs/decoder';
import type { ProtoDefKitBundle } from '../../../src/protodefs/types';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const weaponsByItemDef: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
const full = decodeProtoDefs(new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-full.bin'))), {
  weaponsByItemDef,
  builtInIds: manifest.paintkits.map((kit) => kit.id),
});

function bundleOf(defindex: number): ProtoDefKitBundle {
  const bundle = extractKitBundle(full, defindex);
  assert.ok(bundle, `kit ${defindex} should produce a bundle`);
  return bundle;
}

// A fresh operation object with the same contents: the edit changes identity, not meaning.
const touchOperation = (messages: { definition: Record<string, unknown>; operation: Record<string, unknown> }) => ({
  ...messages,
  operation: { ...messages.operation },
});

test('a snapshot shares untouched operations and the definition with the snapshot it came from', () => {
  const first = snapshotBundle(bundleOf(80));
  assert.ok(Object.isFrozen(first));
  assert.ok(first.operations.length > 1, 'Warhawk has several operations');

  const second = snapshotBundle(applyBundleEdit(first, 0, touchOperation));
  assert.notEqual(second.operations[0], first.operations[0], 'the edited operation is a new snapshot');
  for (let index = 1; index < first.operations.length; index += 1) {
    assert.equal(second.operations[index], first.operations[index], `operation ${index} is reused by reference`);
  }
  assert.equal(second.definition, first.definition, 'an unchanged definition is reused by reference');
  assert.deepStrictEqual(second, first, 'sharing does not change the contents');
});

test('snapshots never alias the working bundle they were made from', () => {
  const working = bundleOf(80);
  const original = structuredClone(working);
  const snapshot = snapshotBundle(working);
  assert.notEqual(snapshot.operations[0], working.operations[0]);
  assert.notEqual(snapshot.definition, working.definition);
  working.operations[0].header = { defindex: -1 };
  assert.deepStrictEqual(snapshot.operations[0], original.operations[0]);
});

test('undo returns the exact earlier snapshot after a shared edit', () => {
  const history = new SnapshotHistory<ProtoDefKitBundle>();
  const original = snapshotBundle(bundleOf(80));
  const edited = snapshotBundle(applyBundleEdit(original, 0, touchOperation));
  history.record(original);
  const restored = history.undo(edited);
  assert.equal(restored, original);
  assert.deepStrictEqual(restored, bundleOf(80));
  assert.equal(history.canRedo, true);
  assert.equal(history.redo(original), edited);
});

test('undo history keeps only the newest 100 entries', () => {
  const history = new SnapshotHistory<number>();
  for (let value = 0; value < 150; value += 1) history.record(value);
  const undone: number[] = [];
  let current = 150;
  for (let prior = history.undo(current); prior !== undefined; prior = history.undo(current)) {
    undone.push(prior);
    current = prior;
  }
  assert.equal(undone.length, 100);
  assert.equal(undone[0], 149);
  assert.equal(undone[99], 50);
  assert.equal(history.canUndo, false);
});
