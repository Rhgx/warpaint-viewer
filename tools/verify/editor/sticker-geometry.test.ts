// Sticker UV geometry, coverage, gizmo, viewport, and 2D/3D alignment contracts.

import assert from 'node:assert/strict';
import { test } from 'vitest';

import * as geometry from '../../../src/editor/sticker/stickerGeometry';
import * as gizmo from '../../../src/editor/sticker/stickerGizmo';
import * as rows from '../../../src/editor/sticker/stickerSurface';
import * as viewport from '../../../src/editor/sticker/stickerViewport';
import {
  constrainStickerQuadToTexture,
  moveStickerQuadToUv,
  nearestPeriodicUv,
  stickerQuadCenter,
  type StickerPlacementQuad,
} from '../../../src/editor/sticker/viewerStickerPlacement';
import { close } from '../fixtures';

const base = { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 };

test('a rotated placement round-trips through its authored quad', () => {
  const original = { x: 0.37, y: 0.58, width: 0.28, height: 0.11, rotation: 31 };
  const quad = geometry.stickerPlacementToQuad(original);
  assert.ok(quad, 'valid placement emits an authored quad');
  const parsed = geometry.stickerPlacementFromQuad(quad);
  assert.equal(parsed.editable, true, 'rotated rectangle stays editable');
  close(parsed.placement, original, 'quad round-trip');
});

test('editability: float noise, shear and mirroring stay editable; collapsed and collinear quads do not', () => {
  // Fantach Rocket Launcher stickers 1 and 2: ordinary proto float noise.
  for (const quad of [
    { tl: [0.1061291099, 0.05910533667], tr: [0.1061293483, 0.128580153], bl: [0.03665441275, 0.05910533667] },
    { tl: [0.2066156268, 0.1291550994], tr: [0.2066156268, 0.05968052149], bl: [0.2760903239, 0.1291549802] },
    { tl: [0, 0], tr: [0.4, 0], bl: [0.1, 0.2] },
    { tl: [0, 0], tr: [0.4, 0], bl: [0, -0.2] },
  ] as const) assert.equal(geometry.stickerPlacementFromQuad(quad).editable, true, JSON.stringify(quad));

  const collapsed = geometry.stickerPlacementFromQuad({ tl: [0, 0], tr: [0, 0], bl: [0, 0] });
  assert.equal(collapsed.editable, false, 'a collapsed quad requires initialization');
  assert.match(collapsed.reason ?? '', /all three corner points/i);
  const recovered = geometry.stickerPlacementToQuad(geometry.fitStickerPlacement(2));
  assert.ok(recovered);
  assert.equal(geometry.stickerPlacementFromQuad(recovered).editable, true, 'the aspect-aware starting placement recovers a collapsed quad');
  const collinear = geometry.stickerPlacementFromQuad({ tl: [0, 0], tr: [0.4, 0], bl: [0.2, 0] });
  assert.equal(collinear.editable, false, 'a collinear quad remains read-only');
  assert.match(collinear.reason ?? '', /straight line/i);
});

test('moving a sheared quad keeps its shear, and editing one uses the painted rectangle', () => {
  const authored = { tl: [0.2, 0.2], tr: [0.4, 0.2], bl: [0.200836, 0.4] } as const;
  const placement = geometry.stickerPlacementFromQuad(authored).placement;
  assert.ok(placement);
  const moved = geometry.applyStickerPlacementToQuad(authored, { ...placement, x: placement.x + 0.1 });
  close(moved, { tl: [0.3, 0.2], tr: [0.5, 0.2], bl: [0.300836, 0.4] }, 'affine movement preserves authored shear');

  const amputator = { tl: [0, 0.555], tr: [1, 0], bl: [0.175, 0.555] } as const;
  const target = { x: 0.4, y: 0.45, width: 0.6, height: 0.2, rotation: 25 };
  const edited = geometry.applyStickerPlacementToQuad(amputator, target);
  assert.ok(edited);
  close(geometry.stickerPlacementFromQuad(edited).placement, target, 'sheared editor change');
});

test('resize, snap and texture constraints', () => {
  close(geometry.resizeStickerFromCorner(base, 'bottom-right', { x: 0.7, y: 0.6 }), { x: 0.55, y: 0.525, width: 0.3, height: 0.15 }, 'corner resize');
  const locked = geometry.resizeStickerFromCorner(base, 'bottom-right', { x: 0.65, y: 0.7 }, { preserveAspect: true });
  close(locked.width / locked.height, 2, 'locked corner resize keeps artwork ratio');
  close([locked.x - locked.width / 2, locked.y - locked.height / 2], [0.4, 0.45], 'locked resize holds the opposite corner');
  close(geometry.resizeStickerFromEdge(base, 'right', { x: 0.7, y: 0.9 }), { x: 0.55, y: 0.5, width: 0.3, height: 0.1 }, 'right edge resize');

  close(
    geometry.snapStickerPlacement({ x: 0.513, y: 0.487, width: 0.263, height: 0.236, rotation: 22 }, 0.025),
    { x: 0.525, y: 0.475, width: 0.275, height: 0.225, rotation: 15 },
    'grid snap',
  );
  close([87, 94, 95, 179, 359].map((degrees) => geometry.snapStickerRotationToCardinal(degrees)), [90, 90, 95, 180, 0], 'cardinal rotation snap');

  close(geometry.moveStickerPlacement({ ...base, height: 0.2 }, { x: 0.8, y: 0 }).x, 1, 'movement stops while its anchor remains recoverable');
  close(geometry.constrainStickerPlacementToTexture({ x: 0.5, y: 0.5, width: 2, height: 1, rotation: 45 }), { width: 1.5, height: 1 }, 'oversized cap');

  const edgeLogo = { tl: [0.634, 0.177], tr: [0.428, 0.177], bl: [0.634, -0.029] } as const;
  const placement = geometry.stickerPlacementFromQuad(edgeLogo).placement;
  assert.ok(placement, 'Flak Furnished edge logo remains a supported placement');
  close(geometry.stickerPlacementToQuad(geometry.constrainStickerPlacementToTexture(placement)), edgeLogo, 'authored edge clipping is preserved');
});

test('sticker coverage preserves perpendicular quads and squares sheared quads', () => {
  const s = Math.SQRT1_2;
  for (const quad of [
    { tl: [0.2, 0.3], tr: [0.6, 0.3], bl: [0.2, 0.7] },
    { tl: [0.5, 0.5], tr: [0.5 + 0.3 * s, 0.5 + 0.3 * s], bl: [0.5 - 0.2 * s, 0.5 + 0.2 * s] },
    { tl: [0, 0], tr: [0.3, 0], bl: [0, 0] },
  ] as geometry.StickerAffineQuad[]) {
    const c = geometry.stickerCoverageQuad(quad);
    close(c.tr, quad.tr, 'tr');
    close(c.bl, quad.bl, 'bl');
  }

  // Alliance Anodized on the Amputator: TL->BL is kept, TL->TR turns perpendicular with its full length.
  const amputator = geometry.stickerCoverageQuad({ tl: [0, 0.555], tr: [1, 0], bl: [0.175, 0.555] });
  close(amputator.tr, [0, 0.555 - Math.hypot(1, 0.555)], 'amputator tr');
  close(amputator.bl, [0.175, 0.555], 'amputator bl');
  // Nutcracker Mk.II on the Crusader's Crossbow: mirrored placement, edge stays on the TR side.
  const crossbow = geometry.stickerCoverageQuad({ tl: [0, 0], tr: [0.1, 0.5], bl: [0.5, 0.1] });
  assert.ok(Math.abs(crossbow.tr[0] * 0.5 + crossbow.tr[1] * 0.1) < 1e-9, 'perpendicular to TL->BL');
  assert.ok(Math.abs(Math.hypot(...crossbow.tr) - Math.hypot(0.1, 0.5)) < 1e-9, 'keeps |TL->TR|');
  assert.ok(crossbow.tr[0] * 0.1 + crossbow.tr[1] * 0.5 > 0, 'points towards TR');
  const read = geometry.stickerPlacementFromQuad({ tl: [0, 0.555], tr: [1, 0], bl: [0.175, 0.555] });
  assert.ok(read.editable && Math.abs(read.placement!.width - Math.hypot(1, 0.555)) < 1e-9 && Math.abs(read.placement!.height - 0.175) < 1e-9);
});

test('viewer sticker placement geometry', () => {
  const quad: StickerPlacementQuad = { tl: [0.2, 0.3], tr: [0.5, 0.4], bl: [0.1, 0.7] };
  close(stickerQuadCenter(quad), [0.3, 0.55], 'centre includes both affine basis vectors');

  const moved = moveStickerQuadToUv(quad, [0.7, 0.15]);
  close(stickerQuadCenter(moved), [0.7, 0.15], 'movement follows the picked UV while its centre remains recoverable');
  close(
    [moved.tr[0] - moved.tl[0], moved.tr[1] - moved.tl[1], moved.bl[0] - moved.tl[0], moved.bl[1] - moved.tl[1]],
    [quad.tr[0] - quad.tl[0], quad.tr[1] - quad.tl[1], quad.bl[0] - quad.tl[0], quad.bl[1] - quad.tl[1]],
    'moving preserves the authored affine shape',
  );

  assert.deepEqual(nearestPeriodicUv([0.98, 0.5], [0.02, 0.5]), [1.02, 0.5], 'wrap seam picks the nearby periodic copy');
  const seamQuad: StickerPlacementQuad = { tl: [0.92, 0.45], tr: [1.02, 0.45], bl: [0.92, 0.55] };
  close(stickerQuadCenter(moveStickerQuadToUv(seamQuad, [0.03, 0.5])), [1, 0.5], 'seam movement keeps its anchor at the texture edge');

  const oversized = constrainStickerQuadToTexture({ tl: [-0.5, -0.5], tr: [1.5, -0.5], bl: [-0.5, 1.5] });
  close(oversized, { tl: [-0.25, -0.25], tr: [1.25, -0.25], bl: [-0.25, 1.25] }, 'oversized placement is centred with capped edges');

  const invalid: StickerPlacementQuad = { tl: [Number.NaN, 0], tr: [0.1, 0], bl: [0, 0.1] };
  assert.equal(moveStickerQuadToUv(invalid, [0.5, 0.5]), invalid, 'bad input is refused without emitting NaN values');
});

test('sticker gizmo anchors, visibility, scale, rotate, and move', () => {
  const quad: StickerPlacementQuad = { tl: [0.4, 0.45], tr: [0.6, 0.45], bl: [0.4, 0.55] };
  assert.equal(gizmo.stickerGizmoAnchorContainsCentre([true, false, false]), true);
  assert.equal(gizmo.stickerGizmoAnchorContainsCentre([false, true, true]), false);
  assert.deepEqual(gizmo.deriveStickerGizmoScreenCentre(null, [0.5, 0.5], [
    { uv: [0.4, 0.45], point: { x: 20, y: 20 } },
    { uv: [0.5, 0.45], point: { x: 60, y: 20 } },
    { uv: [0.6, 0.45], point: null },
  ]), { x: 60, y: 20 });
  assert.equal(gizmo.deriveStickerGizmoScreenCentre(null, [0.5, 0.5], [{ uv: [0.4, 0.4], point: null }]), null);
  assert.equal(gizmo.hasUsableStickerGizmoScaleDirection({ x: 60, y: 20 }, { x: 60, y: 20 }), false);
  assert.equal(gizmo.hasUsableStickerGizmoScaleDirection({ x: 60, y: 20 }, { x: 68, y: 20 }), true);

  close(gizmo.rotateStickerQuadByDegrees(quad, 90), { tl: [0.55, 0.4], tr: [0.55, 0.6] }, 'rotation around affine centre');
  close(gizmo.scaleStickerQuadAroundCentre(quad, 2), { tl: [0.3, 0.4], tr: [0.7, 0.4], bl: [0.3, 0.6] }, 'uniform scale');
  close(gizmo.scaleStickerQuadAxisAroundCentre(quad, 'x', 2), { tl: [0.3, 0.45], tr: [0.7, 0.45], bl: [0.3, 0.55] }, 'X-only scale');
  close(gizmo.scaleStickerQuadAxisAroundCentre(quad, 'y', 0.5), { tl: [0.4, 0.475], tr: [0.6, 0.475], bl: [0.4, 0.525] }, 'Y-only scale');

  close(gizmo.stickerGizmoScreenAxisRatio({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 98, y: 2 }, { x: 147, y: -20 }), 1.5, 'screen-space ratio');
  const clampedRatio = gizmo.stickerGizmoScreenAxisRatio({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: -100, y: 0 });
  close(clampedRatio, 0.05, 'clamped screen-space ratio');
  const clampedAxis = gizmo.scaleStickerQuadAxisAroundCentre(quad, 'x', clampedRatio);
  assert.ok([...clampedAxis.tl, ...clampedAxis.tr, ...clampedAxis.bl].every(Number.isFinite));

  close(gizmo.moveStickerQuadByUvDelta(quad, [0.46, 0.48], [0.71, 0.28]), { tl: [0.65, 0.25], tr: [0.85, 0.25] }, 'move uses UV delta');
  const seam: StickerPlacementQuad = { tl: [0.92, 0.45], tr: [1.02, 0.45], bl: [0.92, 0.55] };
  close(gizmo.moveStickerQuadByUvDelta(seam, [0.98, 0.5], [0.03, 0.5]).tl, [0.95, 0.45], 'seam move keeps centre recoverable');
});

test('sticker viewport UV zoom/pan and 2D/compositor alignment', () => {
  const size = { width: 640, height: 400 };
  const before = { zoom: 1.5, panX: -140, panY: -96 };
  const pointer = { x: 332, y: 174 };
  const beforeUv = viewport.stickerViewportPointToUv(pointer, before, size);
  const zoomed = viewport.zoomStickerViewportAt(before, 3, pointer, size);
  close(viewport.stickerViewportPointToUv(pointer, zoomed, size), { x: beforeUv.x, y: beforeUv.y }, 'pointer-centred zoom preserves UV');
  assert.deepEqual(viewport.normalizeStickerViewport({ zoom: 1, panX: 99, panY: -99 }, size), { zoom: 1, panX: 0, panY: 0 });

  const placement = { x: 0.23, y: 0.71, width: 0.18, height: 0.12, rotation: 0 };
  const quad = geometry.stickerPlacementToQuad(placement);
  assert.ok(quad);
  close(quad, { tl: [0.14, 0.65], tr: [0.32, 0.65], bl: [0.14, 0.77] }, 'authored quad');
  close(
    viewport.stickerViewportPointToUv({ x: 92, y: 142 }, viewport.DEFAULT_STICKER_VIEWPORT, { width: 400, height: 200 }),
    { x: placement.x, y: placement.y },
    '2D pointer matches authored/3D UV',
  );

  const readback = new Uint8ClampedArray([
    255, 0, 0, 17, 0, 255, 0, 18,
    0, 0, 255, 19, 255, 255, 0, 20,
  ]);
  assert.deepEqual([...rows.compositorReadbackToEditorPixels(readback, 2, 2)], [
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ]);
  assert.deepEqual([...rows.compositorReadbackToEditorPixels(readback, 2, 2, false)], [...readback]);
});
