// Touch gesture contract for the inspect camera: one finger rotates, two fingers
// pan and pinch, later fingers are ignored, and only clean taps reset.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { validateCustomLightingRig, type CustomLightingRig } from '../../../src/viewer/lighting/customLighting';
import { LightEditor } from '../../../src/viewer/lighting/lightEditor';
import {
  InspectControls,
  isInspectDoubleTap,
  touchPairDelta,
  touchPairSnapshot,
} from '../../../src/viewer/inspectControls';

// Just enough of a canvas for the camera and light editor: listeners, size and
// pointer capture. Capture follows the browser: setPointerCapture can refuse,
// and every release or loss emits lostpointercapture (synchronously here,
// which is stricter than the browser's deferred dispatch).
class FakeCanvas extends EventTarget {
  style = { touchAction: '', cursor: '' };
  clientHeight = 600;
  captured = new Set<number>();
  refuseCapture = false;
  getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 600 }; }
  setPointerCapture(id: number) {
    if (this.refuseCapture) throw new Error('NotFoundError');
    this.captured.add(id);
  }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) {
    if (this.captured.delete(id)) emit(this, 'lostpointercapture', { pointerId: id });
  }
  /** Capture taken away by the browser or another element. */
  loseCapture(id: number) { this.releasePointerCapture(id); }
}

let now = 1_000;
let canvas: FakeCanvas;
let model: THREE.Group;
let controls: InspectControls;
// Fingers on the glass; the first of a session is the primary pointer.
const active = new Set<number>();
const MOUSE = 99;

beforeEach(() => {
  now = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), {
    hidden: false,
    pointerLockElement: null,
    querySelector: () => null,
    // The light editor draws its aim marker into a 2D canvas; none is needed here.
    createElement: () => ({ width: 0, height: 0, getContext: () => null }),
  }));
  canvas = new FakeCanvas();
  model = new THREE.Group();
  controls = new InspectControls(
    new THREE.PerspectiveCamera(50, 1, 0.01, 100),
    model,
    canvas as unknown as HTMLElement,
  );
  controls.setFraming(5, 1);
  active.clear();
});

afterEach(() => {
  controls.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function emit(target: EventTarget, type: string, props: object) {
  target.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), props));
}

// Pointer events reach the canvas, then bubble to window; a release also
// drops the implicit capture as the browser does.
interface FakePointer {
  pointerId: number;
  pointerType: 'touch' | 'mouse';
  isPrimary: boolean;
  clientX: number;
  clientY: number;
  button: number;
  buttons: number;
  shiftKey: boolean;
}

function dispatchPointer(type: string, props: FakePointer) {
  emit(canvas, type, props);
  emit(window, type, props);
  if ((type === 'pointerup' || type === 'pointercancel') && canvas.captured.has(props.pointerId)) {
    canvas.loseCapture(props.pointerId);
  }
}

function pointer(type: string, pointerId: number, clientX: number, clientY: number) {
  const isPrimary = type === 'pointerdown' ? active.size === 0 : false;
  if (type === 'pointerdown') active.add(pointerId);
  if (type === 'pointerup' || type === 'pointercancel') active.delete(pointerId);
  dispatchPointer(type, {
    pointerId, pointerType: 'touch', isPrimary, clientX, clientY,
    button: type === 'pointermove' ? -1 : 0, buttons: 1, shiftKey: false,
  });
}

const down = (id: number, x: number, y: number) => pointer('pointerdown', id, x, y);
const move = (id: number, x: number, y: number) => pointer('pointermove', id, x, y);
const up = (id: number, x: number, y: number) => pointer('pointerup', id, x, y);
function tap(id: number, x: number, y: number) {
  down(id, x, y);
  now += 60;
  up(id, x, y);
}

function mouse(type: string, clientX: number, clientY: number, button = 0) {
  dispatchPointer(type, {
    pointerId: MOUSE, pointerType: 'mouse', isPrimary: true, clientX, clientY,
    button: type === 'pointermove' ? -1 : button, buttons: 1, shiftKey: false,
  });
}

function mouseDrag(button: number, from: [number, number], to: [number, number]) {
  mouse('pointerdown', from[0], from[1], button);
  mouse('pointermove', to[0], to[1]);
  mouse('pointerup', to[0], to[1], button);
}

const pose = () => ({
  yaw: model.rotation.y,
  pitch: model.rotation.x,
  panX: model.position.x,
  panY: model.position.y,
  dist: controls.getInspectDistance(),
});

function assertPoseEqual(actual: ReturnType<typeof pose>, expected: ReturnType<typeof pose>, message: string) {
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${message} (${key}: ${actual[key]} vs ${expected[key]})`);
  }
}

/** Advance the frame loop and report whether any inertia moved the model. */
function flings(): boolean {
  const before = model.rotation.y;
  controls.update(0.05);
  return model.rotation.y !== before;
}

test('pure two-finger math', () => {
  const a = touchPairSnapshot({ x: 100, y: 100 }, { x: 200, y: 100 });
  assert.deepEqual(a, { x: 150, y: 100, distance: 100 });
  const b = touchPairSnapshot({ x: 80, y: 110 }, { x: 240, y: 110 });
  const delta = touchPairDelta(a, b);
  assert.equal(delta.dx, 10);
  assert.equal(delta.dy, 10);
  assert.equal(delta.distanceScale, 100 / 160, 'spreading the fingers moves the camera closer');
  const pinched = touchPairSnapshot({ x: 50, y: 50 }, { x: 50, y: 50 });
  assert.equal(touchPairDelta(pinched, a).distanceScale, 1, 'zero-spread baseline cannot divide by zero');
  assert.equal(touchPairDelta(a, pinched).distanceScale, 1, 'zero-spread target cannot zoom to zero');
});

test('pure double-tap pairing', () => {
  assert.equal(isInspectDoubleTap({ clientX: 0, clientY: 0, time: 0 }, { clientX: 20, clientY: 10, time: 300 }), true);
  assert.equal(isInspectDoubleTap({ clientX: 0, clientY: 0, time: 0 }, { clientX: 0, clientY: 0, time: 400 }), false, 'outside the window');
  assert.equal(isInspectDoubleTap({ clientX: 0, clientY: 0, time: 0 }, { clientX: 90, clientY: 0, time: 100 }), false, 'too far apart');
});

test('1 -> 2 -> 1 -> 0 fingers never jumps the pose', () => {
  down(1, 100, 100);
  move(1, 120, 100);
  const rotated = pose();
  assert.ok(rotated.yaw > 0, 'one finger rotates');

  down(2, 220, 100);
  assertPoseEqual(pose(), rotated, 'adding a finger keeps the pose');
  assert.equal(flings(), false, 'entering two-finger mode drops rotational inertia');

  move(1, 110, 100);
  move(2, 230, 100);
  const pinched = pose();
  assert.ok(pinched.dist < rotated.dist, 'spreading the fingers zooms in');
  assert.equal(pinched.yaw, rotated.yaw, 'two fingers never rotate');

  up(2, 230, 100);
  assertPoseEqual(pose(), pinched, 'lifting to one finger keeps the pose');
  move(1, 120, 100);
  assert.ok(Math.abs(pose().yaw - (pinched.yaw + 10 * 0.0085)) < 1e-9, 'rotation continues from the remaining finger');

  now += 200;
  up(1, 120, 100);
  assert.equal(flings(), false, 'a paused release keeps no inertia');
  assert.equal(canvas.captured.size, 0, 'every capture is released');
});

test('swapped lift order continues with the second finger', () => {
  down(1, 100, 100);
  down(2, 200, 100);
  move(2, 200, 140);
  move(1, 100, 140);
  const panned = pose();
  assert.ok(panned.panY < 0, 'centroid drag pans');
  up(1, 100, 140);
  assertPoseEqual(pose(), panned, 'lifting the first finger keeps the pose');
  move(2, 210, 140);
  assert.ok(Math.abs(pose().yaw - 10 * 0.0085) < 1e-9, 'the second finger rotates from where it is');
  now += 200;
  up(2, 210, 140);
});

test('a third finger is ignored consistently', () => {
  down(1, 100, 100);
  down(2, 200, 100);
  down(3, 300, 300);
  const before = pose();
  move(3, 400, 500);
  assertPoseEqual(pose(), before, 'third finger moves do nothing');
  assert.equal(canvas.captured.has(3), false, 'third finger is not captured');
  up(1, 100, 100);
  move(3, 350, 300);
  assertPoseEqual(pose(), before, 'third finger stays ignored after another lifts');
  up(3, 350, 300);
  move(2, 210, 100);
  assert.ok(pose().yaw > before.yaw, 'the owned second finger still rotates');
});

test('pinch zoom clamps to the inspect range', () => {
  down(1, 290, 300);
  down(2, 310, 300);
  move(1, 0, 300);
  move(2, 600, 300);
  assert.equal(controls.getInspectDistance(), 1 * 0.35, 'clamped to the minimum distance');
  move(1, 299, 300);
  move(2, 301, 300);
  assert.equal(controls.getInspectDistance(), 5 * 4, 'clamped to the maximum distance');
  move(1, 300, 300);
  assert.ok(Number.isFinite(controls.getInspectDistance()), 'touching fingertips stay finite');
});

test('cancel and lost capture clear velocity and taps', () => {
  down(1, 100, 100);
  move(1, 140, 100);
  pointer('pointercancel', 1, 140, 100);
  assert.equal(flings(), false, 'a cancelled drag never flings');

  down(1, 100, 100);
  move(1, 140, 100);
  canvas.loseCapture(1);
  assert.equal(flings(), false, 'lost capture never flings');
  up(1, 140, 100);

  const before = pose();
  tap(1, 50, 50);
  down(1, 50, 50);
  pointer('pointercancel', 1, 50, 50);
  tap(1, 50, 50);
  assertPoseEqual(pose(), before, 'a cancel between taps prevents the reset');
});

test('double-tap resets only after two clean single-finger taps', () => {
  down(1, 100, 100);
  move(1, 160, 130);
  now += 200;
  up(1, 160, 130);
  const rotated = pose();
  assert.notEqual(rotated.pitch, 0);

  tap(1, 50, 50);
  down(1, 50, 50);
  move(1, 80, 50);
  now += 200;
  up(1, 80, 50);
  tap(1, 50, 50);
  assert.equal(pose().pitch, rotated.pitch, 'drag between taps does not reset');

  now += 1_000;
  tap(1, 50, 50);
  down(1, 50, 50);
  down(2, 150, 50);
  up(2, 150, 50);
  up(1, 50, 50);
  tap(1, 50, 50);
  assert.notEqual(pose().pitch, 0, 'multitouch between taps does not reset');

  now += 1_000;
  tap(1, 50, 50);
  now += 100;
  tap(1, 58, 54);
  assert.equal(pose().yaw, 0, 'two clean taps reset yaw');
  assert.equal(pose().pitch, 0, 'two clean taps reset pitch');

  down(1, 100, 100);
  move(1, 140, 140);
  now += 200;
  up(1, 140, 140);
  canvas.dispatchEvent(Object.assign(new Event('dblclick', { cancelable: true }), { button: 0 }));
  assert.notEqual(pose().yaw, 0, 'a dblclick synthesized from touch does not reset again');
});

test('first-person preview ignores touch input', () => {
  controls.setPreviewActive(true);
  down(1, 100, 100);
  move(1, 160, 100);
  assert.equal(pose().yaw, 0);
  assert.equal(canvas.captured.size, 0);
});

test('a refused capture never leaves a pointer owned', () => {
  canvas.refuseCapture = true;
  down(1, 100, 100);
  move(1, 160, 100);
  assert.equal(pose().yaw, 0, 'an uncaptured finger does not rotate');
  mouse('pointerdown', 100, 100);
  mouse('pointermove', 160, 100);
  assert.equal(pose().yaw, 0, 'an uncaptured mouse does not rotate');
  canvas.refuseCapture = false;
  mouse('pointerup', 160, 100);

  mouseDrag(0, [100, 100], [110, 100]);
  assert.ok(Math.abs(pose().yaw - 10 * 0.0085) < 1e-9, 'the refused finger does not block the mouse');
  down(2, 100, 100);
  move(2, 110, 100);
  assert.ok(Math.abs(pose().yaw - 20 * 0.0085) < 1e-9, 'or a later finger');
});

test('lost capture followed by a release outside the canvas frees the pointer', () => {
  down(1, 100, 100);
  move(1, 110, 100);
  canvas.loseCapture(1);
  active.delete(1); // released outside: this pointerup never reaches the canvas
  assert.equal(flings(), false, 'lost capture never flings');
  const before = pose().yaw;
  mouseDrag(0, [100, 100], [110, 100]);
  assert.ok(Math.abs(pose().yaw - (before + 10 * 0.0085)) < 1e-9, 'the mouse is not blocked');
  down(2, 100, 100);
  move(2, 110, 100);
  assert.ok(Math.abs(pose().yaw - (before + 20 * 0.0085)) < 1e-9, 'a new touch session rotates normally');
});

test('mouse behavior is unchanged', () => {
  mouse('pointerdown', 100, 100);
  mouse('pointermove', 120, 110);
  assert.ok(Math.abs(pose().yaw - 20 * 0.0085) < 1e-9, 'left drag yaws');
  assert.ok(Math.abs(pose().pitch - 10 * 0.0085) < 1e-9, 'left drag pitches');
  mouse('pointerup', 120, 110);
  assert.equal(flings(), true, 'a quick left release keeps its inertia tail');
  controls.update(5);
  assert.equal(canvas.captured.size, 0, 'the left drag released its capture');

  const rotated = pose();
  mouseDrag(2, [100, 100], [130, 80]);
  assert.ok(pose().panX > rotated.panX && pose().panY > rotated.panY, 'right drag pans');
  assert.equal(pose().yaw, rotated.yaw, 'right drag does not rotate');
  mouseDrag(1, [100, 100], [90, 100]);
  assert.ok(pose().panX < rotated.panX + 1, 'middle drag pans');
  assert.equal(pose().yaw, rotated.yaw, 'middle drag does not rotate');

  emit(canvas, 'wheel', { deltaY: 100 });
  controls.update(10);
  assert.ok(Math.abs(controls.getInspectDistance() - 5 * 1.15) < 1e-6, 'one wheel notch dollies out');

  emit(canvas, 'dblclick', { button: 0 });
  assertPoseEqual(pose(), { yaw: 0, pitch: 0, panX: 0, panY: 0, dist: 5 }, 'left double-click resets');
});

test('sticker placement keeps its mouse ownership', () => {
  controls.setPrimaryDragMode('disabled');
  mouse('pointerdown', 100, 100);
  assert.equal(canvas.captured.size, 0, 'left press is left to the sticker editor');
  mouse('pointermove', 160, 100);
  mouse('pointerup', 160, 100);
  assert.equal(pose().yaw, 0, 'left drag does not rotate');
  emit(canvas, 'dblclick', { button: 0 });

  mouseDrag(1, [100, 100], [110, 100]);
  assert.ok(Math.abs(pose().yaw - 10 * 0.0085) < 1e-9, 'middle drag orbits');
  now += 1_000;
  mouseDrag(1, [200, 200], [200, 200]);
  now += 100;
  mouse('pointerdown', 202, 201, 1);
  assert.equal(pose().yaw, 0, 'a middle double-click resets');
  mouse('pointerup', 202, 201, 1);

  down(1, 100, 100);
  move(1, 160, 100);
  assert.equal(pose().yaw, 0, 'touch is left to the sticker editor too');
});

test('light transforms belong to the first finger only', () => {
  // A point light at the origin, selected, with the camera looking straight at it:
  // the canvas center hits the gizmo's free-move handle.
  const scene = new THREE.Scene();
  const root = new THREE.Group();
  scene.add(root);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.01, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  const commits: CustomLightingRig[] = [];
  const editor = new LightEditor({
    canvas: canvas as unknown as HTMLCanvasElement,
    root,
    getCamera: () => camera,
    getFrame: () => null,
    invalidate: () => undefined,
    onChange: (rig) => commits.push(rig),
  });
  // Wired as Viewer does: the camera stays out of pointers the light editor claims.
  controls.setPointerDownExclusion((event) => editor.shouldExcludeCameraPointer(event));
  try {
    editor.setRig(validateCustomLightingRig({ lights: [{ id: 'key', type: 'point', position: [0, 0, 0] }] }));
    editor.setEditorMode(true);
    editor.setSelectedLight('key');
    editor.update();
    scene.updateMatrixWorld(true);
    const lightX = () => {
      const light = commits.at(-1)?.lights[0];
      return light?.type === 'point' ? light.position[0] : 0;
    };

    down(1, 300, 300);
    move(1, 340, 300);
    down(2, 100, 100);
    move(2, 50, 50);
    pointer('pointercancel', 2, 50, 50);
    assert.equal(commits.length, 0, 'cancelling an unrelated finger neither restores nor commits the light');
    up(1, 340, 300);
    assert.equal(commits.length, 1, 'the owning finger commits its drag');
    assert.ok(lightX() > 0, 'the drag moved the light along the first finger');
    assert.equal(pose().yaw, 0, 'the camera stayed out of the light drag');

    scene.updateMatrixWorld(true);
    const committed = lightX();
    down(1, 340, 300);
    move(1, 380, 300);
    canvas.loseCapture(1);
    active.delete(1); // released outside the canvas
    assert.equal(commits.length, 2, 'lost capture reverts the drag');
    assert.equal(lightX(), committed, 'back to the committed position');

    scene.updateMatrixWorld(true);
    down(3, 340, 300);
    move(3, 380, 300);
    up(3, 380, 300);
    assert.ok(lightX() > committed, 'a later drag is not blocked by the lost pointer');
  } finally {
    editor.dispose();
  }
});
