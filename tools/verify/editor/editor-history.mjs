// Focused history contract check for immutable proto-def editor snapshots.
//
//   node tools/verify/editor/editor-history.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'editor-history-verify');

function bundleImplementation() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const entry = path.join(ROOT, 'staging', 'editor-history-verify-entry.ts');
  fs.writeFileSync(entry,
    "export { SnapshotHistory } from '../src/editor/history';\n"
    + "export { assignSelectGroupExclusively, clearSelectGroupIds } from '../src/editor/mutations';\n",
  );
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(process.execPath, [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) throw new Error('Vite could not bundle the TypeScript editor history implementation.');
  return pathToFileURL(path.join(BUILD_DIR, 'editor-history-verify-entry.js')).href;
}

const implementation = await import(bundleImplementation());

const layerTarget = (occurrence) => ({ groupsValue: 'models/example_groups', occurrence });
const layer = (label, occurrence) => ({ label, target: layerTarget(occurrence) });
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

function values(messages, occurrence) {
  return messages.operation.operation_node[0].stage.combine_multiply.operation_node[occurrence].stage.select.select
    .map((field) => field.uint32 ?? field.string);
}

// Clear must be exactly one step even though it removes two literal ids.
const clearHistory = new implementation.SnapshotHistory();
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
const branchHistory = new implementation.SnapshotHistory();
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
const assignmentHistory = new implementation.SnapshotHistory();
const moved = implementation.assignSelectGroupExclusively(base, layer('Layer 2', 1), [
  layer('Layer 1', 0), layer('Layer 2', 1),
], 32).messages;
assignmentHistory.record(base);
assert.deepEqual(values(moved, 0), [16, 0, 0]);
assert.deepEqual(values(moved, 1), [48, 32, 0]);
const restored = assignmentHistory.undo(moved);
assert.deepEqual(restored, base, 'One undo must restore both sides of a moved part');
assert.equal(assignmentHistory.canUndo, false, 'One assignment must create one history step');

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
console.log('[verify] editor history passed');
