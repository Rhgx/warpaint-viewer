import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import * as THREE from 'three';
import { Viewer } from '../../../src/viewer/Viewer';
import { TransformIsolation } from '../../../src/viewer/transformIsolation';
import { MaterialTextures } from '../../../src/viewer/materialTextures';
import type { WeaponMaterial } from '../../../src/data/types';

test('transform-only previews reuse the mask and rebuild when the selection changes', () => {
  const material = new THREE.MeshPhongMaterial();
  const centerGroup = new THREE.Group();
  const paintable = [new THREE.Mesh(new THREE.BufferGeometry())];
  let materialLoadToken = 1;
  const isolation = new TransformIsolation({
    centerGroup,
    material,
    contextOpacity: { value: 1 },
    getPaintableMeshes: () => paintable,
    getMaterialLoadToken: () => materialLoadToken,
    invalidate: vi.fn(),
  });
  const viewer = { transformIsolation: isolation };
  const pixels = new Uint8Array([16, 0, 0, 255]);
  const first = new THREE.Texture();
  const second = new THREE.Texture();
  const set = (texture: THREE.Texture, buckets: number[]) => Reflect.apply(
    Viewer.prototype.setTransformIsolation, viewer, [texture, pixels, 1, 1, buckets],
  );
  // A rebuild replaces the isolated mesh, so its identity shows whether one ran.
  const isolatedMesh = (): THREE.Mesh => {
    const mesh = centerGroup.children[0];
    if (!(mesh instanceof THREE.Mesh)) throw new Error('expected the isolated mesh');
    return mesh;
  };
  const isolatedPaint = (): THREE.Texture | null => {
    const paint = isolatedMesh().material;
    if (!(paint instanceof THREE.MeshPhongMaterial)) throw new Error('expected the isolated paint material');
    return paint.map;
  };
  set(first, [1]);
  const firstMesh = isolatedMesh();
  set(second, [1]);
  assert.equal(isolatedMesh(), firstMesh);
  assert.equal(isolatedPaint(), second);
  set(second, [2]);
  assert.notEqual(isolatedMesh(), firstMesh);
  const secondMesh = isolatedMesh();
  materialLoadToken++;
  set(second, [2]);
  assert.notEqual(isolatedMesh(), secondMesh);
  isolation.clearTransformIsolation();
  first.dispose(); second.dispose(); material.dispose();
});

test('material cancellation while waiting for the environment prevents material setup', async () => {
  let ready!: () => void;
  const envReady = new Promise<void>((resolve) => { ready = resolve; });
  let materialLoadToken = 0;
  let cancelled = false;
  // Every resource is a throwing getter, so a stale request must return before touching any of them.
  const untouched = (name: string): never => { throw new Error(`${name} was touched by a stale material load`); };
  const textures = new MaterialTextures({
    get material() { return untouched('material'); },
    get tf2Uniforms() { return untouched('tf2Uniforms'); },
    get renderer() { return untouched('renderer'); },
    get emissive() { return untouched('emissive'); },
    getEnvReady: () => envReady,
    getDefaultEnvMap: () => untouched('defaultEnvMap'),
    setMaterialEnvMap: () => untouched('setMaterialEnvMap'),
    setMaterialRimLight: () => untouched('setMaterialRimLight'),
    syncMaterialRimLight: () => untouched('syncMaterialRimLight'),
    nextMaterialLoadToken: () => ++materialLoadToken,
    getMaterialLoadToken: () => materialLoadToken,
    isDisposed: () => false,
    invalidate: () => untouched('invalidate'),
  });
  const material: WeaponMaterial = {
    phongExponent: null, phongBoost: 1, envmapTint: [1, 1, 1], normalMap: null, phong: false, phongExponentFactor: null,
  };
  const pending = textures.applyMaterialParams(material, (ref) => ref, async () => null, () => cancelled);
  cancelled = true;
  ready();
  await pending;
  assert.equal(materialLoadToken, 1);
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
