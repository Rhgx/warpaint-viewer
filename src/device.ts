// Decided once at boot from the primary input device, never from window size:
// narrowing a desktop window or rotating a tablet must not tear down an editor
// session that may hold unsaved work. An iPad with a trackpad reports a fine,
// hovering pointer and keeps the full app.
export const TOUCH_ONLY_DEVICE = typeof window !== 'undefined'
  && typeof window.matchMedia === 'function'
  && window.matchMedia('(hover: none) and (pointer: coarse)').matches;

// The mobile layout's media query, mirrored from layout.css. Layout stays CSS
// only; JS reads this once at the moment it needs it, never reactively, and
// falls back to the desktop layout where matchMedia is unavailable.
const MOBILE_LAYOUT_QUERY = '(max-width: 860px), (max-height: 500px)';
export function matchesMobileLayout(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(MOBILE_LAYOUT_QUERY).matches === true;
}

/** Custom war paint authoring (workbench, editors, definitions, source packages). */
export const WORKSHOP_ENABLED = !TOUCH_ONLY_DEVICE;
