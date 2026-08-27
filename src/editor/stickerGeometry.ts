/**
 * Geometry shared by the two-dimensional and model-side sticker editors.
 *
 * All values are relative to the texture (0-1), rather than screen pixels.
 * `x` and `y` denote the centre of the sticker.  Keeping the public value in
 * this small form means a placement changed in either view is exactly the
 * same placement handed to the mutation layer.
 */
export interface StickerPlacement {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Clockwise degrees. */
  readonly rotation: number;
}

export interface StickerPoint {
  readonly x: number;
  readonly y: number;
}

/** Test a V-down UV point against a rotated sticker rectangle. */
export function stickerPlacementContainsPoint(placement: StickerPlacement, point: StickerPoint): boolean {
  const radians = -placement.rotation * Math.PI / 180;
  const dx = point.x - placement.x;
  const dy = point.y - placement.y;
  const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
  const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
  return Math.abs(localX) <= placement.width * 0.5 && Math.abs(localY) <= placement.height * 0.5;
}

export type StickerCorner = 'top-left' | 'top-right' | 'bottom-right' | 'bottom-left';
export type StickerEdge = 'top' | 'right' | 'bottom' | 'left';

export interface StickerResizeOptions {
  /** Keep the starting artwork ratio. Hold Shift in the editor to disable this. */
  readonly preserveAspect?: boolean;
}

/** The three authored points of a sticker destination parallelogram. */
export interface StickerAffineQuad {
  readonly tl: readonly [number, number];
  readonly tr: readonly [number, number];
  readonly bl: readonly [number, number];
}

/**
 * A conversion result makes unsupported artwork explicit. The compact editor
 * represents translated, rotated rectangles with independent width and height;
 * it deliberately does not pretend that a skewed or mirrored affine quad can
 * be preserved by those five controls.
 */
export interface StickerPlacementReadResult {
  readonly placement?: StickerPlacement;
  readonly editable: boolean;
  readonly reason?: string;
}

const MIN_SIZE = 0.02;
const MAX_SIZE = 1.5;
export const DEFAULT_STICKER_SNAP_STEP = 0.025;
export const DEFAULT_STICKER_TURN_SNAP = 15;
export const DEFAULT_CARDINAL_SNAP_THRESHOLD = 4;

export const DEFAULT_STICKER_PLACEMENT: StickerPlacement = Object.freeze({
  x: 0.5,
  y: 0.5,
  width: 0.24,
  height: 0.24,
  rotation: 0,
});

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function usableSnapStep(value: number, fallback: number, maximum = 1): number {
  return Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function snap(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/** Convert any finite angle to the compact -180..180 range. */
export function normalizeStickerRotation(rotation: number): number {
  const normalized = ((finite(rotation, 0) + 180) % 360 + 360) % 360 - 180;
  // Prefer 180 to -180 so the numeric editor does not appear to jump at that point.
  return normalized === -180 ? 180 : normalized;
}

/**
 * Keep the editable anchor recoverable inside the texture and cap extreme
 * scaling. TF2 deliberately permits destination corners outside 0-1 and
 * clips them at the render target edge. Several shipped definitions rely on
 * that behavior.
 */
export function constrainStickerPlacementToTexture(placement: StickerPlacement): StickerPlacement {
  const rotation = normalizeStickerRotation(placement.rotation);
  return {
    x: clamp(finite(placement.x, DEFAULT_STICKER_PLACEMENT.x), 0, 1),
    y: clamp(finite(placement.y, DEFAULT_STICKER_PLACEMENT.y), 0, 1),
    width: clamp(finite(placement.width, DEFAULT_STICKER_PLACEMENT.width), MIN_SIZE, MAX_SIZE),
    height: clamp(finite(placement.height, DEFAULT_STICKER_PLACEMENT.height), MIN_SIZE, MAX_SIZE),
    rotation,
  };
}

/** Magnetize an angle near a cardinal direction without quantizing free rotation. */
export function snapStickerRotationToCardinal(
  rotation: number,
  threshold = DEFAULT_CARDINAL_SNAP_THRESHOLD,
): number {
  const normalized = normalizeStickerRotation(rotation);
  const nearest = Math.round(normalized / 90) * 90;
  const safeThreshold = clamp(finite(threshold, DEFAULT_CARDINAL_SNAP_THRESHOLD), 0, 45);
  return Math.abs(normalizeStickerRotation(normalized - nearest)) <= safeThreshold
    ? normalizeStickerRotation(nearest)
    : normalized;
}

/** Sanitize externally supplied authored values without requiring a UI mount. */
export function clampStickerPlacement(placement: StickerPlacement): StickerPlacement {
  return constrainStickerPlacementToTexture(placement);
}

export function moveStickerPlacement(
  placement: StickerPlacement,
  delta: StickerPoint,
): StickerPlacement {
  return clampStickerPlacement({
    ...placement,
    x: placement.x + finite(delta.x, 0),
    y: placement.y + finite(delta.y, 0),
  });
}

export function rotateStickerPlacement(placement: StickerPlacement, degrees: number): StickerPlacement {
  return clampStickerPlacement({ ...placement, rotation: degrees });
}

/**
 * Align a placement with the compact editor's texture grid.  Keeping this in
 * geometry, rather than in the React editor, makes mouse, keyboard and value
 * edits agree on exactly the same grid.
 */
export function snapStickerPlacement(
  placement: StickerPlacement,
  step = DEFAULT_STICKER_SNAP_STEP,
  turnStep = DEFAULT_STICKER_TURN_SNAP,
): StickerPlacement {
  const positionStep = usableSnapStep(step, DEFAULT_STICKER_SNAP_STEP);
  const angleStep = usableSnapStep(turnStep, DEFAULT_STICKER_TURN_SNAP, 360);
  return clampStickerPlacement({
    x: snap(placement.x, positionStep),
    y: snap(placement.y, positionStep),
    width: snap(placement.width, positionStep),
    height: snap(placement.height, positionStep),
    rotation: snap(placement.rotation, angleStep),
  });
}

export function rotateStickerPoint(point: StickerPoint, degrees: number): StickerPoint {
  const radians = degrees * (Math.PI / 180);
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return {
    x: point.x * cosine - point.y * sine,
    y: point.x * sine + point.y * cosine,
  };
}

function cornerSigns(corner: StickerCorner): StickerPoint {
  switch (corner) {
    case 'top-left': return { x: -1, y: -1 };
    case 'top-right': return { x: 1, y: -1 };
    case 'bottom-right': return { x: 1, y: 1 };
    case 'bottom-left': return { x: -1, y: 1 };
  }
}

/** The four rotated texture-space vertices, useful for a model-side overlay. */
export function stickerPlacementCorners(placement: StickerPlacement): readonly StickerPoint[] {
  const value = clampStickerPlacement(placement);
  return (['top-left', 'top-right', 'bottom-right', 'bottom-left'] as const).map((corner) => {
    const signs = cornerSigns(corner);
    const offset = rotateStickerPoint({
      x: signs.x * value.width / 2,
      y: signs.y * value.height / 2,
    }, value.rotation);
    return { x: value.x + offset.x, y: value.y + offset.y };
  });
}

function isFiniteQuad(quad: StickerAffineQuad): boolean {
  return [quad.tl, quad.tr, quad.bl].every(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

/**
 * Convert the compact editor value to the exact authored three-point form.
 * Unlike clampStickerPlacement(), this function does not constrain valid
 * unwrapped positions or large dimensions, so a supported authored quad can
 * round-trip without changing its numbers.
 */
export function stickerPlacementToQuad(placement: StickerPlacement): StickerAffineQuad | undefined {
  if (![placement.x, placement.y, placement.width, placement.height, placement.rotation].every(Number.isFinite)) return undefined;
  if (placement.width <= 0 || placement.height <= 0) return undefined;
  const topRightOffset = rotateStickerPoint({ x: placement.width / 2, y: -placement.height / 2 }, placement.rotation);
  const topLeftOffset = rotateStickerPoint({ x: -placement.width / 2, y: -placement.height / 2 }, placement.rotation);
  const bottomLeftOffset = rotateStickerPoint({ x: -placement.width / 2, y: placement.height / 2 }, placement.rotation);
  return {
    tl: [placement.x + topLeftOffset.x, placement.y + topLeftOffset.y],
    tr: [placement.x + topRightOffset.x, placement.y + topRightOffset.y],
    bl: [placement.x + bottomLeftOffset.x, placement.y + bottomLeftOffset.y],
  };
}

/**
 * Read an authored affine destination into the compact transform controls.
 * The controls describe its centre and two edge lengths; callers that edit a
 * skewed quad must apply the placement delta to the original quad rather than
 * rebuilding a rectangle with stickerPlacementToQuad().
 */
export function stickerPlacementFromQuad(quad: StickerAffineQuad): StickerPlacementReadResult {
  if (!isFiniteQuad(quad)) return { editable: false, reason: 'This sticker has invalid placement data.' };
  const horizontal = { x: quad.tr[0] - quad.tl[0], y: quad.tr[1] - quad.tl[1] };
  const vertical = { x: quad.bl[0] - quad.tl[0], y: quad.bl[1] - quad.tl[1] };
  const width = Math.hypot(horizontal.x, horizontal.y);
  const height = Math.hypot(vertical.x, vertical.y);
  if (width < 1e-9 || height < 1e-9) {
    return {
      editable: false,
      reason: width < 1e-9 && height < 1e-9
        ? 'All three corner points are in the same place. The sticker needs a width and height before you can move it.'
        : 'Two corner points are in the same place. Move one point so the sticker has a width and height.',
    };
  }
  const cross = horizontal.x * vertical.y - horizontal.y * vertical.x;
  if (Math.abs(cross) <= width * height * 1e-8) {
    return {
      editable: false,
      reason: 'The three corner points are in a straight line. Move one point so the sticker has a width and height.',
    };
  }
  return {
    editable: true,
    placement: {
      x: quad.tl[0] + (horizontal.x + vertical.x) / 2,
      y: quad.tl[1] + (horizontal.y + vertical.y) / 2,
      width,
      height,
      rotation: normalizeStickerRotation(Math.atan2(horizontal.y, horizontal.x) * (180 / Math.PI)),
    },
  };
}

/** Apply a compact move/scale/rotation delta while preserving authored shear. */
export function applyStickerPlacementToQuad(
  quad: StickerAffineQuad,
  next: StickerPlacement,
): StickerAffineQuad | undefined {
  const current = stickerPlacementFromQuad(quad);
  if (!current.editable || !current.placement) return undefined;
  const source = current.placement;
  const scaleX = next.width / source.width;
  const scaleY = next.height / source.height;
  const sourceRadians = source.rotation * Math.PI / 180;
  const nextRadians = next.rotation * Math.PI / 180;
  const map = ([x, y]: readonly [number, number]): readonly [number, number] => {
    const dx = x - source.x;
    const dy = y - source.y;
    const localX = dx * Math.cos(sourceRadians) + dy * Math.sin(sourceRadians);
    const localY = -dx * Math.sin(sourceRadians) + dy * Math.cos(sourceRadians);
    return [
      next.x + localX * scaleX * Math.cos(nextRadians) - localY * scaleY * Math.sin(nextRadians),
      next.y + localX * scaleX * Math.sin(nextRadians) + localY * scaleY * Math.cos(nextRadians),
    ];
  };
  return { tl: map(quad.tl), tr: map(quad.tr), bl: map(quad.bl) };
}

/**
 * Resize from one corner while keeping the diagonally opposite corner fixed.
 * `pointer` is texture-normalized and the operation is intentionally freeform:
 * a decal may be stretched when its source definition allows it.
 */
export function resizeStickerFromCorner(
  initial: StickerPlacement,
  corner: StickerCorner,
  pointer: StickerPoint,
  options: StickerResizeOptions = {},
): StickerPlacement {
  const value = clampStickerPlacement(initial);
  const signs = cornerSigns(corner);
  const opposite = {
    x: -signs.x * value.width / 2,
    y: -signs.y * value.height / 2,
  };
  const pointerLocal = rotateStickerPoint({
    x: pointer.x - value.x,
    y: pointer.y - value.y,
  }, -value.rotation);
  const rawWidth = Math.max(MIN_SIZE, Math.abs(pointerLocal.x - opposite.x));
  const rawHeight = Math.max(MIN_SIZE, Math.abs(pointerLocal.y - opposite.y));
  const initialAspect = value.width / Math.max(value.height, MIN_SIZE);
  const nextWidth = options.preserveAspect
    ? Math.max(rawWidth, rawHeight * initialAspect)
    : rawWidth;
  const nextHeight = options.preserveAspect
    ? nextWidth / initialAspect
    : rawHeight;
  // When the aspect is locked, construct the selected corner from its signs
  // so the opposite corner stays fixed rather than drifting as we correct the
  // user's freeform pointer position.
  const selected = options.preserveAspect
    ? { x: opposite.x + signs.x * nextWidth, y: opposite.y + signs.y * nextHeight }
    : pointerLocal;
  const centreLocal = {
    x: (selected.x + opposite.x) / 2,
    y: (selected.y + opposite.y) / 2,
  };
  const centreOffset = rotateStickerPoint(centreLocal, value.rotation);
  return clampStickerPlacement({
    ...value,
    x: value.x + centreOffset.x,
    y: value.y + centreOffset.y,
    width: nextWidth,
    height: nextHeight,
  });
}

/** Resize one local axis while the opposite edge remains fixed. */
export function resizeStickerFromEdge(
  initial: StickerPlacement,
  edge: StickerEdge,
  pointer: StickerPoint,
  options: StickerResizeOptions = {},
): StickerPlacement {
  const value = clampStickerPlacement(initial);
  const horizontal = edge === 'left' || edge === 'right';
  const sign = edge === 'right' || edge === 'bottom' ? 1 : -1;
  const pointerLocal = rotateStickerPoint({
    x: pointer.x - value.x,
    y: pointer.y - value.y,
  }, -value.rotation);
  const originalSize = horizontal ? value.width : value.height;
  const opposite = -sign * originalSize / 2;
  const selected = horizontal ? pointerLocal.x : pointerLocal.y;
  const nextSize = Math.max(MIN_SIZE, Math.abs(selected - opposite));
  const centreAlongAxis = (selected + opposite) / 2;
  const centreOffset = rotateStickerPoint(horizontal
    ? { x: centreAlongAxis, y: 0 }
    : { x: 0, y: centreAlongAxis }, value.rotation);
  const initialAspect = value.width / Math.max(value.height, MIN_SIZE);
  return clampStickerPlacement({
    ...value,
    x: value.x + centreOffset.x,
    y: value.y + centreOffset.y,
    ...(horizontal
      ? { width: nextSize, ...(options.preserveAspect ? { height: nextSize / initialAspect } : {}) }
      : { height: nextSize, ...(options.preserveAspect ? { width: nextSize * initialAspect } : {}) }),
  });
}

/** A conservative, centred starting placement for a new or reset sticker. */
export function fitStickerPlacement(stickerAspect = 1): StickerPlacement {
  const safeAspect = clamp(finite(stickerAspect, 1), 0.1, 10);
  const longestSide = 0.28;
  return clampStickerPlacement({
    x: 0.5,
    y: 0.5,
    width: safeAspect >= 1 ? longestSide : longestSide * safeAspect,
    height: safeAspect >= 1 ? longestSide / safeAspect : longestSide,
    rotation: 0,
  });
}
