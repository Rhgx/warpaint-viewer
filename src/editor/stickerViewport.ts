import type { StickerPoint } from './stickerGeometry';

/**
 * Screen-only navigation for the 2D sticker editor.  Placement itself never
 * enters this type: that remains normalized UV space so the compositor and
 * on-model editor receive the same authored coordinates.
 */
export interface StickerViewport {
  readonly zoom: number;
  readonly panX: number;
  readonly panY: number;
}

export interface StickerViewportSize {
  readonly width: number;
  readonly height: number;
}

export const STICKER_VIEWPORT_MIN_ZOOM = 0.25;
export const STICKER_VIEWPORT_MAX_ZOOM = 16;

export const DEFAULT_STICKER_VIEWPORT: StickerViewport = Object.freeze({ zoom: 1, panX: 0, panY: 0 });

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function safeSize(size: StickerViewportSize): StickerViewportSize {
  return {
    width: Math.max(1, finite(size.width, 1)),
    height: Math.max(1, finite(size.height, 1)),
  };
}

export function clampStickerViewportZoom(value: number): number {
  return clamp(finite(value, 1), STICKER_VIEWPORT_MIN_ZOOM, STICKER_VIEWPORT_MAX_ZOOM);
}

/** Keep a zoomed canvas covering the viewport; a zoomed-out canvas is centred. */
export function clampStickerViewportPan(
  pan: Pick<StickerViewport, 'panX' | 'panY'>,
  zoom: number,
  size: StickerViewportSize,
): Pick<StickerViewport, 'panX' | 'panY'> {
  const safeZoom = clampStickerViewportZoom(zoom);
  const safe = safeSize(size);
  const axis = (value: number, length: number) => {
    if (safeZoom <= 1) return (length - length * safeZoom) / 2;
    return clamp(finite(value, 0), length * (1 - safeZoom), 0);
  };
  return { panX: axis(pan.panX, safe.width), panY: axis(pan.panY, safe.height) };
}

export function normalizeStickerViewport(
  viewport: StickerViewport,
  size: StickerViewportSize,
): StickerViewport {
  const zoom = clampStickerViewportZoom(viewport.zoom);
  return { zoom, ...clampStickerViewportPan(viewport, zoom, size) };
}

/** Convert a viewport-local pixel coordinate back to its unmodified UV point. */
export function stickerViewportPointToUv(
  point: StickerPoint,
  viewport: StickerViewport,
  size: StickerViewportSize,
): StickerPoint {
  const safe = safeSize(size);
  const value = normalizeStickerViewport(viewport, safe);
  return {
    x: (finite(point.x, 0) - value.panX) / (safe.width * value.zoom),
    y: (finite(point.y, 0) - value.panY) / (safe.height * value.zoom),
  };
}

/** Position a UV point in viewport pixels. The exact inverse of pointToUv. */
export function stickerUvPointToViewport(
  point: StickerPoint,
  viewport: StickerViewport,
  size: StickerViewportSize,
): StickerPoint {
  const safe = safeSize(size);
  const value = normalizeStickerViewport(viewport, safe);
  return {
    x: finite(point.x, 0) * safe.width * value.zoom + value.panX,
    y: finite(point.y, 0) * safe.height * value.zoom + value.panY,
  };
}

/** Zoom around a pointer, preserving the UV pixel under that pointer. */
export function zoomStickerViewportAt(
  viewport: StickerViewport,
  zoom: number,
  pointer: StickerPoint,
  size: StickerViewportSize,
): StickerViewport {
  const safe = safeSize(size);
  const before = normalizeStickerViewport(viewport, safe);
  const nextZoom = clampStickerViewportZoom(zoom);
  const scale = nextZoom / before.zoom;
  const pan = {
    panX: finite(pointer.x, 0) - (finite(pointer.x, 0) - before.panX) * scale,
    panY: finite(pointer.y, 0) - (finite(pointer.y, 0) - before.panY) * scale,
  };
  return { zoom: nextZoom, ...clampStickerViewportPan(pan, nextZoom, safe) };
}
