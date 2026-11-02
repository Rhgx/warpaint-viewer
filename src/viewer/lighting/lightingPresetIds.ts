// Preset ids and selector labels without three.js, so the startup UI can list presets
// without loading the renderer. lighting.ts builds the matching presets.
import { BSP_MAP_LIGHTING } from './mapLighting.generated';

export const PAINTKIT_ICON_LIGHTING_ID = 'paintkit-icon';
export const LEGACY_PAINTKIT_ICON_LIGHTING_ID = 'paintkit-icon-legacy';

/** Selector entries in LIGHTING_PRESETS order. lighting.test.ts checks the two lists agree. */
export const LIGHTING_PRESET_OPTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'inspect', label: 'Inspect' },
  { id: 'inspect-legacy', label: 'Inspect (Legacy)' },
  ...(['daylight', 'overcast', 'indoors', 'night'] as const).map((id) => ({
    id,
    label: BSP_MAP_LIGHTING[id].label,
  })),
];
