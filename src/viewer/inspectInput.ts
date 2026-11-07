// Pointer and touch helpers for InspectControls: gesture routing, click pairs and touch pairs.

const DOUBLE_CLICK_WINDOW_MS = 350;
export const DOUBLE_CLICK_DISTANCE_PX = 6;
// Two fingertip taps rarely land within a mouse's few pixels of each other.
export const DOUBLE_TAP_SLOP_PX = 40;

/** Which inspect gesture owns a primary drag on empty canvas space. */
export type InspectPrimaryDragMode = 'rotate' | 'disabled';

/** Resolve only the inspect gesture; higher-level editors still own pointer capture. */
export function inspectDragForPointer(
  button: number,
  primaryDragMode: InspectPrimaryDragMode,
): 'none' | 'rotate' | 'pan' {
  if (button === 0) return primaryDragMode === 'disabled' ? 'none' : 'rotate';
  if (button === 1) return primaryDragMode === 'disabled' ? 'rotate' : 'pan';
  return button === 2 ? 'pan' : 'none';
}

/** Sticker placement reserves primary double-click; middle keeps a reset route. */
export function inspectDoubleClickResets(
  button: number,
  primaryDragMode: InspectPrimaryDragMode,
): boolean {
  return primaryDragMode === 'rotate' && button === 0;
}

export interface InspectPointerClick {
  readonly clientX: number;
  readonly clientY: number;
  readonly time: number;
}

/** Detect a reliable middle double-click (or, with touch slop, a double-tap) from completed gestures. */
export function isRapidInspectClickPair(
  first: InspectPointerClick,
  second: InspectPointerClick,
  maxDistancePx = DOUBLE_CLICK_DISTANCE_PX,
): boolean {
  return second.time >= first.time
    && second.time - first.time <= DOUBLE_CLICK_WINDOW_MS
    && Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY) <= maxDistancePx;
}

export interface TouchPoint {
  x: number;
  y: number;
}

/** Centroid, spread and screen angle of a two-finger touch, the baseline for pan, pinch and twist. */
export interface TouchPairSnapshot {
  readonly x: number;
  readonly y: number;
  readonly distance: number;
  /** Radians, growing clockwise on screen because client Y points down. */
  readonly angle: number;
}

export function touchPairSnapshot(a: TouchPoint, b: TouchPoint): TouchPairSnapshot {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(b.x - a.x, b.y - a.y), angle: Math.atan2(b.y - a.y, b.x - a.x) };
}

/** The shorter way from one finger-pair angle to another, so crossing the atan2 seam is not a full turn. */
export function touchPairTwist(from: TouchPairSnapshot, to: TouchPairSnapshot): number {
  const delta = to.angle - from.angle;
  return Math.atan2(Math.sin(delta), Math.cos(delta));
}
