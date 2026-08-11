// Sticker camera-ownership contract check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  INSPECT_MIN_DISTANCE_FACTOR,
  inspectDoubleClickResets,
  inspectDragForPointer,
  isRapidInspectClickPair,
} from '../../../src/viewer/inspectControls';

test('sticker camera ownership', () => {
  assert.equal(INSPECT_MIN_DISTANCE_FACTOR, 0.35, 'inspect camera permits a substantially closer weapon view');
  assert.equal(inspectDragForPointer(0, 'rotate'), 'rotate', 'normal inspect left-drag rotates');
  assert.equal(inspectDragForPointer(1, 'rotate'), 'pan', 'normal inspect middle-drag pans');
  assert.equal(inspectDragForPointer(2, 'rotate'), 'pan', 'normal inspect right-drag pans');
  assert.equal(inspectDragForPointer(0, 'disabled'), 'none', 'sticker-mode empty left-drag does not rotate');
  assert.equal(inspectDragForPointer(1, 'disabled'), 'rotate', 'sticker-mode middle-drag rotates');
  assert.equal(inspectDragForPointer(2, 'disabled'), 'pan', 'sticker-mode right-drag pans');
  assert.equal(inspectDoubleClickResets(0, 'rotate'), true, 'normal left double-click resets');
  assert.equal(inspectDoubleClickResets(0, 'disabled'), false, 'sticker-mode left double-click never resets');
  assert.equal(isRapidInspectClickPair(
    { clientX: 50, clientY: 80, time: 1_000 },
    { clientX: 54, clientY: 83, time: 1_250 },
  ), true, 'two completed middle clicks inside the gesture window reset sticker-mode inspect');
  assert.equal(isRapidInspectClickPair(
    { clientX: 50, clientY: 80, time: 1_000 },
    { clientX: 65, clientY: 83, time: 1_250 },
  ), false, 'a moved middle click is not mistaken for a reset');
});
