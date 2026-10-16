import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { test, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FP_PORTRAIT_FRAME_CENTER, FirstPersonPreview, bindViewmodelBones, mergeViewmodelBones, viewmodelFov, viewmodelFrameTop, type ViewmodelManifest } from '../../../src/viewer/firstPerson';
import * as materialConfig from '../../../src/viewer/materialConfig';
import { FishBonePhysics } from '../../../src/viewer/fishPhysics';
import { firstPersonAnimationGroups } from '../../../src/ui/stage/firstPersonAnimations';
import { Viewer } from '../../../src/viewer/Viewer';

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

test('first-person assets cover every paintable weapon, retain UVs, and contain every selectable animation', () => {
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
      const options = firstPersonAnimationGroups(view.clips, view.weaponKey).flatMap(group => group.options);
      const expectedClips = Object.entries(view.clips)
        .filter(([key]) => key !== 'ACT_VM_PULLBACK' || view.weaponKey === 'c_demo_cannon' || view.weaponKey === 'c_stickybomb_launcher')
        .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
      assert.deepEqual(options.map(option => option.clip).sort(), expectedClips.sort(), 'every variant is selectable');
      assert.equal(new Set(options.map(option => option.id)).size, options.length, 'selection identities are unique');
      for (const option of options) assert.ok(names.has(option.clip), `${view.weaponKey}/${view.class}: ${option.clip} exists`);
    }
  }
});

test('animation groups label alternate takes and retain unfamiliar activities', () => {
  const groups = firstPersonAnimationGroups({
    ACT_VM_HITCENTER: ['swing_a', 'swing_b', 'swing_c'],
    ACT_VM_IDLE: 'idle',
    ACT_NEW_ACTION: ['new_action'],
  });
  assert.deepEqual(groups.map(group => group.label), ['Basic', 'Attack', 'Other']);
  assert.deepEqual(groups[1].options.map(option => option.label), ['Swing 1', 'Swing 2', 'Swing 3']);
  assert.equal(groups[2].options[0].label, 'New Action');
  assert.deepEqual(firstPersonAnimationGroups({}), []);
  assert.deepEqual(firstPersonAnimationGroups({ ACT_VM_PULLBACK: 'charge' }, 'c_grenadelauncher'), []);
  assert.equal(firstPersonAnimationGroups({ ACT_VM_PULLBACK: 'charge' }, 'c_demo_cannon')[0]?.options[0]?.label, 'Charge');
  assert.equal(firstPersonAnimationGroups({ ACT_VM_PULLBACK: 'charge' }, 'c_stickybomb_launcher')[0]?.options[0]?.label, 'Charge');
});

test('tall canvases frame the whole 4:3 viewmodel view, centred or above the sheet', () => {
  // A 427x764 portrait phone canvas holds a 320.25px tall 4:3 frame.
  assert.equal(FP_PORTRAIT_FRAME_CENTER, 0.55, 'coupled to the 45dvh First Person sheet in layout.css');
  assert.ok(Math.abs((viewmodelFrameTop(427, 764, FP_PORTRAIT_FRAME_CENTER) ?? NaN) - 49.975) < 1e-9, 'lifted above the open sheet');
  assert.equal(viewmodelFrameTop(427, 764, 1), 221.875, 'centred in the whole canvas');
  assert.equal(viewmodelFrameTop(400, 310, FP_PORTRAIT_FRAME_CENTER), 0, 'never above the canvas top');
  assert.equal(viewmodelFrameTop(844, 390, 1), null, 'landscape widens the view instead');
  assert.equal(viewmodelFrameTop(800, 600, 1), null, 'exactly 4:3 is unchanged');
  assert.equal(viewmodelFrameTop(0, 844, 1), null);
  assert.equal(viewmodelFrameTop(390, 0, 1), null);

  const preview = new FirstPersonPreview();
  const { camera } = preview;
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld();
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // Canvas pixel of a point in the authored view, given as a fraction of the
  // 4:3 frame (x: -1 left to 1 right, y: 1 top to -1 bottom).
  const pixel = (x: number, y: number, width: number, height: number) => {
    const ndc = new THREE.Vector3(x * halfHeight * 4 / 3, y * halfHeight, -1).project(camera);
    return [(ndc.x + 1) / 2 * width, (1 - ndc.y) / 2 * height];
  };
  const near = (actual: number[], expected: number[], message: string) =>
    assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 1e-6), `${message}: ${actual} vs ${expected}`);

  // Sheet open: the frame spans the width and sits 49.975px from the top.
  preview.fitCamera(427, 764, true, 0, 300);
  near(pixel(-1, 1, 427, 764), [0, 49.975], 'open sheet frame top left');
  near(pixel(1, -1, 427, 764), [427, 370.225], 'open sheet frame bottom right');
  // Sheet closed: the same frame, centred.
  preview.fitCamera(427, 764, true);
  near(pixel(-1, 1, 427, 764), [0, 221.875], 'closed sheet frame top left');
  near(pixel(1, -1, 427, 764), [427, 542.125], 'closed sheet frame bottom right');
  // Outside the portrait layout a tall canvas fits the vertical FOV instead.
  preview.fitCamera(427, 764, false, 0, 300);
  assert.equal(camera.view?.enabled, false);
  assert.equal(camera.aspect, 427 / 764);

  // Landscape with the Controls slide-over: the view shifts left by its width,
  // so the frame's right edge meets the panel.
  preview.fitCamera(915, 412, false, 360);
  assert.equal(camera.aspect, 915 / 412);
  const wide = 915 / 412 * 3 / 4;
  near(pixel(wide, -1, 915, 412), [555, 412], 'shifted right edge');
  near(pixel(-wide, 1, 915, 412), [-360, 0], 'shifted left edge');
  // Both offsets compose into the one view offset.
  preview.fitCamera(427, 764, true, 100, 300);
  near(pixel(-1, 1, 427, 764), [-100, 49.975], 'composed offsets');
  // A wide canvas without an inset drops the offset.
  preview.fitCamera(915, 412, true);
  assert.equal(camera.view?.enabled, false);
  assert.equal(camera.aspect, 915 / 412);
  preview.dispose();
});

test('the live First Person view fits its camera to the inset; captures use the centred frame', async () => {
  const preview = new FirstPersonPreview();
  const render = vi.fn();
  const viewer = {
    firstPerson: preview,
    canvas: { clientWidth: 427, clientHeight: 764 },
    portraitSheetLayout: { matches: true },
    previewChildren: [],
    previewVisibility: [],
    previewLightPosition: new THREE.Vector3(),
    previewLightRotation: new THREE.Quaternion(),
    lightGroup: new THREE.Group(),
    scene: new THREE.Scene(),
    sheenMaterial: null,
    activeUnusual: null,
    renderer: { render },
  };
  const renderFirstPerson = Reflect.get(Viewer.prototype, 'renderFirstPerson');
  Reflect.apply(renderFirstPerson, viewer, [0, 300]);
  assert.equal(render.mock.calls[0][1], preview.camera);
  assert.ok(Math.abs((preview.camera.view?.offsetY ?? NaN) + 49.975) < 1e-9, 'sheet open lifts the frame');
  Reflect.apply(renderFirstPerson, viewer, [0, 0]);
  assert.equal(preview.camera.view?.offsetY, -221.875, 'sheet closed centres the frame');
  viewer.portraitSheetLayout.matches = false;
  Reflect.apply(renderFirstPerson, viewer, [0, 300]);
  assert.equal(preview.camera.view?.enabled, false, 'only the portrait layout keeps the 4:3 frame');
  preview.dispose();

  // The capture path passes no inset, whatever the live one is.
  const stop = new Error('stop after render');
  const capture = {
    contextLost: false,
    canvas: { clientWidth: 427, clientHeight: 764 },
    renderer: {
      capabilities: { maxTextureSize: 4096 },
      outputColorSpace: THREE.SRGBColorSpace,
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      getPixelRatio: () => 1,
      readRenderTargetPixels: () => { throw stop; },
    },
    scene: new THREE.Scene(),
    lightEditor: { setCaptureMode: () => {} },
    firstPerson: {},
    viewInset: { right: 0, bottom: 300 },
    applyViewInset: () => {},
    renderFirstPerson: vi.fn(),
  };
  await assert.rejects(Reflect.apply(Viewer.prototype.captureScreenshot, capture, [1]), stop);
  assert.deepEqual(capture.renderFirstPerson.mock.calls, [[0, 0]]);
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

test.each(['c_minigun', 'c_gatling_gun', 'c_tomislav', 'c_holymackerel', 'c_knife', 'c_grenadelauncher'])('%s paused pose changes, and overlays remain correct', async weaponKey => {
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
  vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async url => {
    assert.ok(url.startsWith(`${import.meta.env.BASE_URL}data/viewmodels/`), 'models use the deployment base path');
    const bytes = fs.readFileSync(path.join('public', url.slice(import.meta.env.BASE_URL.length)));
    return new GLTFLoader().parseAsync(new Uint8Array(bytes).buffer, '');
  });
  vi.spyOn(THREE.TextureLoader.prototype, 'loadAsync').mockImplementation(async url => {
    assert.ok(url.startsWith(`${import.meta.env.BASE_URL}data/viewmodels/`), 'textures use the deployment base path');
    return new THREE.Texture();
  });
  try {
    await preview.load(manifest.arms[weapon.armsKey], weapon, 'red', paint, paint, materialConfig.createTf2Uniforms(), cubemap);
    if (weaponKey === 'c_knife') {
      const attachments = JSON.parse(fs.readFileSync('public/data/effects/attachments.json', 'utf8')) as
        Record<string, Record<string, { pos: [number, number, number]; quat: [number, number, number, number]; bone: string }>>;
      const knifeAttachments = Array.from({ length: 6 }, (_, index) => attachments.c_knife[`unusual_${index}`]);
      assert.ok(knifeAttachments.every(entry => entry.bone === 'vm_weapon_bone_1'), 'knife unusual attachments retain their authored bone');
      const attachment = {
        pos: new THREE.Vector3(...knifeAttachments[0].pos),
        quat: new THREE.Quaternion(...knifeAttachments[0].quat),
        bone: knifeAttachments[0].bone,
      };
      const transform = new THREE.Matrix4();
      assert.equal(preview.resolveUnusualAnchor(0, attachment, transform), true);
      const before = attachment.pos.clone().applyMatrix4(transform);
      const inspect = weapon.clips.ACT_VM_INSPECT_IDLE;
      preview.setAnimation(Array.isArray(inspect) ? inspect[0] : inspect);
      preview.update(0.5);
      preview.resolveUnusualAnchor(0, attachment, transform);
      assert.ok(before.distanceTo(attachment.pos.clone().applyMatrix4(transform)) > 1, 'attachment follows the animated knife bone');
      const attachmentTransforms = knifeAttachments.map((entry, index) => {
        const resolved = new THREE.Matrix4();
        assert.equal(preview.resolveUnusualAnchor(index, {
          pos: new THREE.Vector3(...entry.pos),
          quat: new THREE.Quaternion(...entry.quat),
          bone: entry.bone,
        }, resolved), true);
        return resolved;
      });
      assert.ok(attachmentTransforms.every(entry => entry.equals(attachmentTransforms[0])), 'all knife attachment points follow the authored blade bone');
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
    const arms = preview.root.children[0].children[0];
    assert.equal(arms.visible, true, 'hands are visible by default');
    preview.setAppearance(false, false);
    assert.equal(arms.visible, false, 'hands can be hidden independently');
    const hiddenPose = matrices();
    preview.update(0.2);
    assert.notDeepEqual(matrices(), hiddenPose, 'hidden arms still animate the weapon');
    assert.equal(source.visible, true, 'hiding hands does not hide the weapon');
    preview.setAppearance(true, false);
    assert.equal(arms.visible, true, 'hands can be restored');
    assert.equal(preview.hasSpinningBarrel, ['c_minigun', 'c_gatling_gun'].includes(weaponKey));
    if (preview.hasSpinningBarrel) {
      preview.setAnimation(weapon.activity);
      const barrel = overlay.skeleton.bones.find(bone => bone.name === 'barrel');
      assert.ok(barrel);
      const relativeBarrel = () => preview.weaponAnchor.clone().invert().multiply(barrel.matrixWorld);
      const stopped = relativeBarrel();
      preview.setAppearance(true, true);
      preview.update(0.1);
      assert.ok(!relativeBarrel().equals(stopped), 'spin rotates the barrel relative to the weapon');
      const rotationBetween = (a: THREE.Matrix4, b: THREE.Matrix4) =>
        new THREE.Quaternion().setFromRotationMatrix(a).angleTo(new THREE.Quaternion().setFromRotationMatrix(b));
      const firstStep = relativeBarrel();
      preview.update(0.1);
      assert.ok(rotationBetween(firstStep, relativeBarrel()) > rotationBetween(stopped, firstStep), 'barrel accelerates gradually');
      for (let i = 0; i < 40; i++) preview.update(0.1);
      const fullSpeed = relativeBarrel();
      preview.update(0.1);
      assert.ok(Math.abs(rotationBetween(fullSpeed, relativeBarrel()) - 2) < 1e-5, 'speed caps at 20 radians per second');
      preview.setPlayback(true, false);
      const frozen = barrel.matrixWorld.clone();
      preview.update(0.2);
      assert.ok(barrel.matrixWorld.equals(frozen), 'pause freezes barrel spinning');
      preview.setAppearance(true, false);
      preview.setPlayback(false, false);
      const coasting = relativeBarrel();
      preview.update(0.1);
      const coastStep = rotationBetween(coasting, relativeBarrel());
      assert.ok(coastStep > 0 && coastStep < 2, 'disabling spin decelerates instead of stopping immediately');
      for (let i = 0; i < 40; i++) preview.update(0.1);
      const stoppedAgain = relativeBarrel();
      preview.update(0.1);
      assert.ok(relativeBarrel().elements.every((n, i) => Math.abs(n - stoppedAgain.elements[i]) < 1e-5), 'barrel settles to a complete stop');
    }
    if (weaponKey === 'c_grenadelauncher') {
      const chamber = overlay.skeleton.bones.find(bone => bone.name === 'procedural_chamber');
      assert.ok(chamber);
      const relativeChamber = () => preview.weaponAnchor.clone().invert().multiply(chamber.matrixWorld);
      const proceduralChamber = preview as unknown as { chamberAngle: number; chamberTarget: number };
      const idle = Array.isArray(weapon.clips.ACT_VM_IDLE) ? weapon.clips.ACT_VM_IDLE[0] : weapon.clips.ACT_VM_IDLE;
      const fire = Array.isArray(weapon.clips.ACT_VM_PRIMARYATTACK) ? weapon.clips.ACT_VM_PRIMARYATTACK[0] : weapon.clips.ACT_VM_PRIMARYATTACK;
      const reloadActivities = ['ACT_VM_RELOAD', 'ACT_RELOAD_START', 'ACT_RELOAD_FINISH'] as const;
      assert.ok(idle && fire);
      preview.setAnimation(idle); preview.update(0.5);
      const stopped = relativeChamber();
      preview.setAnimation(fire); preview.update(0.02);
      assert.ok(!relativeChamber().equals(stopped), 'fire rotates the grenade launcher chamber');
      const unfinishedTarget = proceduralChamber.chamberTarget;
      assert.ok(proceduralChamber.chamberAngle < unfinishedTarget, 'fire transition is still in progress');
      preview.setAnimation(idle); preview.update(1);
      assert.ok(Math.abs(proceduralChamber.chamberAngle - unfinishedTarget) < 1e-4, 'switching animation finishes the chamber turn');
      preview.setAnimation(fire); preview.update(0.2);
      const firstFire = proceduralChamber.chamberAngle;
      preview.update(0.6);
      assert.ok(proceduralChamber.chamberAngle > firstFire, 'repeating fire advances the grenade launcher chamber again');
      const completedTarget = proceduralChamber.chamberTarget;
      for (const activity of reloadActivities) {
        const reload = weapon.clips[activity];
        const clip = Array.isArray(reload) ? reload[0] : reload;
        assert.ok(clip, `${activity} exists`);
        preview.setAnimation(clip);
        assert.equal(proceduralChamber.chamberTarget, completedTarget, `${activity} preserves the chamber target`);
        preview.update(0.7);
        assert.equal(proceduralChamber.chamberTarget, completedTarget, `${activity} does not rotate the grenade launcher chamber`);
      }
    }
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
