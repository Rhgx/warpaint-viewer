// On-model sticker gizmo UV transform contract check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as gizmo from '../../../src/editor/sticker/stickerGizmo';
import type { StickerPlacementQuad } from '../../../src/editor/sticker/viewerStickerPlacement';
import { close } from '../fixtures';

const quad: StickerPlacementQuad = { tl: [0.4, 0.45], tr: [0.6, 0.45], bl: [0.4, 0.55] };

test('screen layout, partial visibility and anchors', () => {
  assert.equal(gizmo.stickerGizmoAnchorContainsCentre([true, false, false]), true,
    'an occluded anchor remains compatible while its chart still contains the authored centre');
  assert.equal(gizmo.stickerGizmoAnchorContainsCentre([false, true, true]), false,
    'a stale anchor is released when only old boundary samples remain on its chart');

  const layout = gizmo.createStickerGizmoScreenLayout({ x: 20, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 60 }, { x: 20, y: 60 });
  assert.deepEqual(layout.handles.move, { x: 60, y: 40 }, 'move handle stays at the affine centre');
  assert.ok(layout.handles.rotate.y < layout.handles['scale-top-left'].y, 'rotation control sits outside the top edge');
  assert.deepEqual(layout.handles['scale-right'], { x: 100, y: 40 }, 'edge handles stay centred on their affine axis');
  assert.deepEqual(layout.handles['scale-bottom'], { x: 60, y: 60 });
  assert.equal(gizmo.pointIsInsideStickerGizmoScreenOutline({ x: 60, y: 40 }, layout.corners), true, 'the decal body is a move target');
  assert.equal(gizmo.pointIsInsideStickerGizmoScreenOutline({ x: 140, y: 40 }, layout.corners), false, 'empty canvas is outside');

  // Partially and fully hidden boundary samples.
  assert.deepEqual(gizmo.deriveStickerGizmoScreenCentre(null, [0.5, 0.5], [
    { uv: [0.4, 0.45], point: { x: 20, y: 20 } },
    { uv: [0.5, 0.45], point: { x: 60, y: 20 } },
    { uv: [0.6, 0.45], point: null },
  ]), { x: 60, y: 20 }, 'a hidden UV centre falls back to the closest real boundary sample');
  assert.equal(gizmo.deriveStickerGizmoScreenCentre(null, [0.5, 0.5], [{ uv: [0.4, 0.4], point: null }]), null, 'no invented centre');
  assert.equal(gizmo.stickerGizmoScreenHull([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }, null]).length, 3, 'partial hull');
  assert.deepEqual(gizmo.stickerGizmoScreenHull([null, undefined]), [], 'fully hidden samples produce no outline');
  assert.equal(gizmo.hasUsableStickerGizmoScaleDirection({ x: 60, y: 20 }, { x: 60, y: 20 }), false, 'no directionless scale grip');
  assert.equal(gizmo.hasUsableStickerGizmoScaleDirection({ x: 60, y: 20 }, { x: 68, y: 20 }), true);
});

test('scale, rotate and move return authored UV quads', () => {
  close(gizmo.scaleStickerQuadFromGizmo(quad, 'scale-bottom-right', [0.8, 0.65]), { tl: quad.tl, tr: [0.8, 0.45], bl: [0.4, 0.65] }, 'corner scale keeps aspect and opposing corner');
  close(gizmo.rotateStickerQuadByDegrees(quad, 90), { tl: [0.55, 0.4], tr: [0.55, 0.6] }, 'rotation around the affine centre');
  close(gizmo.scaleStickerQuadAroundCentre(quad, 2), { tl: [0.3, 0.4], tr: [0.7, 0.4], bl: [0.3, 0.6] }, 'uniform scale');
  close(gizmo.scaleStickerQuadAxisAroundCentre(quad, 'x', 2), { tl: [0.3, 0.45], tr: [0.7, 0.45], bl: [0.3, 0.55] }, 'X-only scale');
  close(gizmo.scaleStickerQuadAxisAroundCentre(quad, 'y', 0.5), { tl: [0.4, 0.475], tr: [0.6, 0.475], bl: [0.4, 0.525] }, 'Y-only scale');

  close(gizmo.stickerGizmoScreenAxisRatio({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 98, y: 2 }, { x: 147, y: -20 }), 1.5,
    'screen-space ratio projects onto the original handle direction');
  const clampedRatio = gizmo.stickerGizmoScreenAxisRatio({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: -100, y: 0 });
  close(clampedRatio, 0.05, 'screen-space ratio clamps safely when dragged through centre');
  const clampedAxis = gizmo.scaleStickerQuadAxisAroundCentre(quad, 'x', clampedRatio);
  assert.ok([...clampedAxis.tl, ...clampedAxis.tr, ...clampedAxis.bl].every(Number.isFinite), 'clamped edge scale stays finite');

  close(gizmo.moveStickerQuadByUvDelta(quad, [0.46, 0.48], [0.71, 0.28]), { tl: [0.65, 0.25], tr: [0.85, 0.25] },
    'move uses the UV delta from the grabbed point, not the quad centre');
  const seam: StickerPlacementQuad = { tl: [0.92, 0.45], tr: [1.02, 0.45], bl: [0.92, 0.55] };
  close(gizmo.moveStickerQuadByUvDelta(seam, [0.98, 0.5], [0.03, 0.5]).tl, [0.95, 0.45], 'move keeps the centre recoverable across the seam');
});
