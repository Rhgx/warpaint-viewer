// Compact 2D sticker editor geometry contract check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as geometry from '../../../src/editor/sticker/stickerGeometry';
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
  close(geometry.stickerPlacementToQuad(geometry.clampStickerPlacement(placement)), edgeLogo, 'authored edge clipping is preserved');
});
