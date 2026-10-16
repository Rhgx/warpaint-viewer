import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createLightingStore } from '../../../src/viewer/lighting/lightingStore';
import { bindLightingStore } from '../../../src/viewer/lighting/bindLightingStore';
import {
  CUSTOM_LIGHTING_ID,
  createDefaultCustomLightingRig,
  validateCustomLightingRig,
  type CustomLightingRig,
} from '../../../src/viewer/lighting/customLighting';
import type { Viewer } from '../../../src/viewer/Viewer';

type LightingViewer = Pick<Viewer,
  'setCustomLighting' | 'setLighting' | 'setLightingEditorState'
  | 'onCustomLightingChange' | 'onLightSelectionChange'>;

const defaultRig = validateCustomLightingRig(createDefaultCustomLightingRig());

class FakeLightingViewer implements LightingViewer {
  rig = defaultRig;
  editor: Parameters<Viewer['setLightingEditorState']>[0] = { enabled: false, selectedLightId: null };
  readonly calls: string[] = [];
  readonly rigListeners = new Set<Parameters<Viewer['onCustomLightingChange']>[0]>();
  readonly selectionListeners = new Set<Parameters<Viewer['onLightSelectionChange']>[0]>();

  setCustomLighting(value: unknown) {
    this.calls.push('rig');
    this.rig = validateCustomLightingRig(value);
    // Rebuilding helpers can briefly clear the viewport selection.
    this.emitSelection(null);
  }

  setLighting() {}

  setLightingEditorState(state: Parameters<Viewer['setLightingEditorState']>[0]) {
    this.calls.push('editor');
    this.editor = state;
    this.emitSelection(state.selectedLightId);
  }

  onCustomLightingChange(listener: Parameters<Viewer['onCustomLightingChange']>[0]) {
    this.calls.push('subscribe-rig');
    this.rigListeners.add(listener);
    listener(this.rig);
    return () => { this.rigListeners.delete(listener); };
  }

  onLightSelectionChange(listener: Parameters<Viewer['onLightSelectionChange']>[0]) {
    this.calls.push('subscribe-selection');
    this.selectionListeners.add(listener);
    listener(this.editor.selectedLightId);
    return () => { this.selectionListeners.delete(listener); };
  }

  emitRig(rig: CustomLightingRig) {
    this.rig = rig;
    for (const listener of this.rigListeners) listener(rig);
  }

  emitSelection(id: string | null) {
    this.editor = { ...this.editor, selectedLightId: id };
    for (const listener of this.selectionListeners) listener(id);
  }
}

test('lighting binding seeds the current rig and selection before immediate viewer callbacks', () => {
  const initial = { ...defaultRig, exposure: 1.7 };
  const store = createLightingStore(initial);
  const canonicalRig = store.getState().rig;
  store.getState().select('spot');
  store.getState().setOpen(true);
  const viewer = new FakeLightingViewer();
  const unbind = bindLightingStore(store, viewer, CUSTOM_LIGHTING_ID);
  assert.deepEqual(viewer.calls, ['rig', 'editor', 'subscribe-rig', 'subscribe-selection']);
  assert.deepEqual(viewer.rig, initial);
  assert.equal(store.getState().rig, canonicalRig);
  assert.equal(store.getState().selectedLightId, 'spot');
  assert.equal(store.getState().canUndo, false);
  assert.deepEqual(viewer.editor, { enabled: true, selectedLightId: 'spot' });
  unbind();
});

test('lighting preview reaches the viewport without recording undo until it is committed', () => {
  const initial = defaultRig;
  const store = createLightingStore(initial);
  const viewer = new FakeLightingViewer();
  const unbind = bindLightingStore(store, viewer, CUSTOM_LIGHTING_ID);
  const preview = { ...initial, exposure: 1.8 };
  store.getState().preview(preview);
  assert.deepEqual(viewer.rig, preview);
  assert.equal(store.getState().canUndo, false);
  viewer.emitRig(preview);
  assert.equal(store.getState().canUndo, true);
  store.getState().undo();
  assert.deepEqual(viewer.rig, initial);
  assert.equal(store.getState().canUndo, false);
  assert.equal(store.getState().canRedo, true);
  unbind();
});

test('unbinding removes both viewer listeners and stops store-to-viewer updates', () => {
  const store = createLightingStore(defaultRig);
  const viewer = new FakeLightingViewer();
  const unbind = bindLightingStore(store, viewer, CUSTOM_LIGHTING_ID);
  unbind();
  assert.equal(viewer.rigListeners.size, 0);
  assert.equal(viewer.selectionListeners.size, 0);
  viewer.calls.length = 0;
  const changed = { ...store.getState().rig, exposure: 1.6 };
  store.getState().apply(changed);
  store.getState().setOpen(true);
  assert.deepEqual(viewer.calls, []);
  const snapshot = store.getState();
  viewer.emitRig({ ...changed, exposure: 2 });
  viewer.emitSelection('point');
  assert.equal(store.getState(), snapshot);
});

test('rebinding during a preview does not commit the gesture through an immediate viewer callback', () => {
  const store = createLightingStore(defaultRig);
  const viewer = new FakeLightingViewer();
  const firstUnbind = bindLightingStore(store, viewer, CUSTOM_LIGHTING_ID);
  store.getState().preview({ ...defaultRig, exposure: 1.4 });
  assert.equal(store.getState().canUndo, false);
  firstUnbind();
  const secondUnbind = bindLightingStore(store, viewer, CUSTOM_LIGHTING_ID);
  assert.equal(viewer.rig.exposure, 1.4);
  assert.equal(store.getState().canUndo, false);
  const finalRig = { ...defaultRig, exposure: 1.8 };
  store.getState().preview(finalRig);
  store.getState().apply(finalRig);
  assert.equal(store.getState().canUndo, true);
  store.getState().undo();
  assert.deepEqual(store.getState().rig, defaultRig);
  assert.deepEqual(viewer.rig, defaultRig);
  assert.equal(store.getState().canUndo, false);
  secondUnbind();
});
