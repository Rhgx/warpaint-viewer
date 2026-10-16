import assert from 'node:assert/strict';
import * as THREE from 'three';
import { test, vi } from 'vitest';
import { Viewer } from '../../../src/viewer/Viewer';

// Canvas pixel where the model centre (the world origin) lands.
function originPixel(camera: THREE.Camera, width: number, height: number): number[] {
  camera.updateMatrixWorld();
  const ndc = new THREE.Vector3().project(camera);
  return [(ndc.x + 1) / 2 * width, (1 - ndc.y) / 2 * height];
}

function near(actual: number[], expected: number[], message: string) {
  assert.ok(actual.every((value, i) => Math.abs(value - expected[i]) < 1e-6), `${message}: ${actual} vs ${expected}`);
}

function insetViewer(width: number, height: number) {
  const camera = new THREE.PerspectiveCamera(40, width / height, 0.1, 100);
  const orthoCamera = new THREE.OrthographicCamera(-width / height, width / height, 1, -1, 0.1, 100);
  for (const each of [camera, orthoCamera]) each.position.set(0, 0, 5);
  return { canvas: { clientWidth: width, clientHeight: height }, camera, orthoCamera, turntableCapturing: false };
}

const applyViewInset = Reflect.get(Viewer.prototype, 'applyViewInset');

test('the view inset centres the model in the uncovered canvas area of both cameras', () => {
  // Portrait: a 420px Controls sheet over the bottom of a 427x764 canvas.
  const viewer = insetViewer(427, 764);
  Reflect.apply(applyViewInset, viewer, [0, 420]);
  for (const camera of [viewer.camera, viewer.orthoCamera]) {
    assert.deepEqual({ ...camera.view }, { enabled: true, fullWidth: 427, fullHeight: 764, offsetX: 0, offsetY: 210, width: 427, height: 764 });
    near(originPixel(camera, 427, 764), [213.5, 172], 'portrait centre');
  }
  assert.equal(viewer.camera.aspect, 427 / 764, 'the aspect is unchanged');

  // Unchanged values do not rebuild the projection.
  const setViewOffset = vi.spyOn(viewer.camera, 'setViewOffset');
  Reflect.apply(applyViewInset, viewer, [0, 420]);
  assert.equal(setViewOffset.mock.calls.length, 0);

  // Landscape: a 360px slide-over on the right of a 915x412 canvas.
  const wide = insetViewer(915, 412);
  Reflect.apply(applyViewInset, wide, [360, 0]);
  for (const camera of [wide.camera, wide.orthoCamera]) near(originPixel(camera, 915, 412), [277.5, 206], 'landscape centre');

  // Zero clears the offset.
  Reflect.apply(applyViewInset, wide, [0, 0]);
  for (const camera of [wide.camera, wide.orthoCamera]) {
    assert.equal(camera.view?.enabled, false);
    near(originPixel(camera, 915, 412), [457.5, 206], 'full canvas centre');
  }

  // A turntable capture owns the view offset while it runs.
  wide.turntableCapturing = true;
  Reflect.apply(applyViewInset, wide, [360, 0]);
  assert.equal(wide.camera.view?.enabled, false);
});

test('inspect captures render the whole canvas and restore the live inset', async () => {
  const viewer = insetViewer(427, 764);
  const seen: (boolean | undefined)[] = [];
  const stop = new Error('stop after render');
  Object.assign(viewer, {
    contextLost: false,
    firstPerson: null,
    projectionMode: 'perspective',
    viewInset: { right: 0, bottom: 420 },
    applyViewInset,
    renderer: {
      capabilities: { maxTextureSize: 4096 },
      outputColorSpace: THREE.SRGBColorSpace,
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      getPixelRatio: () => 1,
      render: (_scene: THREE.Scene, camera: THREE.Camera) => {
        if (camera instanceof THREE.PerspectiveCamera) seen.push(camera.view?.enabled);
      },
      readRenderTargetPixels: () => { throw stop; },
    },
    scene: new THREE.Scene(),
    lightEditor: { setCaptureMode: () => {} },
  });
  Reflect.apply(applyViewInset, viewer, [0, 420]);
  await assert.rejects(Reflect.apply(Viewer.prototype.captureScreenshot, viewer, [1]), stop);
  assert.deepEqual(seen, [false], 'the capture renders without the inset');
  assert.equal(viewer.camera.view?.offsetY, 210, 'the live inset is restored');
  assert.equal(viewer.camera.view?.enabled, true);
});
