/**
 * UV-space operations shared by the 2D sticker canvas and the Viewer-side
 * placement gesture. A sticker destination is a parallelogram: TL, TR and BL
 * are authored, and BR is implied. Keeping the maths here means the two views
 * update exactly the same three proto fields.
 */
export type StickerUv = readonly [number, number];

export interface StickerPlacementQuad {
  readonly tl: StickerUv;
  readonly tr: StickerUv;
  readonly bl: StickerUv;
}

/** The affine centre of the sticker parallelogram, including rotation/skew. */
export function stickerQuadCenter(quad: StickerPlacementQuad): [number, number] {
  return [
    quad.tl[0] + (quad.tr[0] - quad.tl[0] + quad.bl[0] - quad.tl[0]) * 0.5,
    quad.tl[1] + (quad.tr[1] - quad.tl[1] + quad.bl[1] - quad.tl[1]) * 0.5,
  ];
}

/**
 * Chooses the periodic copy of `candidate` nearest `reference`.
 *
 * UV wrap makes 0.99 and 0.01 adjacent. We intentionally return an
 * unwrapped coordinate so a quad can cross that seam without being stretched
 * across the full texture. Consumers may later serialize it as-is: the game
 * sampler wraps destination coordinates in the same way.
 */
export function nearestPeriodicUv(reference: StickerUv, candidate: StickerUv): [number, number] {
  return [
    candidate[0] + Math.round(reference[0] - candidate[0]),
    candidate[1] + Math.round(reference[1] - candidate[1]),
  ];
}

function isFiniteUv(uv: StickerUv): boolean {
  return Number.isFinite(uv[0]) && Number.isFinite(uv[1]);
}

/**
 * Translates a sticker so its centre follows a picked weapon UV. Its size,
 * rotation, and skew are preserved exactly. Invalid input is returned without
 * modification rather than producing an exportable NaN destination.
 *
 * This is seam-safe for ordinary wrapping UV seams. Mirrored or overlapping
 * UV islands remain fundamentally ambiguous: one destination can legitimately
 * appear on every face sharing those UVs, which the caller should explain in
 * its UI rather than pretending that a geometry ray alone can disambiguate it.
 */
export function moveStickerQuadToUv(quad: StickerPlacementQuad, hitUv: StickerUv): StickerPlacementQuad {
  if (![quad.tl, quad.tr, quad.bl, hitUv].every(isFiniteUv)) return quad;
  const centre = stickerQuadCenter(quad);
  const target = nearestPeriodicUv(centre, hitUv);
  const dx = target[0] - centre[0];
  const dy = target[1] - centre[1];
  return {
    tl: [quad.tl[0] + dx, quad.tl[1] + dy],
    tr: [quad.tr[0] + dx, quad.tr[1] + dy],
    bl: [quad.bl[0] + dx, quad.bl[1] + dy],
  };
}
