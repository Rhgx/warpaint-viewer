import type { StickerPlacement, StickerPoint } from '../../editor/sticker/stickerGeometry';
import type { StickerViewportSize } from '../../editor/sticker/stickerViewport';

/** Power-of-two texture fractions; halving keeps each coarser grid a superset of the finer ones, so zoom never moves a snapped edge. */
const SNAP_LADDER = [1 / 8, 1 / 16, 1 / 32, 1 / 64, 1 / 128, 1 / 256] as const;
/** Roughly how many grid cells should span the visible area at any zoom. */
const SNAP_CELLS_ACROSS_VIEW = 16;

/**
 * Picks the rung nearest a constant on-screen grid density. A fixed texture-space
 * grid grows with zoom until one cell swallows the sticker.
 */
export function adaptiveSnapStep(zoom: number): number {
  const target = 1 / (SNAP_CELLS_ACROSS_VIEW * Math.max(zoom, 0.01));
  let best: number = SNAP_LADDER[0];
  for (const step of SNAP_LADDER) {
    if (Math.abs(Math.log(step / target)) < Math.abs(Math.log(best / target))) best = step;
  }
  return best;
}

export function pointerInSurface(event: Pick<React.MouseEvent<HTMLElement>, 'clientX' | 'clientY'>, surface: HTMLElement): StickerPoint {
  const bounds = surface.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
}

export function surfaceSize(surface: HTMLElement): StickerViewportSize {
  const bounds = surface.getBoundingClientRect();
  return { width: Math.max(bounds.width, 1), height: Math.max(bounds.height, 1) };
}

export function rotationForPointer(pointer: StickerPoint, placement: StickerPlacement): number {
  return Math.atan2(pointer.y - placement.y, pointer.x - placement.x) * (180 / Math.PI) + 90;
}

export function nextNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
