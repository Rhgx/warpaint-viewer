// stickerCoverageQuad: the rectangle Source paints for sheared sticker corners.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { stickerCoverageQuad, stickerPlacementFromQuad, type StickerAffineQuad } from '../../../src/editor/stickerGeometry';

type Pt = readonly [number, number];
const close = (a: Pt, b: Pt, msg: string) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9, `${msg}: ${a} != ${b}`);

test('perpendicular and degenerate quads are unchanged', () => {
  const s = Math.SQRT1_2;
  for (const quad of [
    { tl: [0.2, 0.3], tr: [0.6, 0.3], bl: [0.2, 0.7] },
    { tl: [0.5, 0.5], tr: [0.5 + 0.3 * s, 0.5 + 0.3 * s], bl: [0.5 - 0.2 * s, 0.5 + 0.2 * s] },
    { tl: [0, 0], tr: [0.3, 0], bl: [0, 0] },
  ] as StickerAffineQuad[]) {
    const c = stickerCoverageQuad(quad);
    close(c.tr, quad.tr, 'tr');
    close(c.bl, quad.bl, 'bl');
  }
});

test('sheared quads become the rectangle Source paints', () => {
  // Alliance Anodized on the Amputator: TL->BL is kept, TL->TR turns perpendicular with its full length.
  const amputator = stickerCoverageQuad({ tl: [0, 0.555], tr: [1, 0], bl: [0.175, 0.555] });
  close(amputator.tr, [0, 0.555 - Math.hypot(1, 0.555)], 'amputator tr');
  close(amputator.bl, [0.175, 0.555], 'amputator bl');
  // Nutcracker Mk.II on the Crusader's Crossbow: mirrored placement, edge stays on the TR side.
  const crossbow = stickerCoverageQuad({ tl: [0, 0], tr: [0.1, 0.5], bl: [0.5, 0.1] });
  assert.ok(Math.abs(crossbow.tr[0] * 0.5 + crossbow.tr[1] * 0.1) < 1e-9, 'perpendicular to TL->BL');
  assert.ok(Math.abs(Math.hypot(...crossbow.tr) - Math.hypot(0.1, 0.5)) < 1e-9, 'keeps |TL->TR|');
  assert.ok(crossbow.tr[0] * 0.1 + crossbow.tr[1] * 0.5 > 0, 'points towards TR');
  // The compact controls read the painted rectangle, so every quad is editable.
  const read = stickerPlacementFromQuad({ tl: [0, 0.555], tr: [1, 0], bl: [0.175, 0.555] });
  assert.ok(read.editable && Math.abs(read.placement!.width - Math.hypot(1, 0.555)) < 1e-9 && Math.abs(read.placement!.height - 0.175) < 1e-9);
});
