import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { test, vi } from 'vitest';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { FP_PORTRAIT_FRAME_CENTER, FirstPersonPreview, bindViewmodelBones, mergeViewmodelBones, viewmodelFov, viewmodelFrameTop, type ViewmodelManifest } from '../../../src/viewer/firstPerson/firstPerson';
import * as materialConfig from '../../../src/viewer/materialConfig';
import { FishBonePhysics } from '../../../src/viewer/firstPerson/fishPhysics';
import { advanceTimeline, createTimeline, locateOnTimeline, timelineBoundaries } from '../../../src/viewer/firstPerson/animationTimeline';
import { firstPersonAnimationGroups, formatPlaybackTime } from '../../../src/ui/stage/firstPersonAnimations';

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
  const armsByKey = new Map<string, GlbDocument>();
  for (const weapon of catalog.weapons.filter(entry => entry.key !== 'paintkit_tool')) {
    const views = manifest.weapons.filter(entry => entry.weaponKey === weapon.key);
    assert.ok(views.length, `${weapon.key} has a first-person model`);
    const actual = uvSet(path.join(data, 'viewmodels', views[0].model), views[0].paintMaterials);
    const expected = uvSet(path.join(data, weapon.model), views[0].paintMaterials);
    // First-person GLBs can also contain loaded ammunition bodygroups.
    assert.ok(expected.size > 0 && [...expected].every(uv => actual.has(uv)), `${weapon.key} preserves paint UVs`);
    for (const view of views) {
      // Arms files are several MB each and shared by many views, so each is parsed once.
      let arms = armsByKey.get(view.armsKey);
      if (!arms) {
        arms = readGlb(path.join(data, 'viewmodels', manifest.arms[view.armsKey].model)).document;
        armsByKey.set(view.armsKey, arms);
      }
      assert.ok(arms.skins?.length, `${view.armsKey} has a skeleton`);
      const names = new Set(arms.animations?.map(clip => clip.name));
      assert.ok(names.has(view.activity), `${view.weaponKey}/${view.class} idle exists`);
      const options = firstPersonAnimationGroups(view.clips, view.weaponKey).flatMap(group => group.options);
      const expectedClips = Object.entries(view.clips)
        .filter(([key]) => key !== 'ACT_VM_PULLBACK' || view.weaponKey === 'c_demo_cannon' || view.weaponKey === 'c_stickybomb_launcher')
        .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
      assert.deepEqual(options.flatMap(option => option.clips).sort(), expectedClips.sort(), 'every variant is selectable');
      assert.equal(new Set(options.map(option => option.id)).size, options.length, 'selection identities are unique');
      for (const clip of options.flatMap(option => option.clips)) assert.ok(names.has(clip), `${view.weaponKey}/${view.class}: ${clip} exists`);
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

test('start, loop and end clips merge into one entry, and nothing else does', () => {
  const options = (clips: Record<string, string | string[]>) => firstPersonAnimationGroups(clips).flatMap(group => group.options);
  const inspect = { ACT_VM_INSPECT_START: 'start', ACT_VM_INSPECT_IDLE: ['loop'], ACT_VM_INSPECT_END: 'end' };
  assert.deepEqual(options(inspect), [{ id: 'ACT_VM_INSPECT_IDLE:0', clips: ['start', 'loop', 'end'], group: 'Basic', label: 'Inspect' }]);
  assert.deepEqual(
    options({ ACT_RELOAD_START: 'a', ACT_VM_RELOAD: 'b', ACT_RELOAD_FINISH: 'c' }),
    [{ id: 'ACT_VM_RELOAD:0', clips: ['a', 'b', 'c'], group: 'Basic', label: 'Reload' }],
  );
  assert.deepEqual(
    options({ ACT_BACKSTAB_VM_UP: 'a', ACT_BACKSTAB_VM_IDLE: 'b', ACT_BACKSTAB_VM_DOWN: 'c' }),
    [{ id: 'ACT_BACKSTAB_VM_IDLE:0', clips: ['a', 'b', 'c'], group: 'Special', label: 'Backstab' }],
  );
  assert.deepEqual(options({ ACT_VM_RELOAD: 'mag' }), [{ id: 'ACT_VM_RELOAD:0', clips: ['mag'], group: 'Basic', label: 'Reload' }], 'a Reload with no start or end loops on its own');
  assert.deepEqual(options({ ACT_VM_RELOAD: 'b', ACT_RELOAD_START: 'a' }).map(option => option.label), ['Reload Start', 'Reload'], 'a partial sequence stays apart');
  assert.deepEqual(
    options({ ACT_MP_ATTACK_STAND_PREFIRE: 'up', ACT_VM_SECONDARYATTACK: 'spin', ACT_MP_ATTACK_STAND_POSTFIRE: 'down' }).map(option => option.label),
    ['Secondary Attack', 'Spin Up', 'Spin Down'],
    'the minigun moves between its loops, so its clips stay apart',
  );

  const manifest: ViewmodelManifest = JSON.parse(fs.readFileSync('public/data/viewmodels/manifest.json', 'utf8'));
  const counts = { Inspect: 0, Reload: 0, Backstab: 0, 'plain Reload': 0 };
  for (const weapon of manifest.weapons) {
    const groups = firstPersonAnimationGroups(weapon.clips, weapon.weaponKey);
    for (const group of groups) {
      assert.ok(group.options.length > 1 || group.options[0].label !== group.label, `${weapon.weaponKey}: no heading only repeats its one entry`);
    }
    for (const option of groups.flatMap(group => group.options)) {
      if (option.clips.length === 3) counts[option.label as 'Inspect' | 'Reload' | 'Backstab'] += 1;
      if (option.clips.length === 1 && option.label === 'Reload') counts['plain Reload'] += 1;
    }
  }
  assert.deepEqual(counts, { Inspect: manifest.weapons.length, Reload: 21, Backstab: 1, 'plain Reload': 8 });
});

test('a timeline position maps to a clip, a local time and a blend', () => {
  const timeline = createTimeline([1, 2, 3]);
  assert.equal(timeline.total, 6);
  assert.deepEqual(locateOnTimeline(timeline, 0), { index: 0, local: 0, blend: 1 }, 'the first clip has nothing to fade from');
  assert.deepEqual(locateOnTimeline(timeline, 0.5), { index: 0, local: 0.5, blend: 1 });
  assert.deepEqual(locateOnTimeline(timeline, 1), { index: 1, local: 0, blend: 0 }, 'a boundary shows the end of the clip before it');
  assert.deepEqual(locateOnTimeline(timeline, 1.125), { index: 1, local: 0.125, blend: 0.625 });
  assert.deepEqual(locateOnTimeline(timeline, 2.5), { index: 1, local: 1.5, blend: 1 });
  assert.deepEqual(locateOnTimeline(timeline, 3), { index: 2, local: 0, blend: 0 });
  assert.deepEqual(locateOnTimeline(timeline, 6), { index: 2, local: 3, blend: 1 }, 'the end shows the last pose and does not wrap');
  assert.deepEqual(locateOnTimeline(timeline, 7), { index: 2, local: 3, blend: 1 }, 'beyond the end clamps');
  assert.deepEqual(locateOnTimeline(timeline, -1), { index: 0, local: 0, blend: 1 }, 'before the start clamps');

  const single = createTimeline([2]);
  assert.deepEqual(locateOnTimeline(single, 2), { index: 0, local: 2, blend: 1 });
  assert.deepEqual(locateOnTimeline(createTimeline([0.1, 1]), 0.1), { index: 1, local: 0, blend: 0 });
  assert.equal(locateOnTimeline(createTimeline([1, 0.125]), 1.0625).blend, 0.5, 'a clip shorter than the blend still finishes fading in');
  assert.deepEqual(locateOnTimeline(createTimeline([]), 1), { index: 0, local: 0, blend: 1 });
  assert.deepEqual(locateOnTimeline(createTimeline([0]), 0), { index: 0, local: 0, blend: 1 }, 'an empty clip does not divide by zero');
});

test('a timeline knows the stretch that repeats', () => {
  assert.deepEqual(createTimeline([1, 2, 4], 1), { durations: [1, 2, 4], total: 7, loopStart: 1, loopEnd: 3 });
  assert.deepEqual(createTimeline([2]), { durations: [2], total: 2, loopStart: 0, loopEnd: 2 }, 'a single clip repeats whole');
  assert.deepEqual(createTimeline([]), { durations: [], total: 0, loopStart: 0, loopEnd: 0 });
});

test('a timeline marks where each clip after the first begins', () => {
  assert.deepEqual(timelineBoundaries(createTimeline([1, 2, 3])), [1, 3]);
  assert.deepEqual(timelineBoundaries(createTimeline([2])), [], 'a single clip has none');
  assert.deepEqual(timelineBoundaries(createTimeline([])), []);
});

test('looping holds the middle of a sequence, and a single clip repeats whole', () => {
  const sequence = createTimeline([1, 2, 4], 1);
  const advance = (position: number, delta: number) => advanceTimeline(sequence, position, delta);
  const moved = (position: number, wraps = 0) => ({ position, wraps, ended: false });
  assert.deepEqual(advance(0.5, 0.25), moved(0.75), 'the intro plays');
  assert.deepEqual(advance(0.75, 0.5), moved(1.25), 'and runs on into the loop');
  assert.deepEqual(advance(2.75, 0.5), moved(1.25, 1), 'the loop turns at its end and skips the outro');
  assert.deepEqual(advance(2.75, 0.25), moved(1, 1), 'landing exactly on the end of the loop turns too');
  assert.deepEqual(advance(1, 5.5), moved(2.5, 2), 'a long delta counts each turn');
  assert.deepEqual(advance(3, 0.25), moved(3.25), 'scrubbed to the outro, it plays');
  assert.deepEqual(advance(6.75, 0.5), moved(1.25, 1), 'and hands over to the loop at the end');
  assert.deepEqual(advance(7, 0.25), moved(1.25, 1), 'from the very end too');

  assert.deepEqual(advanceTimeline(createTimeline([2]), 1.75, 0.5), moved(0.25, 1), 'a single clip wraps to its start');
  assert.deepEqual(advanceTimeline(createTimeline([2]), 2, 0.25), moved(0.25, 1));
  assert.deepEqual(advanceTimeline(createTimeline([1]), 0.5, 3), moved(0.5, 3));
  assert.deepEqual(advanceTimeline(createTimeline([0, 1, 0], 2), 1, 0.5), moved(1), 'an empty loop stands still');
  assert.deepEqual(advanceTimeline(createTimeline([]), 0, 1), moved(0));
});

test('with looping off a sequence plays through and stops on its last frame', () => {
  const sequence = createTimeline([1, 2, 4], 1);
  assert.deepEqual(advanceTimeline(sequence, 2.75, 0.5, false), { position: 3.25, wraps: 0, ended: false }, 'it runs past the loop into the outro');
  assert.deepEqual(advanceTimeline(sequence, 6.75, 0.5, false), { position: 7, wraps: 0, ended: true });
  assert.deepEqual(advanceTimeline(sequence, 6.75, 0.25, false), { position: 7, wraps: 0, ended: true }, 'landing exactly on the end stops too');
  assert.deepEqual(advanceTimeline(createTimeline([2]), 1.75, 0.5, false), { position: 2, wraps: 0, ended: true });
});

test('standing still changes nothing', () => {
  const sequence = createTimeline([1, 2, 4], 1);
  assert.deepEqual(advanceTimeline(sequence, 7, 0), { position: 7, wraps: 0, ended: false }, 'a paused scrub stays on the very end');
  assert.deepEqual(advanceTimeline(sequence, 7, 0, false), { position: 7, wraps: 0, ended: false });
  assert.deepEqual(advanceTimeline(sequence, 3, 0), { position: 3, wraps: 0, ended: false });
});

test('playback time reads as minutes, seconds and tenths, all the same width', () => {
  assert.equal(formatPlaybackTime(0), '0:00.0');
  assert.equal(formatPlaybackTime(1.25), '0:01.2');
  assert.equal(formatPlaybackTime(2.3), '0:02.3', 'binary noise does not round it down');
  assert.equal(formatPlaybackTime(9.99), '0:09.9');
  assert.equal(formatPlaybackTime(12.5), '0:12.5');
  assert.equal(formatPlaybackTime(59.96), '0:59.9');
  assert.equal(formatPlaybackTime(61), '1:01.0');
  assert.equal(formatPlaybackTime(-1), '0:00.0');
});

test('tall canvases frame the whole 4:3 viewmodel view above the sheet', () => {
  // A 427x764 portrait phone canvas holds a 320.25px tall 4:3 frame.
  assert.ok(Math.abs((viewmodelFrameTop(427, 764, FP_PORTRAIT_FRAME_CENTER) ?? NaN) - 49.975) < 1e-9, 'lifted above the open sheet');
  assert.equal(viewmodelFrameTop(400, 310, FP_PORTRAIT_FRAME_CENTER), 0, 'never above the canvas top');
  assert.equal(viewmodelFrameTop(844, 390, 1), null, 'landscape widens the view instead');

  const preview = new FirstPersonPreview();
  const { camera } = preview;
  camera.position.set(0, 0, 0);
  camera.updateMatrixWorld();
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // Canvas pixel of a corner of the authored 4:3 frame (x: -1 left, y: 1 top).
  const pixel = (x: number, y: number) => {
    const ndc = new THREE.Vector3(x * halfHeight * 4 / 3, y * halfHeight, -1).project(camera);
    return [(ndc.x + 1) / 2 * 427, (1 - ndc.y) / 2 * 764];
  };
  preview.fitCamera(427, 764, true, 0, 300);
  for (const [actual, expected] of [[pixel(-1, 1), [0, 49.975]], [pixel(1, -1), [427, 370.225]]]) {
    assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 1e-6), `${actual} vs ${expected}`);
  }
  preview.dispose();
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

test.each(['c_minigun', 'c_holymackerel', 'c_knife', 'c_grenadelauncher'])('%s paused pose changes, and overlays remain correct', async weaponKey => {
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
    assert.equal(preview.weaponKey, weaponKey);
    const clockBone = preview.statClockBone;
    assert.ok(clockBone, 'the viewmodel has a bone for the Stat Clock');
    const scene = new THREE.Scene();
    scene.add(preview.root);
    const hanging = new THREE.Group();
    hanging.position.set(1, 2, 3);
    clockBone.add(hanging);
    const followsBone = () => {
      // What a render does first, which is what places anything hanging from a merged bone.
      scene.updateMatrixWorld();
      const expected = clockBone.matrixWorld.clone().multiply(hanging.matrix);
      assert.ok(hanging.matrixWorld.equals(expected), 'what hangs from the clock bone follows it');
      return hanging.matrixWorld.clone();
    };
    const clockAtStart = followsBone();
    const animated = weapon.clips.ACT_VM_INSPECT_START;
    preview.setAnimation(Array.isArray(animated) ? animated[0] : animated);
    preview.update(0.5);
    assert.equal(preview.animationDelta, 0.5, 'the clock face runs on the time the animation moved');
    assert.ok(!followsBone().equals(clockAtStart), 'and moves with the animation');
    preview.setPlayback(true, false);
    preview.update(0.5);
    assert.equal(preview.animationDelta, 0, 'and a pause holds it');
    preview.setPlayback(false, false);
    hanging.removeFromParent();
    scene.remove(preview.root);
    preview.setAnimation(weapon.activity);
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
    const heldPosition = preview.playbackPosition;
    preview.seek(preview.playbackDuration / 2);
    preview.update(0.2);
    const scrubbed = matrices();
    assert.notDeepEqual(scrubbed, moving, 'a paused scrub moves the pose');
    assert.equal(preview.playbackPosition, preview.playbackDuration / 2, 'a paused scrub stays where it was put');
    updatePose.mockClear();
    preview.update(0.2);
    assert.equal(updatePose.mock.calls.length, 0, 'a paused scrub does not keep recalculating');
    preview.seek(preview.playbackDuration + 5);
    assert.equal(preview.playbackPosition, preview.playbackDuration, 'a scrub stops at the end');
    preview.update(0.2);
    assert.equal(preview.playbackPosition, preview.playbackDuration, 'a paused scrub to the end does not wrap');
    preview.seek(heldPosition);
    preview.update(0.2);
    assert.deepEqual(matrices(), moving, 'scrubbing back lands on the same pose');
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
    assert.equal(preview.animationPlaying, true);
    preview.setScrubbing(true);
    assert.equal(preview.animationPlaying, false, 'a drag holds the animation so that frames can sleep');
    const beforeDrag = preview.playbackPosition;
    preview.update(0.2);
    assert.equal(preview.playbackPosition, beforeDrag, 'a drag does not advance');
    preview.setScrubbing(false);
    preview.update(0.1);
    assert.ok(Math.abs(preview.playbackPosition - beforeDrag - 1 / 60) < 1e-9, 'the time asleep does not count on resuming');
    preview.update(0.05);
    assert.ok(Math.abs(preview.playbackPosition - beforeDrag - 1 / 60 - 0.05) < 1e-9, 'later frames count in full');
    preview.setPlayback(false, false, 0.25);
    const quarterStart = preview.playbackPosition;
    preview.update(0.04);
    assert.ok(Math.abs(preview.playbackPosition - quarterStart - 0.01) < 1e-9, 'speed scales the rate');
    preview.setPlayback(false, false);
    preview.update(0.2);
    assert.notDeepEqual(matrices(), moving, 'resume advances the same animation');
    const single = preview.playbackDuration;
    assert.deepEqual(preview.playbackMarkers, [], 'a single clip has no ticks');
    assert.equal(!preview.playbackLoopRange, true, 'and marks no loop');
    preview.setPlayback(false, false, 1, false);
    preview.seek(single - 0.01);
    preview.update(0.05);
    assert.equal(preview.playbackPosition, single, 'with looping off it stops on the last frame');
    assert.equal(preview.animationPlaying, false, 'and stops rendering');
    assert.equal(preview.playbackEnded, true);
    preview.update(0.05);
    assert.equal(preview.playbackPosition, single, 'and stays there');
    preview.setPlayback(true, false, 1, false);
    assert.equal(preview.playbackEnded, true, 'the bar hearing of it changes nothing');
    preview.setPlayback(false, false, 1, false);
    assert.equal(preview.playbackPosition, 0, 'playing again starts over');
    assert.equal(preview.playbackEnded, false);
    preview.update(0.05);
    assert.ok(preview.playbackPosition > 0);
    preview.setPlayback(false, false);
    preview.seek(single - 0.01);
    preview.update(0.05);
    assert.ok(preview.playbackPosition < 0.05, 'with looping on it wraps');
    assert.equal(preview.animationPlaying, true);
    const [start, loop, end] = ['ACT_VM_INSPECT_START', 'ACT_VM_INSPECT_IDLE', 'ACT_VM_INSPECT_END'].map(key => [weapon.clips[key]].flat()[0]);
    preview.setAnimation(start, loop, end);
    assert.equal(preview.playbackPosition, 0, 'a new animation starts at the beginning');
    assert.ok(preview.playbackDuration > single, 'the timeline spans the whole sequence');
    assert.equal(preview.playbackMarkers.length, 2, 'a tick where each later clip begins');
    const range = preview.playbackLoopRange;
    assert.ok(range, 'a sequence marks the part that repeats');
    assert.deepEqual([range.start, range.end], [...preview.playbackMarkers], 'and its ticks sit at each end of it');
    preview.setPlayback(false, false);
    preview.seek(range.end - 0.01);
    preview.update(0.05);
    assert.ok(preview.playbackPosition >= range.start && preview.playbackPosition < range.start + 0.1, 'looping returns to the start of the loop, not the intro');
    preview.seek(range.end - 0.01);
    preview.setPlayback(false, false, 1, false);
    preview.update(0.05);
    assert.ok(preview.playbackPosition > range.end, 'with Loop off the same moment runs on into the outro');
    preview.seek(preview.playbackDuration - 0.01);
    preview.update(0.05);
    assert.equal(preview.playbackEnded, true, 'and stops at the very end');
    preview.setPlayback(false, false);
    assert.equal(preview.playbackPosition, 0, 'playing it again starts before the loop, even with Loop back on');
    preview.update(0);
    preview.setPlayback(true, false);
    const atStart = matrices();
    const inspectClips = preview as unknown as { timeline: { durations: number[] } };
    const [startLength, loopLength] = inspectClips.timeline.durations;
    preview.seek(startLength + loopLength / 2);
    preview.update(0);
    const midLoop = matrices();
    assert.notDeepEqual(midLoop, atStart, 'a scrub reaches into the loop');
    preview.setAnimation(start);
    preview.seek(startLength);
    preview.update(0);
    const startOnlyEnd = matrices();
    preview.setAnimation(start, loop, end);
    preview.seek(startLength);
    preview.update(0);
    assert.deepEqual(matrices(), startOnlyEnd, 'a boundary shows the end pose of the clip before it');
    preview.setPlayback(false, false);
    preview.setAnimation(weapon.activity);
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
    assert.equal(preview.hasSpinningBarrel, weaponKey === 'c_minigun');
    if (preview.hasSpinningBarrel) {
      preview.setAnimation(weapon.activity);
      const barrel = overlay.skeleton.bones.find(bone => bone.name === 'barrel');
      assert.ok(barrel);
      const relativeBarrel = () => preview.weaponAnchor.clone().invert().multiply(barrel.matrixWorld);
      const stopped = relativeBarrel();
      preview.setAppearance(true, true);
      preview.update(0.1);
      assert.ok(!relativeBarrel().equals(stopped), 'spin rotates the barrel relative to the weapon');
      preview.setPlayback(true, false);
      const frozen = barrel.matrixWorld.clone();
      preview.update(0.2);
      assert.ok(barrel.matrixWorld.equals(frozen), 'pause freezes barrel spinning');
      preview.setAppearance(true, false);
      preview.setPlayback(false, false);
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
