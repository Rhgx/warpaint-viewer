import assert from 'node:assert/strict';
import { test } from 'vitest';

import { SHEEN_FRAMERATE, SHEEN_PAUSE_SECONDS, SHEEN_SWEEP_SECONDS, msUntilNextSheenFrame } from '../../../src/viewer/overlays/sheen';

const FRAME_MS = 1000 / SHEEN_FRAMERATE;
const CYCLE = SHEEN_SWEEP_SECONDS + SHEEN_PAUSE_SECONDS;

function assertClose(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `expected ${expected}, got ${actual}`);
}

test('sheen pacing waits to the next 25 fps frame boundary', () => {
  assertClose(msUntilNextSheenFrame(0), FRAME_MS);
  assertClose(msUntilNextSheenFrame(0.01), 30);
  assertClose(msUntilNextSheenFrame(0.5), 20);
  assertClose(msUntilNextSheenFrame(SHEEN_SWEEP_SECONDS - 0.01), 10);
});

test('sheen pacing wraps with the sweep and pause cycle', () => {
  assertClose(msUntilNextSheenFrame(CYCLE + 0.01), 30);
  assertClose(msUntilNextSheenFrame(3 * CYCLE), FRAME_MS);
});

test('sheen pacing never skips a frame change while sweeping', () => {
  for (let t = 0; t < SHEEN_SWEEP_SECONDS; t += 0.0037) {
    const delay = msUntilNextSheenFrame(t);
    assert.ok(delay > 0 && delay <= FRAME_MS + 1e-9, `delay ${delay} at ${t}`);
    const before = Math.floor(SHEEN_FRAMERATE * t);
    const after = Math.floor(SHEEN_FRAMERATE * (t + delay / 1000 + 1e-9));
    assert.equal(after, before + 1, `no single frame change at ${t}`);
  }
});
