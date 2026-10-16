// Viewer/2D sticker placement geometry contract check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  constrainStickerQuadToTexture,
  moveStickerQuadToUv,
  nearestPeriodicUv,
  stickerQuadCenter,
  stickerQuadIsWithinTexture,
} from '../../../src/editor/sticker/viewerStickerPlacement';
import type { StickerPlacementQuad } from '../../../src/editor/sticker/viewerStickerPlacement';
import { close } from '../fixtures';

test('viewer sticker placement geometry', () => {
  const quad: StickerPlacementQuad = { tl: [0.2, 0.3], tr: [0.5, 0.4], bl: [0.1, 0.7] };
  const originalCentre = stickerQuadCenter(quad);
  close(originalCentre, [0.3, 0.55], 'centre includes both affine basis vectors');

  const moved = moveStickerQuadToUv(quad, [0.7, 0.15]);
  close(stickerQuadCenter(moved), [0.7, 0.15], 'movement follows the picked UV while its centre remains recoverable');
  assert.equal(stickerQuadIsWithinTexture(moved), false, 'valid edge clipping may place destination corners outside the texture');
  close(
    [moved.tr[0] - moved.tl[0], moved.tr[1] - moved.tl[1], moved.bl[0] - moved.tl[0], moved.bl[1] - moved.tl[1]],
    [quad.tr[0] - quad.tl[0], quad.tr[1] - quad.tl[1], quad.bl[0] - quad.tl[0], quad.bl[1] - quad.tl[1]],
    'moving preserves the authored affine shape',
  );

  assert.deepEqual(nearestPeriodicUv([0.98, 0.5], [0.02, 0.5]), [1.02, 0.5], 'wrap seam picks the nearby periodic copy');
  const seamQuad: StickerPlacementQuad = { tl: [0.92, 0.45], tr: [1.02, 0.45], bl: [0.92, 0.55] };
  const seamMoved = moveStickerQuadToUv(seamQuad, [0.03, 0.5]);
  close(stickerQuadCenter(seamMoved), [1, 0.5], 'seam movement keeps its anchor at the texture edge');
  assert.equal(stickerQuadIsWithinTexture(seamMoved), false, 'seam-safe clipping keeps the compact authored destination');

  const oversized = constrainStickerQuadToTexture({ tl: [-0.5, -0.5], tr: [1.5, -0.5], bl: [-0.5, 1.5] });
  assert.equal(stickerQuadIsWithinTexture(oversized), false, 'large destinations may clip after their edge length is capped');
  close(oversized, { tl: [-0.25, -0.25], tr: [1.25, -0.25], bl: [-0.25, 1.25] }, 'oversized placement is centred with capped edges');

  const invalid: StickerPlacementQuad = { tl: [Number.NaN, 0], tr: [0.1, 0], bl: [0, 0.1] };
  assert.equal(moveStickerQuadToUv(invalid, [0.5, 0.5]), invalid, 'bad input is refused without emitting NaN values');
});
