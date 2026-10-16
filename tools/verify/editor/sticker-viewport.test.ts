// 2D editor navigation contract check.
//
// Zoom and pan are screen-only. A placement point must map back to the exact
// same V-down compositor coordinate regardless of the current viewport.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as viewport from '../../../src/editor/sticker/stickerViewport';
import { close } from '../fixtures';

test('sticker viewport UV contract', () => {
  const size = { width: 640, height: 400 };
  const uv = { x: 0.3725, y: 0.68125 }; // V is deliberately CSS/compositor down.

  for (const view of [
    { zoom: 1, panX: 0, panY: 0 },
    { zoom: 2.5, panX: -330, panY: -210 },
    { zoom: 0.5, panX: 160, panY: 100 },
  ]) {
    const pixel = viewport.stickerUvPointToViewport(uv, view, size);
    const roundTrip = viewport.stickerViewportPointToUv(pixel, view, size);
    close(roundTrip, uv, 'viewport round-trip preserves U and V-down');
  }

  const before = { zoom: 1.5, panX: -140, panY: -96 };
  const pointer = { x: 332, y: 174 };
  const beforeUv = viewport.stickerViewportPointToUv(pointer, before, size);
  const zoomed = viewport.zoomStickerViewportAt(before, 3, pointer, size);
  const afterUv = viewport.stickerViewportPointToUv(pointer, zoomed, size);
  close(afterUv, { x: beforeUv.x, y: beforeUv.y }, 'pointer-centred zoom preserves UV below pan clamp');

  const fit = viewport.normalizeStickerViewport({ zoom: 1, panX: 99, panY: -99 }, size);
  assert.deepEqual(fit, { zoom: 1, panX: 0, panY: 0 }, 'fit view is an untransformed UV canvas');

});
