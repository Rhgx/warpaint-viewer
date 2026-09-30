/**
 * UV-space transforms used by the on-model sticker gizmo.  The gizmo is only
 * a view/control surface: these helpers always return the three authored
 * destination points rather than introducing a world-space decal transform.
 */
import {
  constrainStickerQuadToTexture,
  nearestPeriodicUv,
  stickerQuadCenter,
  type StickerPlacementQuad,
  type StickerUv,
} from './viewerStickerPlacement';

export type StickerGizmoHandleKind =
  | 'move'
  | 'rotate'
  | 'scale-top-left'
  | 'scale-top'
  | 'scale-top-right'
  | 'scale-right'
  | 'scale-bottom-right'
  | 'scale-bottom'
  | 'scale-bottom-left'
  | 'scale-left';

/** The one direct-manipulation affordance currently shown on the model. */
export type StickerGizmoTool = 'move' | 'scale' | 'turn';

export type StickerGizmoIntent = 'move' | 'scale' | 'rotate';

export interface StickerGizmoScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface StickerGizmoScreenLayout {
  readonly corners: readonly [StickerGizmoScreenPoint, StickerGizmoScreenPoint, StickerGizmoScreenPoint, StickerGizmoScreenPoint];
  readonly centre: StickerGizmoScreenPoint;
  readonly handles: Readonly<Record<StickerGizmoHandleKind, StickerGizmoScreenPoint>>;
}

export interface StickerGizmoProjectedUvSample {
  readonly uv: readonly [number, number];
  readonly point: StickerGizmoScreenPoint | null | undefined;
}

/** Compact screen controls used when only a coherent same-chart proxy is visible. */
export function stickerGizmoFallbackHandles(anchor: StickerGizmoScreenPoint) {
  return {
    x: { x: anchor.x + 30, y: anchor.y },
    y: { x: anchor.x, y: anchor.y + 30 },
    uniform: { x: anchor.x + 22, y: anchor.y + 22 },
    turn: { x: anchor.x, y: anchor.y - 30 },
  } as const;
}

function finiteScreenPoint(point: StickerGizmoScreenPoint | null | undefined): point is StickerGizmoScreenPoint {
  return point !== null && point !== undefined && Number.isFinite(point.x) && Number.isFinite(point.y);
}

/**
 * Prefer the true projected UV centre, falling back to the average of visible
 * boundary samples when that UV happens to lie on occluded geometry.
 */
export function deriveStickerGizmoScreenCentre(
  projectedCentre: StickerGizmoScreenPoint | null | undefined,
  authoredCentre: readonly [number, number],
  boundarySamples: readonly StickerGizmoProjectedUvSample[],
): StickerGizmoScreenPoint | null {
  if (finiteScreenPoint(projectedCentre)) return projectedCentre;
  if (!Number.isFinite(authoredCentre[0]) || !Number.isFinite(authoredCentre[1])) return null;
  let closest: StickerGizmoScreenPoint | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const sample of boundarySamples) {
    if (!finiteScreenPoint(sample.point) || !Number.isFinite(sample.uv[0]) || !Number.isFinite(sample.uv[1])) continue;
    // The same periodic distance used by the sticker compositor keeps a seam
    // decal's centre attached to its nearest visible boundary sample.
    const du = sample.uv[0] + Math.round(authoredCentre[0] - sample.uv[0]) - authoredCentre[0];
    const dv = sample.uv[1] + Math.round(authoredCentre[1] - sample.uv[1]) - authoredCentre[1];
    const distance = du * du + dv * dv;
    if (distance < closestDistance) {
      closest = sample.point;
      closestDistance = distance;
    }
  }
  return closest;
}

/** A convex screen-space hull for the actually visible boundary samples. */
export function stickerGizmoScreenHull(points: readonly (StickerGizmoScreenPoint | null | undefined)[]): StickerGizmoScreenPoint[] {
  const unique = new Map<string, StickerGizmoScreenPoint>();
  for (const point of points) {
    if (!finiteScreenPoint(point)) continue;
    unique.set(`${point.x.toFixed(4)},${point.y.toFixed(4)}`, point);
  }
  const ordered = [...unique.values()].sort((a, b) => a.x - b.x || a.y - b.y);
  if (ordered.length <= 2) return ordered;
  const cross = (origin: StickerGizmoScreenPoint, a: StickerGizmoScreenPoint, b: StickerGizmoScreenPoint) => (
    (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
  );
  const build = (items: readonly StickerGizmoScreenPoint[]) => {
    const hull: StickerGizmoScreenPoint[] = [];
    for (const point of items) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], point) <= 0) hull.pop();
      hull.push(point);
    }
    return hull;
  };
  const lower = build(ordered);
  const upper = build([...ordered].reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Place a turn grab outside a visible top edge, or directly above its centre. */
export function stickerGizmoTurnHandle(
  centre: StickerGizmoScreenPoint,
  topBoundary?: StickerGizmoScreenPoint | null,
): StickerGizmoScreenPoint {
  if (finiteScreenPoint(topBoundary)) {
    const x = topBoundary.x - centre.x;
    const y = topBoundary.y - centre.y;
    const length = Math.hypot(x, y);
    if (length > 0.5) {
      const distance = Math.min(42, Math.max(24, length * 0.65 + 14));
      return { x: centre.x + (x / length) * distance, y: centre.y + (y / length) * distance };
    }
  }
  return { x: centre.x, y: centre.y - 30 };
}

/** A scale grip needs a real screen direction away from its transform centre. */
export function hasUsableStickerGizmoScaleDirection(
  centre: StickerGizmoScreenPoint | null | undefined,
  handle: StickerGizmoScreenPoint | null | undefined,
  minimumDistance = 4,
): boolean {
  if (!finiteScreenPoint(centre) || !finiteScreenPoint(handle) || !Number.isFinite(minimumDistance)) return false;
  return Math.hypot(handle.x - centre.x, handle.y - centre.y) >= Math.max(0, minimumDistance);
}

/**
 * Returns true for a point inside (or exactly on) the projected sticker
 * outline.  This deliberately works in screen space: it is used only to
 * route pointer ownership before the viewer converts a live drag back to UVs.
 */
export function pointIsInsideStickerGizmoScreenOutline(
  point: StickerGizmoScreenPoint,
  outline: readonly StickerGizmoScreenPoint[],
): boolean {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || outline.length < 3) return false;
  let inside = false;
  for (let index = 0, previous = outline.length - 1; index < outline.length; previous = index, index += 1) {
    const a = outline[previous];
    const b = outline[index];
    if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const cross = (point.x - a.x) * dy - (point.y - a.y) * dx;
    const dot = (point.x - a.x) * dx + (point.y - a.y) * dy;
    // Treat the outline itself as a move target too; it avoids a frustrating
    // one-pixel fall-through to inspect rotation beside a scale handle.
    if (Math.abs(cross) <= 0.001 && dot >= -0.001 && dot <= dx * dx + dy * dy + 0.001) return true;
    const crossesScanline = (a.y > point.y) !== (b.y > point.y);
    if (crossesScanline && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

function finiteUv(uv: StickerUv): boolean {
  return Number.isFinite(uv[0]) && Number.isFinite(uv[1]);
}

function validQuad(quad: StickerPlacementQuad): boolean {
  return [quad.tl, quad.tr, quad.bl].every(finiteUv);
}

function bottomRight(quad: StickerPlacementQuad): [number, number] {
  return [
    quad.tr[0] + quad.bl[0] - quad.tl[0],
    quad.tr[1] + quad.bl[1] - quad.tl[1],
  ];
}

function midpoint(a: StickerGizmoScreenPoint, b: StickerGizmoScreenPoint): StickerGizmoScreenPoint {
  return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
}

/** Derive a compact screen-space control layout from projected UV corners. */
export function createStickerGizmoScreenLayout(
  topLeft: StickerGizmoScreenPoint,
  topRight: StickerGizmoScreenPoint,
  bottomRightPoint: StickerGizmoScreenPoint,
  bottomLeft: StickerGizmoScreenPoint,
): StickerGizmoScreenLayout {
  const centre = midpoint(midpoint(topLeft, bottomRightPoint), midpoint(topRight, bottomLeft));
  const top = midpoint(topLeft, topRight);
  const right = midpoint(topRight, bottomRightPoint);
  const bottom = midpoint(bottomLeft, bottomRightPoint);
  const left = midpoint(topLeft, bottomLeft);
  const rotate = stickerGizmoTurnHandle(centre, top);
  return {
    corners: [topLeft, topRight, bottomRightPoint, bottomLeft],
    centre,
    handles: {
      move: centre,
      rotate,
      'scale-top-left': topLeft,
      'scale-top': top,
      'scale-top-right': topRight,
      'scale-right': right,
      'scale-bottom-right': bottomRightPoint,
      'scale-bottom': bottom,
      'scale-bottom-left': bottomLeft,
      'scale-left': left,
    },
  };
}

export function stickerGizmoIntentForHandle(handle: StickerGizmoHandleKind): StickerGizmoIntent {
  if (handle === 'move') return 'move';
  return handle === 'rotate' ? 'rotate' : 'scale';
}

/** Translate an affine sticker by the UV delta between its grab and current hit. */
export function moveStickerQuadByUvDelta(
  quad: StickerPlacementQuad,
  startUv: StickerUv,
  currentUv: StickerUv,
): StickerPlacementQuad {
  if (![quad.tl, quad.tr, quad.bl, startUv, currentUv].every(finiteUv)) return quad;
  // Keep ordinary 0/1 seams compact instead of interpreting a short drag as
  // a full-texture jump. Unlike centre-following movement, this preserves the
  // exact point the user grabbed under their cursor.
  const target = nearestPeriodicUv(startUv, currentUv);
  const dx = target[0] - startUv[0];
  const dy = target[1] - startUv[1];
  return constrainStickerQuadToTexture({
    tl: [quad.tl[0] + dx, quad.tl[1] + dy],
    tr: [quad.tr[0] + dx, quad.tr[1] + dy],
    bl: [quad.bl[0] + dx, quad.bl[1] + dy],
  });
}

function scaleAlong(
  fixed: StickerUv,
  movingReference: StickerUv,
  pointer: StickerUv,
): number {
  const target = nearestPeriodicUv(movingReference, pointer);
  const basisX = movingReference[0] - fixed[0];
  const basisY = movingReference[1] - fixed[1];
  const lengthSquared = basisX * basisX + basisY * basisY;
  if (lengthSquared < 1e-12) return 1;
  const projected = ((target[0] - fixed[0]) * basisX + (target[1] - fixed[1]) * basisY) / lengthSquared;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, projected));
}

function scaleUniformFromCorner(
  quad: StickerPlacementQuad,
  fixed: StickerUv,
  moving: StickerUv,
  pointer: StickerUv,
): StickerPlacementQuad {
  const scale = scaleAlong(fixed, moving, pointer);
  const around = (point: StickerUv): [number, number] => [
    fixed[0] + (point[0] - fixed[0]) * scale,
    fixed[1] + (point[1] - fixed[1]) * scale,
  ];
  return { tl: around(quad.tl), tr: around(quad.tr), bl: around(quad.bl) };
}

/**
 * Resize a destination quad from a 3D gizmo scale handle.  Edge handles keep
 * the opposite edge fixed; corner handles preserve the sticker's affine
 * shape and aspect ratio around the opposing corner.
 */
export function scaleStickerQuadFromGizmo(
  quad: StickerPlacementQuad,
  handle: Exclude<StickerGizmoHandleKind, 'move' | 'rotate'>,
  pointer: StickerUv,
): StickerPlacementQuad {
  if (!validQuad(quad) || !finiteUv(pointer)) return quad;
  const br = bottomRight(quad);
  let result = quad;
  switch (handle) {
    case 'scale-top-left':
      result = scaleUniformFromCorner(quad, br, quad.tl, pointer);
      break;
    case 'scale-top-right':
      result = scaleUniformFromCorner(quad, quad.bl, quad.tr, pointer);
      break;
    case 'scale-bottom-right':
      result = scaleUniformFromCorner(quad, quad.tl, br, pointer);
      break;
    case 'scale-bottom-left':
      result = scaleUniformFromCorner(quad, quad.tr, quad.bl, pointer);
      break;
  }
  return constrainStickerQuadToTexture(result);
}

/** Uniformly scale an authored destination around its centre from a screen ratio. */
export function scaleStickerQuadAroundCentre(
  quad: StickerPlacementQuad,
  ratio: number,
): StickerPlacementQuad {
  if (!validQuad(quad) || !Number.isFinite(ratio)) return quad;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, ratio));
  const centre = stickerQuadCenter(quad);
  const around = (point: StickerUv): [number, number] => [
    centre[0] + (point[0] - centre[0]) * scale,
    centre[1] + (point[1] - centre[1]) * scale,
  ];
  return constrainStickerQuadToTexture({ tl: around(quad.tl), tr: around(quad.tr), bl: around(quad.bl) });
}

/** Scale only one local affine axis while keeping the sticker centre fixed. */
export function scaleStickerQuadAxisAroundCentre(
  quad: StickerPlacementQuad,
  axis: 'x' | 'y',
  ratio: number,
): StickerPlacementQuad {
  if (!validQuad(quad) || !Number.isFinite(ratio)) return quad;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, ratio));
  const centre = stickerQuadCenter(quad);
  const x = [quad.tr[0] - quad.tl[0], quad.tr[1] - quad.tl[1]] as const;
  const y = [quad.bl[0] - quad.tl[0], quad.bl[1] - quad.tl[1]] as const;
  const scaledX = axis === 'x' ? [x[0] * scale, x[1] * scale] as const : x;
  const scaledY = axis === 'y' ? [y[0] * scale, y[1] * scale] as const : y;
  return constrainStickerQuadToTexture({
    tl: [centre[0] - (scaledX[0] + scaledY[0]) * 0.5, centre[1] - (scaledX[1] + scaledY[1]) * 0.5],
    tr: [centre[0] + (scaledX[0] - scaledY[0]) * 0.5, centre[1] + (scaledX[1] - scaledY[1]) * 0.5],
    bl: [centre[0] + (scaledY[0] - scaledX[0]) * 0.5, centre[1] + (scaledY[1] - scaledX[1]) * 0.5],
  });
}

/**
 * Ratio for a screen-space scale drag. The handle direction is fixed at drag
 * start, so scale continues naturally even after the pointer leaves the mesh.
 */
export function stickerGizmoScreenAxisRatio(
  centre: StickerGizmoScreenPoint,
  handle: StickerGizmoScreenPoint,
  startPointer: StickerGizmoScreenPoint,
  currentPointer: StickerGizmoScreenPoint,
): number {
  const x = handle.x - centre.x;
  const y = handle.y - centre.y;
  const lengthSquared = x * x + y * y;
  if (!Number.isFinite(lengthSquared) || lengthSquared < 1e-6) return 1;
  const startProjection = (startPointer.x - centre.x) * x + (startPointer.y - centre.y) * y;
  const currentProjection = (currentPointer.x - centre.x) * x + (currentPointer.y - centre.y) * y;
  if (!Number.isFinite(startProjection) || !Number.isFinite(currentProjection) || Math.abs(startProjection) < 1e-6) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, currentProjection / startProjection));
}

/**
 * An anchored physical UV chart remains meaningful only while it contains the
 * sticker's authored centre (target zero). Visibility is deliberately not
 * considered here: a temporarily occluded chart must stay sticky.
 */
export function stickerGizmoAnchorContainsCentre(containedTargets: readonly boolean[]): boolean {
  return containedTargets[0] === true;
}

/** Rotate all authored destination points around their affine centre. */
export function rotateStickerQuadByDegrees(quad: StickerPlacementQuad, degrees: number): StickerPlacementQuad {
  if (!validQuad(quad) || !Number.isFinite(degrees)) return quad;
  const centre = stickerQuadCenter(quad);
  const radians = degrees * (Math.PI / 180);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotate = (point: StickerUv): [number, number] => {
    const x = point[0] - centre[0];
    const y = point[1] - centre[1];
    return [centre[0] + x * cos - y * sin, centre[1] + x * sin + y * cos];
  };
  return constrainStickerQuadToTexture({ tl: rotate(quad.tl), tr: rotate(quad.tr), bl: rotate(quad.bl) });
}
