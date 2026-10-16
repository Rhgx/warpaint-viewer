import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLightingStore } from '../../../src/viewer/lighting/lightingStore';
import { createDefaultCustomLightingRig, MAX_CUSTOM_LIGHTS } from '../../../src/viewer/lighting/customLighting';

test('lighting previews notify rig subscribers and commit one undo step', () => {
  const store = createLightingStore(createDefaultCustomLightingRig());
  const initial = store.getState().rig;
  let rigs = 0;
  let history = 0;
  let selections = 0;
  let panels = 0;
  const unsubscribe = [
    store.subscribe((state) => state.rig, () => rigs++),
    store.subscribe((state) => state.canUndo, () => history++),
    store.subscribe((state) => state.selectedLightId, () => selections++),
    store.subscribe((state) => state.open, () => panels++),
  ];
  for (let step = 1; step <= 100; step++) {
    store.getState().preview({ ...initial, exposure: initial.exposure + step / 100 });
  }
  assert.deepEqual([rigs, history, selections, panels], [100, 0, 0, 0]);
  const committed = store.getState().rig;
  store.getState().apply({ ...committed });
  assert.equal(store.getState().rig, committed);
  assert.deepEqual([rigs, history, selections, panels], [100, 1, 0, 0]);
  store.getState().undo();
  assert.equal(store.getState().rig, initial);
  assert.equal(store.getState().canUndo, false);
  assert.equal(store.getState().canRedo, true);
  store.getState().redo();
  assert.equal(store.getState().rig, committed);
  assert.deepEqual([rigs, history, selections, panels], [102, 3, 0, 0]);
  store.getState().setOpen(true);
  assert.deepEqual([rigs, history, selections, panels], [102, 3, 0, 1]);
  unsubscribe.forEach((stop) => stop());
  store.getState().preview(initial);
  assert.equal(rigs, 102);
});

test('selection stays valid atomically through rig replacement, preview, undo and redo', () => {
  const store = createLightingStore(createDefaultCustomLightingRig());
  const rig = store.getState().rig;
  const first = rig.lights[0];
  const second = rig.lights[1];
  assert.ok(first && second);
  assert.equal(store.getState().selectedLightId, first.id);
  store.subscribe(({ rig: current, selectedLightId }) => {
    assert.equal(selectedLightId === null, current.lights.length === 0);
    if (selectedLightId !== null) assert.ok(current.lights.some((light) => light.id === selectedLightId));
  });
  store.getState().select(second.id);
  store.getState().apply({ ...rig, exposure: 2 });
  assert.equal(store.getState().selectedLightId, second.id);
  store.getState().select('missing');
  assert.equal(store.getState().selectedLightId, first.id);
  store.getState().select(second.id);
  store.getState().select(null);
  assert.equal(store.getState().selectedLightId, first.id);
  store.getState().apply({ ...rig, lights: [second] });
  assert.equal(store.getState().selectedLightId, second.id);
  store.getState().preview({ ...rig, lights: [] });
  assert.equal(store.getState().selectedLightId, null);
  store.getState().apply(store.getState().rig);
  store.getState().undo();
  assert.equal(store.getState().selectedLightId, second.id);
  store.getState().redo();
  assert.equal(store.getState().selectedLightId, null);
});

test('light commands update selection atomically, respect the cap, and support history', () => {
  const store = createLightingStore(createDefaultCustomLightingRig());
  const rig = store.getState().rig;
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.getState().duplicateSelected();
  const duplicated = store.getState().rig;
  const copy = duplicated.lights.at(-1);
  assert.ok(copy);
  assert.equal(duplicated.lights.length, rig.lights.length + 1);
  assert.equal(store.getState().selectedLightId, copy.id);
  assert.equal(notifications, 1);
  store.getState().toggleSelected();
  assert.equal(store.getState().rig.lights.at(-1)?.enabled, !copy.enabled);
  store.getState().undo();
  assert.equal(store.getState().rig, duplicated);
  notifications = 0;
  store.getState().deleteSelected();
  assert.equal(notifications, 1);
  assert.equal(store.getState().selectedLightId, rig.lights.at(-1)?.id);
  store.getState().undo();
  assert.equal(store.getState().rig, duplicated);
  while (store.getState().rig.lights.length < MAX_CUSTOM_LIGHTS) store.getState().duplicateSelected();
  const capped = store.getState();
  notifications = 0;
  store.getState().duplicateSelected();
  assert.equal(store.getState(), capped);
  assert.equal(notifications, 0);
});
