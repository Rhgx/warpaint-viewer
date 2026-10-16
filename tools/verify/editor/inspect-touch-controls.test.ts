// Touch gesture contract for the inspect camera: one finger rotates, two fingers
// pan and pinch, finger changes never jump the pose, and the mouse is unchanged.

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { InspectControls } from '../../../src/viewer/inspectControls';

// Just enough of a canvas for the camera: listeners, size and pointer capture.
class FakeCanvas extends EventTarget {
  style = { touchAction: '' };
  clientHeight = 600;
  captured = new Set<number>();
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) { this.captured.delete(id); }
}

let now = 1_000;
let canvas: FakeCanvas;
let model: THREE.Group;
let controls: InspectControls;
// Fingers on the glass; the first of a session is the primary pointer.
const active = new Set<number>();

beforeEach(() => {
  now = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false, pointerLockElement: null, querySelector: () => null }));
  canvas = new FakeCanvas();
  model = new THREE.Group();
  controls = new InspectControls(new THREE.PerspectiveCamera(50, 1, 0.01, 100), model, canvas as unknown as HTMLElement);
  controls.setFraming(5, 1);
  active.clear();
});

afterEach(() => {
  controls.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function emit(type: string, props: object) {
  canvas.dispatchEvent(Object.assign(new Event(type, { cancelable: true }), props));
}

function pointer(type: string, pointerId: number, clientX: number, clientY: number, pointerType = 'touch', button = 0) {
  const isPrimary = pointerType === 'mouse' || (type === 'pointerdown' && active.size === 0);
  if (pointerType === 'touch' && type === 'pointerdown') active.add(pointerId);
  if (type === 'pointerup' || type === 'pointercancel') active.delete(pointerId);
  emit(type, { pointerId, pointerType, isPrimary, clientX, clientY, button: type === 'pointermove' ? -1 : button, buttons: 1, shiftKey: false });
}

const down = (id: number, x: number, y: number) => pointer('pointerdown', id, x, y);
const move = (id: number, x: number, y: number) => pointer('pointermove', id, x, y);
const up = (id: number, x: number, y: number) => pointer('pointerup', id, x, y);
const mouse = (type: string, x: number, y: number, button = 0) => pointer(type, 99, x, y, 'mouse', button);
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

test('a cancelled drag never flings', () => {
  down(1, 100, 100);
  move(1, 140, 100);
  pointer('pointercancel', 1, 140, 100);
  assert.equal(flings(), false);
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

  emit('wheel', { deltaY: 100 });
  controls.update(10);
  assert.ok(Math.abs(controls.getInspectDistance() - 5 * 1.15) < 1e-6, 'one wheel notch dollies out');

  emit('dblclick', { button: 0 });
  assertPoseEqual(pose(), { yaw: 0, pitch: 0, panX: 0, panY: 0, dist: 5 }, 'left double-click resets');
});
