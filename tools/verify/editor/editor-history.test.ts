// Focused history contract check for immutable proto-def editor snapshots.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SnapshotHistory } from '../../../src/editor/history';
import { assignSelectGroupExclusively, clearSelectGroupIds } from '../../../src/editor/mutations';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';

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
