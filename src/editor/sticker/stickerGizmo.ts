/**
 * UV-space transforms for the on-model sticker gizmo. Every helper returns the three
 * authored destination points, never a world-space decal transform.
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

/** Projected UV centre, or the closest visible boundary sample when the centre is occluded. */
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
    // The compositor's periodic distance keeps a seam decal's centre on its nearest visible sample.
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

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;

function finiteUv(uv: StickerUv): boolean {
  return Number.isFinite(uv[0]) && Number.isFinite(uv[1]);
}

function validQuad(quad: StickerPlacementQuad): boolean {
  return [quad.tl, quad.tr, quad.bl].every(finiteUv);
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
  // Keep 0/1 seams compact so a short drag is not a full-texture jump; the grabbed point stays under the cursor.
  const target = nearestPeriodicUv(startUv, currentUv);
  const dx = target[0] - startUv[0];
  const dy = target[1] - startUv[1];
  return constrainStickerQuadToTexture({
    tl: [quad.tl[0] + dx, quad.tl[1] + dy],
    tr: [quad.tr[0] + dx, quad.tr[1] + dy],
    bl: [quad.bl[0] + dx, quad.bl[1] + dy],
  });
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

/** Scale ratio for a screen-space drag. The handle direction is fixed at drag start, so scale continues off-mesh. */
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

/** An anchored chart stays valid while it contains the authored centre. Occlusion is ignored so the anchor stays sticky. */
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
