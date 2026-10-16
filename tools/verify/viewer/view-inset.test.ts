import assert from 'node:assert/strict';
import * as THREE from 'three';
import { test } from 'vitest';
import { Viewer } from '../../../src/viewer/Viewer';

test('the view inset centres the model in the uncovered canvas area, and zero clears it', () => {
  // Portrait: a 420px Controls sheet over the bottom of a 427x764 canvas.
  const camera = new THREE.PerspectiveCamera(40, 427 / 764, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.updateMatrixWorld();
  const viewer = { canvas: { clientWidth: 427, clientHeight: 764 }, camera, orthoCamera: new THREE.OrthographicCamera(), turntableCapturing: false };
  const applyViewInset = Reflect.get(Viewer.prototype, 'applyViewInset');
  const originY = () => (1 - new THREE.Vector3().project(camera).y) / 2 * 764;

  Reflect.apply(applyViewInset, viewer, [0, 420]);
  assert.ok(Math.abs(originY() - 172) < 1e-6, 'model centre sits mid uncovered area');
  Reflect.apply(applyViewInset, viewer, [0, 0]);
  assert.equal(camera.view?.enabled, false);
});
