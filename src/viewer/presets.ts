// Pure preset data, deliberately free of any three.js (or other viewer-chunk)
// imports: src/ui/** imports this module statically so the controls bar can
// build its selects without pulling the lazily-loaded viewer/compositor
// chunk into the main bundle. src/viewer/effects.ts re-exports these for the
// viewer engine's own use.

// ---------------------------------------------------------------------------
// Killstreak sheens
//
// TF2 renders a killstreak sheen as a second render pass over the weapon
// (materialsystem/stdshaders/weapon_sheen_pass_ps2x.fxc), driven by
// CProxyAnimatedWeaponSheen (game/client/tf/c_tf_player.cpp).
// ---------------------------------------------------------------------------

export interface SheenPreset {
  id: string;
  label: string;
  red: [number, number, number];
  blu: [number, number, number];
}

// g_KillStreakEffectsBase / g_KillStreakEffectsBlue in c_tf_player.cpp. Raw
// 0-255 sRGB-space values divided down to 0-1; NOT run through sRGB->linear
// conversion here, since the shader multiplies them straight into a
// cubemap sample the way Source's ps2x shader does.
const rgb255 = (r: number, g: number, b: number): [number, number, number] => [r / 255, g / 255, b / 255];

export const SHEEN_PRESETS: SheenPreset[] = [
  { id: 'none', label: 'None', red: [0, 0, 0], blu: [0, 0, 0] },
  { id: 'team_shine', label: 'Team Shine', red: rgb255(200, 20, 15), blu: rgb255(40, 98, 200) },
  { id: 'deadly_daffodil', label: 'Deadly Daffodil', red: rgb255(242, 172, 10), blu: rgb255(242, 172, 10) },
  { id: 'manndarin', label: 'Manndarin', red: rgb255(255, 75, 5), blu: rgb255(255, 75, 5) },
  { id: 'mean_green', label: 'Mean Green', red: rgb255(100, 255, 10), blu: rgb255(100, 255, 10) },
  { id: 'agonizing_emerald', label: 'Agonizing Emerald', red: rgb255(40, 255, 70), blu: rgb255(40, 255, 70) },
  { id: 'villainous_violet', label: 'Villainous Violet', red: rgb255(105, 20, 255), blu: rgb255(105, 20, 255) },
  { id: 'hot_rod', label: 'Hot Rod', red: rgb255(255, 30, 255), blu: rgb255(255, 30, 255) },
];

export function getSheen(id: string): SheenPreset {
  return SHEEN_PRESETS.find((preset) => preset.id === id) ?? SHEEN_PRESETS[0];
}

// ---------------------------------------------------------------------------
// Unusual weapon effects
// ---------------------------------------------------------------------------

export interface UnusualPreset {
  id: string;
  label: string;
}

export const UNUSUAL_PRESETS: UnusualPreset[] = [
  { id: 'none', label: 'None' },
  { id: 'hot', label: 'Hot' },
  { id: 'isotope', label: 'Isotope' },
  { id: 'cool', label: 'Cool' },
  { id: 'energy_orb', label: 'Energy Orb' },
];

// ---------------------------------------------------------------------------
// View angle presets
// ---------------------------------------------------------------------------

export interface ViewAnglePreset {
  id: string;
  label: string;
  dir: [number, number, number] | null; // null = default 3/4 inspect view
}

// normalize(1, 1, 1), computed by hand here to avoid a three.js import.
const ISO = 1 / Math.sqrt(3);

export const VIEW_ANGLES: ViewAnglePreset[] = [
  { id: 'default', label: 'Default', dir: null },
  { id: 'front', label: 'Front', dir: [0, 0, 1] },
  { id: 'back', label: 'Back', dir: [0, 0, -1] },
  { id: 'left', label: 'Left', dir: [-1, 0, 0] },
  { id: 'right', label: 'Right', dir: [1, 0, 0] },
  { id: 'top', label: 'Top', dir: [0, 1, 0] },
  { id: 'bottom', label: 'Bottom', dir: [0, -1, 0] },
  { id: 'iso', label: 'Isometric', dir: [ISO, ISO, ISO] },
];
