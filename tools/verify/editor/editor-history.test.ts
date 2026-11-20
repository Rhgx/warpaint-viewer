// History, structural sharing, and undo cap contracts for immutable proto-def editor snapshots.

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { SnapshotHistory } from '../../../src/editor/history';
import { applyBundleEdit, snapshotBundle } from '../../../src/editor/kitBundle';
import { assignSelectGroupExclusively, clearSelectGroupIds } from '../../../src/editor/layers/groupMutations';
import type { ProtoDefKitBundle, ProtoDefKitMessages } from '../../../src/protodefs/types';

const layerTarget = (occurrence: number) => ({ groupsValue: 'models/example_groups', occurrence });
const layer = (label: string, occurrence: number) => ({ label, target: layerTarget(occurrence) });
const base: ProtoDefKitMessages = {
  definition: { header: { defindex: 1, variables: [] } },
  operation: {
    header: { defindex: 2, variables: [] },
    operation_node: [{ stage: { combine_multiply: { operation_node: [
      { stage: { select: { groups: { string: 'models/example_groups' }, select: [{ uint32: 16 }, { uint32: 32 }, { uint32: 0 }] } } },
      { stage: { select: { groups: { string: 'models/example_groups' }, select: [{ uint32: 48 }, { uint32: 0 }, { uint32: 0 }] } } },
    ] } } }],
  },
};

test('Clear removes several part ids as one undo step', () => {
  const history = new SnapshotHistory<ProtoDefKitMessages>();
  const cleared = clearSelectGroupIds(base, layerTarget(0), [16, 32]);
  assert.notDeepEqual(cleared, base);
  history.record(base);
  const undone = history.undo(cleared);
  assert.deepEqual(undone, base, 'Undo should restore the full pre-Clear snapshot');
  assert.equal(history.canUndo, false, 'Clear should add one undo entry, not one per part');
  assert.ok(undone);
  assert.deepEqual(history.redo(undone), cleared, 'Redo should restore the complete Clear result');
  assert.equal(history.canRedo, false);
});

test('a new edit after undo drops the stale redo', () => {
  const history = new SnapshotHistory<ProtoDefKitMessages>();
  history.record(base);
  const undone = history.undo(clearSelectGroupIds(base, layerTarget(0), [16]));
  assert.ok(undone);
  assert.equal(history.canRedo, true);
  assignSelectGroupExclusively(undone, layer('Layer 2', 1), [layer('Layer 1', 0), layer('Layer 2', 1)], 32);
  history.record(undone);
  assert.equal(history.canRedo, false, 'A new edit must invalidate redo history');
});

const bundle = (): ProtoDefKitBundle => ({
  definition: { header: { defindex: 1 } },
  operations: [1, 2, 3].map((defindex) => ({ header: { defindex }, operation_node: [{ texture: { string: `t${defindex}` } }] })),
  itemDefinitions: [],
  scopes: [],
});

// A fresh operation object with the same contents: the edit changes identity, not meaning.
const touchOperation = (messages: ProtoDefKitMessages) => ({ ...messages, operation: { ...messages.operation } });

test('a snapshot shares the definition with the snapshot it came from', () => {
  const first = snapshotBundle(bundle());
  assert.ok(Object.isFrozen(first));

  const second = snapshotBundle(applyBundleEdit(first, 0, touchOperation));
  assert.notEqual(second.operations[0], first.operations[0], 'the edited operation is a new snapshot');
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
