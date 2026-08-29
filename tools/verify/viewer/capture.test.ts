import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  fitScreenshotCapture,
  resolveScreenshotCapture,
  screenshotOutputSize,
} from '../../../src/viewer/capture';

test('size presets fit the viewport within the requested maximum edge', () => {
  assert.deepEqual(resolveScreenshotCapture({ maxEdge: 1920 }, 800, 1000), {
    width: 1536,
    height: 1920,
    paddingScale: 1.92,
    outputMaxEdge: 1920,
  });
});

test('scaled captures keep the viewport-based thumbnail behavior', () => {
  assert.deepEqual(resolveScreenshotCapture(2, 128, 128), {
    width: 256,
    height: 256,
    paddingScale: 2,
    outputMaxEdge: null,
  });
});

test('cropped screenshots fit their longest edge without changing aspect', () => {
  assert.deepEqual(screenshotOutputSize(1200, 450, 1920), { width: 1920, height: 720 });
  assert.deepEqual(screenshotOutputSize(3000, 27653, 3840), { width: 417, height: 3840 });
  assert.deepEqual(screenshotOutputSize(1200, 450, null), { width: 1200, height: 450 });
});

test('oversized working renders keep their aspect and requested maximum edge', () => {
  const capture = resolveScreenshotCapture({ maxEdge: 15360 }, 800, 1000);
  const fitted = fitScreenshotCapture(capture, 16384, 7680 * 4320);

  assert.equal(fitted.width * fitted.height <= 7680 * 4320, true);
  assert.equal(Math.max(fitted.width, fitted.height) <= 16384, true);
  assert.equal(fitted.outputMaxEdge, 15360);
  assert.equal(Math.abs(fitted.width / fitted.height - 0.8) < 0.001, true);
});
