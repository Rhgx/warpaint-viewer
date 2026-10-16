import assert from 'node:assert/strict';
import { test } from 'vitest';
import { isRapidInspectClickPair } from '../../../src/viewer/inspectControls';

test('rapid click pairs reset inspect only within the window and slop', () => {
  const first = { clientX: 50, clientY: 80, time: 1_000 };
  assert.equal(isRapidInspectClickPair(first, { clientX: 54, clientY: 83, time: 1_250 }), true);
  assert.equal(isRapidInspectClickPair(first, { clientX: 65, clientY: 83, time: 1_250 }), false, 'a moved click is not a reset');
  assert.equal(isRapidInspectClickPair(first, { clientX: 65, clientY: 83, time: 1_250 }, 40), true, 'touch slop accepts it');
  assert.equal(isRapidInspectClickPair(first, { clientX: 50, clientY: 80, time: 1_400 }, 40), false, 'outside the window');
});
