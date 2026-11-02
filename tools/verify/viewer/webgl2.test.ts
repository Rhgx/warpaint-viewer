import assert from 'node:assert/strict';
import { test } from 'vitest';
import { canUseWebGL2 } from '../../../src/viewer/webgl2';

test('WebGL 2 probe reports a missing context and releases a granted one', () => {
  assert.equal(canUseWebGL2(() => null), false);

  let lost = 0;
  const granted = canUseWebGL2(() => ({
    getExtension: () => ({ loseContext: () => { lost += 1; } }),
  }));
  assert.equal(granted, true);
  assert.equal(lost, 1);

  // Browsers without the loss extension still report support.
  assert.equal(canUseWebGL2(() => ({ getExtension: () => null })), true);
});
