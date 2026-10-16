// Structural sharing for editor snapshots and the undo cap in SnapshotHistory.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SnapshotHistory } from '../../../src/editor/history';
import { applyBundleEdit, snapshotBundle } from '../../../src/editor/kitBundle';
import type { ProtoDefKitBundle, ProtoDefKitMessages } from '../../../src/protodefs/types';

const bundle = (): ProtoDefKitBundle => ({
  definition: { header: { defindex: 1 } },
  operations: [1, 2, 3].map((defindex) => ({ header: { defindex }, operation_node: [{ texture: { string: `t${defindex}` } }] })),
  itemDefinitions: [],
  scopes: [],
});

// A fresh operation object with the same contents: the edit changes identity, not meaning.
const touchOperation = (messages: ProtoDefKitMessages) => ({ ...messages, operation: { ...messages.operation } });

test('a snapshot shares untouched operations and the definition with the snapshot it came from', () => {
  const first = snapshotBundle(bundle());
  assert.ok(Object.isFrozen(first));

  const second = snapshotBundle(applyBundleEdit(first, 0, touchOperation));
  assert.notEqual(second.operations[0], first.operations[0], 'the edited operation is a new snapshot');
  assert.equal(second.operations[1], first.operations[1], 'untouched operations are reused by reference');
  assert.equal(second.operations[2], first.operations[2]);
  assert.equal(second.definition, first.definition, 'an unchanged definition is reused by reference');
  assert.deepStrictEqual(second, first, 'sharing does not change the contents');
});

test('snapshots never alias the working bundle they were made from', () => {
  const working = bundle();
  const snapshot = snapshotBundle(working);
  assert.notEqual(snapshot.definition, working.definition);
  working.operations[0].header = { defindex: -1 };
  assert.deepStrictEqual(snapshot.operations[0], bundle().operations[0]);
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
});
