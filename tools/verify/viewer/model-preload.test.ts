import { afterEach, expect, test, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ModelLoader } from '../../../src/viewer/modelLoader';

afterEach(() => vi.restoreAllMocks());

test('hover loads reuse promises and keep the displayed model in the bounded cache', async () => {
  vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async () => {
    const gltf = await new GLTFLoader().parseAsync(JSON.stringify({
      asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0,
    }), '');
    gltf.scene.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial()));
    return gltf;
  });
  const loader = new ModelLoader();
  try {
    const selected = await loader.load('selected');
    const disposeSelected = vi.spyOn(selected[0].geometry, 'dispose');
    const pending = loader.load('warm-0', 'selected');
    expect(loader.load('warm-0', 'selected')).toBe(pending);
    const first = await pending;
    const disposeFirst = vi.spyOn(first[0].geometry, 'dispose');
    for (let i = 1; i <= 8; i++) await loader.load(`warm-${i}`, 'selected');
    expect(disposeSelected).not.toHaveBeenCalled();
    expect(disposeFirst).toHaveBeenCalledOnce();
    expect(await loader.load('selected')).toBe(selected);
  } finally { loader.dispose(); }
});
