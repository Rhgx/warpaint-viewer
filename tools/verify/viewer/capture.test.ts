import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  fitScreenshotCapture,
  resolveScreenshotCapture,
  screenshotOutputSize,
  screenshotWatermarkScale,
} from '../../../src/viewer/capture';

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
