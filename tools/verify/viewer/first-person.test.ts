import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { test, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FirstPersonPreview, bindViewmodelBones, mergeViewmodelBones, viewmodelFov, type ViewmodelManifest } from '../../../src/viewer/firstPerson';
import * as materialConfig from '../../../src/viewer/materialConfig';
import { FishBonePhysics } from '../../../src/viewer/fishPhysics';

interface GlbDocument {
  materials: { name: string }[];
  animations?: { name: string }[];
  skins?: { joints: number[] }[];
  meshes: { primitives: { material: number; attributes: { TEXCOORD_0: number } }[] }[];
  accessors: { bufferView: number; byteOffset?: number; count: number; componentType: number; type: string }[];
  bufferViews: { byteOffset: number; byteStride?: number }[];
}

function readGlb(file: string) {
  const bytes = fs.readFileSync(file);
  const length = bytes.readUInt32LE(12);
  const document: GlbDocument = JSON.parse(bytes.toString('utf8', 20, 20 + length));
  return { document, binary: bytes.subarray(28 + length) };
}

function uvSet(file: string, paintMaterials: string[]): Set<string> {
  const { document, binary } = readGlb(file);
  const result = new Set<string>();
  for (const mesh of document.meshes) for (const primitive of mesh.primitives) {
    if (!paintMaterials.includes(document.materials[primitive.material].name)) continue;
    const accessor = document.accessors[primitive.attributes.TEXCOORD_0];
    assert.equal(accessor.componentType, 5126);
    assert.equal(accessor.type, 'VEC2');
    const view = document.bufferViews[accessor.bufferView];
    for (let i = 0; i < accessor.count; i++) {
      const offset = view.byteOffset + (accessor.byteOffset ?? 0) + i * (view.byteStride ?? 8);
      result.add(`${binary.readFloatLE(offset).toFixed(5)},${binary.readFloatLE(offset + 4).toFixed(5)}`);
    }
  }
  return result;
}

test('first-person assets cover every paintable weapon, retain UVs, and contain their idle/inspect clips', () => {
  const data = path.resolve('public/data');
  const catalog: { weapons: { key: string; model: string }[] } = JSON.parse(fs.readFileSync(path.join(data, 'manifest.json'), 'utf8'));
  const manifest: ViewmodelManifest = JSON.parse(fs.readFileSync(path.join(data, 'viewmodels/manifest.json'), 'utf8'));
  for (const weapon of catalog.weapons.filter(entry => entry.key !== 'paintkit_tool')) {
    const views = manifest.weapons.filter(entry => entry.weaponKey === weapon.key);
    assert.ok(views.length, `${weapon.key} has a first-person model`);
    const actual = uvSet(path.join(data, 'viewmodels', views[0].model), views[0].paintMaterials);
    const expected = uvSet(path.join(data, weapon.model), views[0].paintMaterials);
    // First-person GLBs can also contain loaded ammunition bodygroups.
    assert.ok(expected.size > 0 && [...expected].every(uv => actual.has(uv)), `${weapon.key} preserves paint UVs`);
    for (const view of views) {
      const arms = readGlb(path.join(data, 'viewmodels', manifest.arms[view.armsKey].model)).document;
      assert.ok(arms.skins?.length, `${view.armsKey} has a skeleton`);
      const names = new Set(arms.animations?.map(clip => clip.name));
      assert.ok(names.has(view.activity), `${view.weaponKey}/${view.class} idle exists`);
      for (const [key, clips] of Object.entries(view.clips)) {
        if (!key.includes('INSPECT')) continue;
        for (const clip of Array.isArray(clips) ? clips : [clips]) assert.ok(names.has(clip), `${view.class}: ${clip} exists`);
      }
    }
  }
});

test('bonemerge follows named arms bones and preserves unmatched child offsets', () => {
  const hand = new THREE.Bone(); hand.name = 'weapon_bone'; hand.position.set(10, 20, 30); hand.updateMatrixWorld();
  const weapon = new THREE.Bone(); weapon.name = hand.name;
  const attachment = new THREE.Bone(); attachment.position.set(0, 0, 5); weapon.add(attachment);
  weapon.updateMatrixWorld();
  const bindings = bindViewmodelBones([weapon, attachment], [new Map([[hand.name, hand]])]);
  mergeViewmodelBones(bindings);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(weapon.matrixWorld).toArray(), [10, 20, 30]);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(attachment.matrixWorld).toArray(), [10, 20, 35]);
  hand.position.x = 15; hand.updateMatrixWorld();
  mergeViewmodelBones(bindings);
  assert.equal(attachment.matrixWorld.elements[12], 15, 'cached bindings follow later source movement');
  assert.ok(Math.abs(viewmodelFov(90) - 73.739795) < 0.00001);
});

test.each(['c_minigun', 'c_holymackerel'])('%s materials, paused pose changes, and overlays remain correct', async weaponKey => {
  const manifest: ViewmodelManifest = JSON.parse(fs.readFileSync('public/data/viewmodels/manifest.json', 'utf8'));
  const weapon = manifest.weapons.find(entry => entry.weaponKey === weaponKey);
  assert.ok(weapon);
  const preview = new FirstPersonPreview();
  const paint = new THREE.MeshPhongMaterial();
  const overlayMaterial = new THREE.MeshBasicMaterial();
  const cubemap = new THREE.CubeTexture();
  let sharedDisposed = false;
  let paintDisposed = false;
  paint.addEventListener('dispose', () => { paintDisposed = true; });
  overlayMaterial.addEventListener('dispose', () => { sharedDisposed = true; });
  const configure = vi.spyOn(materialConfig, 'configureTf2Material');
  vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async url => {
    const bytes = fs.readFileSync(path.join('public', url));
    return new GLTFLoader().parseAsync(new Uint8Array(bytes).buffer, '');
  });
  vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(async () => new THREE.Texture());
  try {
    await preview.load(manifest.arms[weapon.armsKey], weapon, 'red', paint, paint, materialConfig.createTf2Uniforms(), cubemap);
    if (weaponKey === 'c_minigun') {
      assert.equal(configure.mock.calls.length, 2, 'both Heavy hand materials are configured');
      assert.ok(configure.mock.calls.every(([params]) => !params.detailTexture), 'sheen masks do not darken the hand albedo');
    }
    preview.setOverlay('sheen', overlayMaterial);
    const bones: THREE.Bone[] = [];
    preview.root.traverse(object => { if (object instanceof THREE.Bone) bones.push(object); });
    const matrices = () => bones.flatMap(bone => bone.matrixWorld.toArray());
    preview.update(0.1);
    const moving = matrices();
    preview.setPlayback(true, false);
    const updatePose = vi.spyOn(preview.root, 'updateMatrixWorld');
    preview.update(0.2);
    assert.equal(updatePose.mock.calls.length, 0, 'paused effects do not recalculate an unchanged pose');
    assert.deepEqual(matrices(), moving, 'pause holds the exact pose');
    preview.setView(70, true);
    preview.update(0.2);
    assert.notDeepEqual(matrices(), moving, 'minimized offsets still apply while paused');
    preview.setView(70, false);
    preview.update(0.2);
    assert.deepEqual(matrices(), moving, 'restoring offsets retains the frozen animation');
    if (weaponKey === 'c_holymackerel') {
      preview.setPlayback(false, true);
      for (let i = 0; i < 20; i++) preview.update(1 / 60);
      preview.setPlayback(true, true);
      const bent = matrices();
      preview.update(0.2);
      assert.deepEqual(matrices(), bent, 'paused fish retains its bend without recalculating');
      preview.setPlayback(true, false);
      preview.update(0.2);
      assert.notDeepEqual(matrices(), bent, 'disabling physics while paused restores the authored bones');
    }
    preview.setPlayback(false, false);
    preview.update(0.2);
    assert.notDeepEqual(matrices(), moving, 'resume advances the same animation');
    const overlay = preview.overlays.sheen[0];
    let source: THREE.SkinnedMesh | undefined;
    preview.root.traverse(object => {
      if (object instanceof THREE.SkinnedMesh && object.material === paint && object.geometry === overlay.geometry) source = object;
    });
    assert.ok(source);
    assert.equal(overlay.skeleton, source.skeleton);
    assert.ok(overlay.getVertexPosition(0, new THREE.Vector3()).distanceTo(source.getVertexPosition(0, new THREE.Vector3())) < 1e-9);
    assert.deepEqual(preview.weaponAnchor.elements, overlay.skeleton.bones[0].matrixWorld.elements);
    preview.dispose();
    assert.equal(sharedDisposed, false, 'preview disposal does not dispose shared pass materials');
    assert.equal(paintDisposed, false, 'preview disposal preserves the inspect paint material');
  } finally {
    preview.dispose(); vi.restoreAllMocks(); paint.dispose(); overlayMaterial.dispose(); cubemap.dispose();
  }
});

test('fish physics bends within authored limits, freezes, and resets', () => {
  const manifest: ViewmodelManifest = JSON.parse(fs.readFileSync('public/data/viewmodels/manifest.json', 'utf8'));
  const fish = manifest.weapons.find(entry => entry.weaponKey === 'c_holymackerel');
  assert.equal(fish?.jiggleBones?.length, 4);
  const settings = fish?.jiggleBones?.[0];
  assert.ok(settings);
  const bone = new THREE.Bone(); bone.name = settings.name;
  const physics = new FishBonePhysics(new Map([[bone.name, bone]]), [settings]);
  let bent = false;
  for (let frame = 0; frame < 180; frame++) {
    bone.rotation.y = Math.sin(frame / 20) * 0.4;
    bone.updateMatrixWorld(true);
    const goal = new THREE.Vector3().setFromMatrixColumn(bone.matrixWorld, 2);
    physics.update(1 / 60);
    const actual = new THREE.Vector3().setFromMatrixColumn(bone.matrixWorld, 2);
    const angle = goal.angleTo(actual);
    assert.ok(Number.isFinite(angle) && angle <= settings.angleLimit + 1e-6);
    bent ||= angle > 0.01;
  }
  assert.ok(bent, 'bone responds to movement and gravity');
  const frozen = bone.matrixWorld.clone();
  bone.updateMatrixWorld(true); physics.update(0);
  assert.ok(bone.matrixWorld.elements.every((value, i) => Math.abs(value - frozen.elements[i]) < 1e-12));
  physics.reset(); bone.updateMatrixWorld(true);
  const authored = bone.matrixWorld.clone();
  physics.update(0);
  assert.deepEqual(bone.matrixWorld.elements, authored.elements);
});
