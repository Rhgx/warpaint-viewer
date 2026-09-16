// stickerCoverageQuad: the parallelogram Source paints for sheared sticker corners.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { stickerCoverageQuad, type StickerAffineQuad } from '../../../src/editor/stickerGeometry';

type Pt = readonly [number, number];
const close = (a: Pt, b: Pt, msg: string) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9, `${msg}: ${a} != ${b}`);

/** Source's per-edge projection of a dest pixel to sticker (a, b). */
function project({ tl, tr, bl }: StickerAffineQuad, p: Pt): Pt {
  const u = [tr[0] - tl[0], tr[1] - tl[1]], v = [bl[0] - tl[0], bl[1] - tl[1]], r = [p[0] - tl[0], p[1] - tl[1]];
  return [(r[0] * u[0] + r[1] * u[1]) / (u[0] * u[0] + u[1] * u[1]), (r[0] * v[0] + r[1] * v[1]) / (v[0] * v[0] + v[1] * v[1])];
}

test('perpendicular and degenerate quads are unchanged', () => {
  const s = Math.SQRT1_2;
  for (const quad of [
    { tl: [0.2, 0.3], tr: [0.6, 0.3], bl: [0.2, 0.7] },
    { tl: [0.5, 0.5], tr: [0.5 + 0.3 * s, 0.5 + 0.3 * s], bl: [0.5 - 0.2 * s, 0.5 + 0.2 * s] },
    { tl: [0, 0], tr: [0, 0], bl: [0, 0.5] },
    { tl: [0, 0], tr: [1, 1], bl: [0.5, 0.5] },
  ] as StickerAffineQuad[]) {
    const c = stickerCoverageQuad(quad);
    close(c.tr, quad.tr, 'tr');
    close(c.bl, quad.bl, 'bl');
  }
});

test('sheared quads round trip through the projection', () => {
  // Amputator "Alliance Anodized" and Nutcracker Mk.II on the Crusader's Crossbow.
  for (const quad of [
    { tl: [0, 0.555], tr: [1, 0], bl: [0.175, 0.555] },
    { tl: [0, 0], tr: [0.1, 0.5], bl: [0.5, 0.1] },
  ] as StickerAffineQuad[]) {
    const c = stickerCoverageQuad(quad);
    close(project(quad, c.tr), [1, 0], 'tr');
    close(project(quad, c.bl), [0, 1], 'bl');
  }
  // The amputator stripe is u in [0, 0.175] across the whole blade height.
  const amputator: StickerAffineQuad = { tl: [0, 0.555], tr: [1, 0], bl: [0.175, 0.555] };
  assert.ok(project(amputator, [0.1, 0.2]).every((t) => t >= 0 && t <= 1));
  assert.ok(project(amputator, [0.3, 0.2])[1] > 1);
});
