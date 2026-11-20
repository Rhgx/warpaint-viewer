import assert from 'node:assert/strict';
import * as THREE from 'three';
import { afterEach, test, vi } from 'vitest';

import {
  fitScreenshotCapture,
  resolveScreenshotCapture,
  screenshotOutputSize,
  screenshotWatermarkScale,
} from '../../../src/viewer/capture/capture';
import { ViewerCapture, type ViewerCaptureHost } from '../../../src/viewer/capture/viewerCapture';

afterEach(() => vi.unstubAllGlobals());

test('screenshot sizing: watermark orientation, preset fit, crop fit and oversized clamp', () => {
  assert.equal(screenshotWatermarkScale(1080, 1920), screenshotWatermarkScale(1920, 1080));
  assert.equal(screenshotWatermarkScale(720, 1920), screenshotWatermarkScale(1920, 720));
  assert.ok(screenshotWatermarkScale(2160, 3840) > screenshotWatermarkScale(1080, 1920), 'scales with export resolution');

  const preset = resolveScreenshotCapture({ maxEdge: 1920 }, 800, 1000);
  assert.deepEqual([preset.width, preset.height, preset.outputMaxEdge], [1536, 1920, 1920]);
  assert.deepEqual(screenshotOutputSize(1200, 450, 1920), { width: 1920, height: 720 });

  const fitted = fitScreenshotCapture(resolveScreenshotCapture({ maxEdge: 15360 }, 800, 1000), 16384, 7680 * 4320);
  assert.ok(fitted.width * fitted.height <= 7680 * 4320);
  assert.ok(Math.max(fitted.width, fitted.height) <= 16384);
  assert.equal(fitted.outputMaxEdge, 15360);
  assert.ok(Math.abs(fitted.width / fitted.height - 0.8) < 0.001);
});

test('an animated turntable capture leaves the model at the yaw it started from', async () => {
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0));
  let yaw = 0;
  // Stands in for the GPU: every readback reports one lit pixel in the middle of the frame.
  const renderer = {
    capabilities: { maxSamples: 0, maxTextureSize: 4096 },
    outputColorSpace: THREE.SRGBColorSpace,
    getRenderTarget: () => null,
    setRenderTarget: () => undefined,
    render: () => undefined,
    getPixelRatio: () => 1,
    readRenderTargetPixels: (_target: unknown, _x: number, _y: number, width: number, height: number, buffer: Uint8Array) => {
      buffer.fill(0);
      buffer[(Math.floor(height / 2) * width + Math.floor(width / 2)) * 4 + 3] = 255;
    },
  };
  const host = {
    canvas: { clientWidth: 400, clientHeight: 300, style: { pointerEvents: '' } },
    renderer,
    scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(50, 400 / 300, 0.1, 100),
    orthoCamera: new THREE.OrthographicCamera(),
    centerGroup: new THREE.Group(),
    controls: {
      getCameraMode: () => 'inspect',
      getDistance: () => ({ current: 5, framed: 5 }),
      setDistance: () => undefined,
      rotateYaw: (radians: number) => { yaw += radians; },
    },
    lightEditor: { setCaptureMode: () => undefined },
    firstPersonStage: { preview: null, renderFirstPerson: () => undefined },
    sheen: { active: false, meshes: [], updateSheenAnimation: () => undefined },
    // An emissive that reports itself animated is what adds the loop-seam overrun frames.
    emissive: { stepEmissive: () => true },
    weaponAttachments: { stepAttachments: () => false },
    statClock: { step: () => false },
    getActiveUnusual: () => null,
    getProjectionMode: () => 'perspective',
    getViewInset: () => ({ right: 0, bottom: 0 }),
    applyViewInset: () => undefined,
    syncOrthoCamera: () => undefined,
    isContextLost: () => false,
    isDisposed: () => false,
    isTurntableCapturing: () => false,
    setTurntableCapturing: () => undefined,
    invalidate: () => undefined,
  };
  let frames = 0;
  await new ViewerCapture(host as unknown as ViewerCaptureHost).captureTurntable(
    { maxEdge: 64, fps: 10, seconds: 2, background: null, alpha: 'full', paletteSamples: false },
    { start: () => undefined, frame: async () => { frames += 1; } },
  );
  assert.equal(frames, 20);
  const offset = Math.abs(((yaw % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  assert.ok(offset < 1e-6, `the model ends ${offset} rad away from where it started`);
});
