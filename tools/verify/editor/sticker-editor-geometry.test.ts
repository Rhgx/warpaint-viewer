// Compact 2D sticker editor geometry contract check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as geometry from '../../../src/editor/stickerGeometry';
import type { StickerPlacement } from '../../../src/editor/stickerGeometry';

function close(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

function closePoint(actual: readonly [number, number], expected: readonly [number, number], message: string): void {
  close(actual[0], expected[0], `${message} x`);
  close(actual[1], expected[1], `${message} y`);
}

test('compact sticker editor geometry', () => {
  const original = { x: 0.37, y: 0.58, width: 0.28, height: 0.11, rotation: 31 };
  const quad = geometry.stickerPlacementToQuad(original);
  assert.ok(quad, 'valid placement emits an authored quad');
  const parsed = geometry.stickerPlacementFromQuad(quad);
  assert.equal(parsed.editable, true, 'rotated rectangle stays editable');
  assert.ok(parsed.placement, 'supported quad returns a placement');
  for (const field of ['x', 'y', 'width', 'height', 'rotation'] as const) {
    close(parsed.placement[field], original[field], `quad round-trip ${field}`);
  }
  close(geometry.snapStickerRotationToCardinal(87), 90, 'rotation snaps up to 90');
  close(geometry.snapStickerRotationToCardinal(94), 90, 'rotation snaps down to 90 at threshold');
  close(geometry.snapStickerRotationToCardinal(95), 95, 'rotation remains free outside threshold');
  close(geometry.snapStickerRotationToCardinal(179), 180, 'rotation snaps near 180');
  close(geometry.snapStickerRotationToCardinal(359), 0, 'rotation snaps across the zero seam');
  assert.equal(
    geometry.stickerPlacementContainsPoint(original, { x: original.x, y: original.y }),
    true,
    'rotated sticker contains its centre',
  );
  assert.equal(
    geometry.stickerPlacementContainsPoint(original, { x: 0.02, y: 0.02 }),
    false,
    'rotated sticker rejects a distant point',
  );
  const nested = [
    { id: 'large', placement: { x: 0.5, y: 0.5, width: 0.6, height: 0.6, rotation: 0 } },
    { id: 'small', placement: { x: 0.5, y: 0.5, width: 0.1, height: 0.1, rotation: 0 } },
  ].filter(({ placement }) => geometry.stickerPlacementContainsPoint(placement, { x: 0.5, y: 0.5 }))
    .sort((first, second) => first.placement.width * first.placement.height - second.placement.width * second.placement.height);
  assert.equal(nested[0].id, 'small', 'nested selection prefers the smallest containing sticker');

  const skewed = geometry.stickerPlacementFromQuad({ tl: [0, 0], tr: [0.4, 0], bl: [0.1, 0.2] });
  assert.equal(skewed.editable, false, 'skewed quad is not silently flattened');
  assert.ok(skewed.reason);
  assert.match(skewed.reason, /skewed/i, 'skew has a useful refusal reason');

  const rocketStickerOne = geometry.stickerPlacementFromQuad({
    tl: [0.1061291099, 0.05910533667],
    tr: [0.1061293483, 0.128580153],
    bl: [0.03665441275, 0.05910533667],
  });
  assert.equal(
    rocketStickerOne.editable,
    true,
    'ordinary proto float noise does not disable Fantach Rocket Launcher sticker 1',
  );
  const rocketStickerTwo = geometry.stickerPlacementFromQuad({
    tl: [0.2066156268, 0.1291550994],
    tr: [0.2066156268, 0.05968052149],
    bl: [0.2760903239, 0.1291549802],
  });
  assert.equal(
    rocketStickerTwo.editable,
    true,
    'ordinary proto float noise does not disable Fantach Rocket Launcher sticker 2',
  );

  const authoredSkew = geometry.stickerPlacementFromQuad({
    tl: [0.2, 0.2],
    tr: [0.4, 0.2],
    bl: [0.200836, 0.4],
  });
  assert.equal(authoredSkew.editable, false, 'visible authored shear remains read-only');
  assert.ok(authoredSkew.reason);
  assert.match(authoredSkew.reason, /skewed/i, 'authored shear keeps the skew refusal');

  const mirrored = geometry.stickerPlacementFromQuad({ tl: [0, 0], tr: [0.4, 0], bl: [0, -0.2] });
  assert.equal(mirrored.editable, false, 'mirrored quad is not silently flattened');
  assert.ok(mirrored.reason);
  assert.match(mirrored.reason, /mirrored/i, 'mirror has a useful refusal reason');

  const resized = geometry.resizeStickerFromCorner(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 },
    'bottom-right',
    { x: 0.7, y: 0.6 },
  );
  close(resized.x, 0.55, 'corner resize centre x');
  close(resized.y, 0.525, 'corner resize centre y');
  close(resized.width, 0.3, 'corner resize width');
  close(resized.height, 0.15, 'corner resize height');

  const lockedResize = geometry.resizeStickerFromCorner(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 },
    'bottom-right',
    { x: 0.65, y: 0.7 },
    { preserveAspect: true },
  );
  close(lockedResize.width / lockedResize.height, 2, 'locked corner resize keeps artwork ratio');
  close(lockedResize.x - lockedResize.width / 2, 0.4, 'locked resize holds opposite x');
  close(lockedResize.y - lockedResize.height / 2, 0.45, 'locked resize holds opposite y');

  const widthOnly = geometry.resizeStickerFromEdge(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 },
    'right',
    { x: 0.7, y: 0.9 },
  );
  close(widthOnly.x, 0.55, 'right edge resize shifts centre x');
  close(widthOnly.y, 0.5, 'right edge resize keeps centre y');
  close(widthOnly.width, 0.3, 'right edge resize changes width');
  close(widthOnly.height, 0.1, 'right edge resize preserves height');

  const widthLocked = geometry.resizeStickerFromEdge(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 },
    'right',
    { x: 0.7, y: 0.5 },
    { preserveAspect: true },
  );
  close(widthLocked.width / widthLocked.height, 2, 'locked edge resize keeps artwork ratio');
  close(widthLocked.x - widthLocked.width / 2, 0.4, 'locked edge resize holds opposite edge');

  const heightOnly = geometry.resizeStickerFromEdge(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 },
    'top',
    { x: 0.9, y: 0.35 },
  );
  close(heightOnly.x, 0.5, 'top edge resize keeps centre x');
  close(heightOnly.y, 0.45, 'top edge resize shifts centre y');
  close(heightOnly.width, 0.2, 'top edge resize preserves width');
  close(heightOnly.height, 0.2, 'top edge resize changes height');

  const snapped = geometry.snapStickerPlacement(
    { x: 0.513, y: 0.487, width: 0.263, height: 0.236, rotation: 22 },
    0.025,
  );
  close(snapped.x, 0.525, 'grid snap x');
  close(snapped.y, 0.475, 'grid snap y');
  close(snapped.width, 0.275, 'grid snap width');
  close(snapped.height, 0.225, 'grid snap height');
  close(snapped.rotation, 15, 'grid snap turn');

  const moved = geometry.moveStickerPlacement(original, { x: 0.1, y: -0.2 });
  close(moved.x, 0.47, 'move x');
  close(moved.y, 0.38, 'move y');
  const edgeMove = geometry.moveStickerPlacement(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.2, rotation: 0 },
    { x: 0.8, y: 0 },
  );
  close(edgeMove.x, 1, 'movement stops while its editable anchor remains recoverable');
  const oversized = geometry.constrainStickerPlacementToTexture({
    x: 0.5, y: 0.5, width: 2, height: 1, rotation: 45,
  });
  close(oversized.width, 1.5, 'extreme width is capped without forbidding valid clipping');
  close(oversized.height, 1, 'independent height remains intact below the cap');
  const authoredEdgeLogo = geometry.stickerPlacementFromQuad({
    tl: [0.634, 0.177], tr: [0.428, 0.177], bl: [0.634, -0.029],
  }).placement;
  assert.ok(authoredEdgeLogo, 'Flak Furnished edge logo remains a supported placement');
  const preservedEdgeLogo = geometry.stickerPlacementToQuad(geometry.clampStickerPlacement(authoredEdgeLogo));
  assert.ok(preservedEdgeLogo, 'clamped supported placement remains an authored quad');
  closePoint(preservedEdgeLogo.tl, [0.634, 0.177], 'authored edge clipping preserves top-left');
  closePoint(preservedEdgeLogo.tr, [0.428, 0.177], 'authored edge clipping preserves top-right');
  closePoint(preservedEdgeLogo.bl, [0.634, -0.029], 'authored edge clipping preserves bottom-left');
  const unrotated: StickerPlacement = { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 };
  const unrotatedQuad = geometry.stickerPlacementToQuad(unrotated);
  assert.ok(unrotatedQuad, 'finite placement emits an authored quad');
  closePoint(unrotatedQuad.tl, [0.4, 0.45], 'unrotated top left');
});
