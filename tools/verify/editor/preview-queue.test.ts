// Single-flight coalescing for editor preview builds.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLatestOnlyQueue } from '../../../src/editor/useEditorCore';

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open };
}

function settle(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0); });
}

test('preview builds run one at a time and only the newest waiting build runs next', async () => {
  const submit = createLatestOnlyQueue();
  const gates: Record<string, { wait: Promise<void>; open: () => void }> = {};
  const started: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const task = (name: string) => {
    gates[name] = gate();
    return async () => {
      started.push(name);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[name].wait;
      inFlight -= 1;
    };
  };

  submit(task('a'));
  submit(task('b'));
  submit(task('c'));
  assert.deepEqual(started, ['a'], 'the first build starts at once; later ones wait');

  gates.a.open();
  await settle();
  assert.deepEqual(started, ['a', 'c'], 'b was superseded by c before it could start');

  gates.c.open();
  await settle();
  submit(task('d'));
  assert.deepEqual(started, ['a', 'c', 'd'], 'an idle queue starts the next build at once');
  gates.d.open();
  await settle();
  assert.equal(maxInFlight, 1, 'no two builds overlap');
});
