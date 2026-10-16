import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import * as THREE from 'three';
import { Viewer } from '../../../src/viewer/Viewer';

test('transform-only previews reuse the mask and rebuild when the selection changes', () => {
  const material = new THREE.MeshPhongMaterial();
  const apply = vi.fn();
  const viewer = {
    transformIsolationSource: null,
    transformIsolationMaterial: material,
    materialLoadToken: 1,
    invalidate: vi.fn(),
    applyTransformIsolation: apply,
  };
  const pixels = new Uint8Array([16, 0, 0, 255]);
  const first = new THREE.Texture();
  const second = new THREE.Texture();
  const set = (texture: THREE.Texture, buckets: number[]) => Reflect.apply(
    Viewer.prototype.setTransformIsolation, viewer, [texture, pixels, 1, 1, buckets],
  );
  set(first, [1]);
  set(second, [1]);
  assert.equal(apply.mock.calls.length, 1);
  assert.equal(material.map, second);
  set(second, [2]);
  assert.equal(apply.mock.calls.length, 2);
  viewer.materialLoadToken++;
  set(second, [2]);
  assert.equal(apply.mock.calls.length, 3);
  for (const [, mask] of apply.mock.calls) mask.dispose();
  first.dispose(); second.dispose(); material.dispose();
});

test('material cancellation while waiting for the environment prevents material setup', async () => {
  let ready!: () => void;
  const envReady = new Promise<void>((resolve) => { ready = resolve; });
  const viewer = { envReady, materialLoadToken: 0, disposed: false };
  let cancelled = false;
  const pending = Reflect.apply(Viewer.prototype.applyMaterialParams, viewer, [
    {}, undefined, undefined, () => cancelled,
  ]);
  cancelled = true;
  ready();
  // This receiver deliberately has no renderer/material. A stale request must
  // return before trying to configure either resource.
  await pending;
  assert.equal(viewer.materialLoadToken, 1);
});

test('late composition retains the sticker base until editing ends', () => {
  const base = new THREE.Texture();
  const composed = new THREE.Texture();
  const material = new THREE.MeshPhongMaterial();
  const viewer = {
    material, composedMap: null, stickerEditorBaseMap: null, invalidate: vi.fn(),
    applyVisibleMap() { Reflect.apply(Reflect.get(Viewer.prototype, 'applyVisibleMap'), this, []); },
  };
  try {
    Reflect.apply(Viewer.prototype.setStickerEditorBaseMap, viewer, [base]);
    Reflect.apply(Viewer.prototype.setMap, viewer, [composed]);
    assert.equal(material.map, base);
    Reflect.apply(Viewer.prototype.setStickerEditorBaseMap, viewer, [null]);
    assert.equal(material.map, composed);
  } finally { base.dispose(); composed.dispose(); material.dispose(); }
});
