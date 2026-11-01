// Decided once at boot from the primary input device, never from window size, so resizing or rotating
// cannot tear down an editor session with unsaved work. A trackpad iPad keeps the full app.
export const TOUCH_ONLY_DEVICE = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// Mirrors the mobile breakpoint in layout.css. JS reads it on demand, never reactively,
// and falls back to desktop where matchMedia is unavailable.
const MOBILE_LAYOUT_QUERY = '(max-width: 860px), (max-height: 500px)';
export function matchesMobileLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(MOBILE_LAYOUT_QUERY).matches === true;
}

/** Custom war paint authoring (workbench, editors, definitions, source packages). */
export const WORKSHOP_ENABLED = !TOUCH_ONLY_DEVICE;
