// Focused history contract check for immutable proto-def editor snapshots.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SnapshotHistory } from '../../../src/editor/history';
import { assignSelectGroupExclusively, clearSelectGroupIds } from '../../../src/editor/mutations';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';

const implementation = { SnapshotHistory, assignSelectGroupExclusively, clearSelectGroupIds };

test('immutable editor history snapshots', () => {

const layerTarget = (occurrence: number) => ({ groupsValue: 'models/example_groups', occurrence });
const layer = (label: string, occurrence: number) => ({ label, target: layerTarget(occurrence) });
const base = {
  definition: { header: { defindex: 1, variables: [] } },
  operation: {
    header: { defindex: 2, variables: [] },
    operation_node: [{ stage: { combine_multiply: { operation_node: [
      { stage: { select: { groups: { string: 'models/example_groups' }, select: [{ uint32: 16 }, { uint32: 32 }, { uint32: 0 }] } } },
      { stage: { select: { groups: { string: 'models/example_groups' }, select: [{ uint32: 48 }, { uint32: 0 }, { uint32: 0 }] } } },
    ] } } }],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} should be an object`);
  return value;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} should be an array`);
  return value;
}

function values(messages: ProtoDefKitMessages, occurrence: number): Array<number | string | undefined> {
  const operationNodes = arrayValue(messages.operation.operation_node, 'operation nodes');
  const root = recordValue(operationNodes[0], 'root operation node');
  const rootStage = recordValue(root.stage, 'root stage');
  const multiply = recordValue(rootStage.combine_multiply, 'multiply stage');
  const child = recordValue(arrayValue(multiply.operation_node, 'multiply nodes')[occurrence], 'select operation node');
  const select = recordValue(recordValue(child.stage, 'select stage').select, 'select stage');
  return arrayValue(select.select, 'select values').map((field) => {
    const value = recordValue(field, 'select value');
    const literal = value.uint32;
    return typeof literal === 'number' ? literal : typeof value.string === 'string' ? value.string : undefined;
  });
}

// Clear must be exactly one step even though it removes two literal ids.
const clearHistory = new implementation.SnapshotHistory<ProtoDefKitMessages>();
const cleared = implementation.clearSelectGroupIds(base, layerTarget(0), [16, 32]);
clearHistory.record(base);
assert.deepEqual(values(cleared, 0), [0, 0, 0], 'Clear should remove every selected part from the active layer');
const afterClearUndo = clearHistory.undo(cleared);
assert.deepEqual(afterClearUndo, base, 'Undo should restore the full pre-Clear snapshot');
assert.equal(clearHistory.canUndo, false, 'Clear should add one undo entry, not one per part');
assert.equal(clearHistory.canRedo, true);
const afterClearRedo = clearHistory.redo(afterClearUndo);
assert.deepEqual(afterClearRedo, cleared, 'Redo should restore the complete Clear result');
assert.equal(clearHistory.canUndo, true);
assert.equal(clearHistory.canRedo, false);

// A new edit after undo replaces the alternate timeline rather than leaving a
// stale redo available.
const branchHistory = new implementation.SnapshotHistory<ProtoDefKitMessages>();
const firstEdit = implementation.clearSelectGroupIds(base, layerTarget(0), [16]);
branchHistory.record(base);
const undone = branchHistory.undo(firstEdit);
assert.ok(undone);
const branched = implementation.assignSelectGroupExclusively(undone, layer('Layer 2', 1), [
  layer('Layer 1', 0), layer('Layer 2', 1),
], 32).messages;
branchHistory.record(undone);
assert.equal(branchHistory.canRedo, false, 'A new edit must invalidate redo history');
assert.deepEqual(values(branched, 0), [16, 0, 0]);
assert.deepEqual(values(branched, 1), [48, 32, 0]);

// Exclusive cross-layer reassignment mutates both layers but records one
// snapshot. One undo restores both owners together.
const assignmentHistory = new implementation.SnapshotHistory<ProtoDefKitMessages>();
const moved = implementation.assignSelectGroupExclusively(base, layer('Layer 2', 1), [
  layer('Layer 1', 0), layer('Layer 2', 1),
], 32).messages;
assignmentHistory.record(base);
assert.deepEqual(values(moved, 0), [16, 0, 0]);
assert.deepEqual(values(moved, 1), [48, 32, 0]);
const restored = assignmentHistory.undo(moved);
assert.deepEqual(restored, base, 'One undo must restore both sides of a moved part');
assert.equal(assignmentHistory.canUndo, false, 'One assignment must create one history step');

});
