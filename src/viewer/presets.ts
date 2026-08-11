// Pure preset data, deliberately free of any three.js (or other viewer-chunk)
// imports: src/ui/** imports this module statically so the controls bar can
// build its selects without pulling the lazily-loaded viewer/compositor
// chunk into the main bundle. src/viewer/Viewer.ts imports these directly for
// the viewer engine's own use.

// Killstreak sheens
//
// TF2 renders a killstreak sheen as a second render pass over the weapon
// (materialsystem/stdshaders/weapon_sheen_pass_ps2x.fxc), driven by
// CProxyAnimatedWeaponSheen (game/client/tf/c_tf_player.cpp).

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

// Unusual weapon effects

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

// View angle presets

export interface ViewAnglePreset {
  id: string;
  label: string;
  dir: [number, number, number] | null; // null = default 3/4 inspect view
  framingScale?: number;
  cameraAttachment?: {
    position: [number, number, number];
    forward: [number, number, number];
    up?: [number, number, number];
  };
  /** Exact inventory-icon framing: preserve authored roll and lock input. */
  lockedCamera?: boolean;
}

interface IconCameraSource {
  key: string;
  iconCamera?: {
    position: [number, number, number];
    forward: [number, number, number];
    up: [number, number, number];
  };
}

/** Build the reset/default pose authored into a TF2 weapon model. */
export function weaponIconView(
  weapon: IconCameraSource | null | undefined,
  lockedCamera = false,
): ViewAnglePreset | undefined {
  if (!weapon?.iconCamera) return undefined;
  return {
    id: `icon-${weapon.key}`,
    label: 'Default',
    dir: null,
    cameraAttachment: weapon.iconCamera,
    lockedCamera,
  };
}

// normalize(1, 1, 1), computed by hand here to avoid a three.js import.
const ISO = 1 / Math.sqrt(3);

export const VIEW_ANGLES: ViewAnglePreset[] = [
  { id: 'default', label: 'Default', dir: null },
  { id: 'inventory-icon', label: 'Inventory icon (locked)', dir: null, lockedCamera: true },
  { id: 'front', label: 'Front', dir: [0, 0, 1] },
  { id: 'back', label: 'Back', dir: [0, 0, -1] },
  { id: 'left', label: 'Left', dir: [-1, 0, 0] },
  { id: 'right', label: 'Right', dir: [1, 0, 0] },
  { id: 'top', label: 'Top', dir: [0, 1, 0] },
  { id: 'bottom', label: 'Bottom', dir: [0, -1, 0] },
  { id: 'iso', label: 'Isometric', dir: [ISO, ISO, ISO] },
];

// Valve's inventory icons present the paint-tool card almost face-on, with a
// small elevation and side angle to keep the card thickness and paint cans
// legible. The BaseModelPanel resource default is 54 degrees (rather than the
// viewer's wider general-purpose 75-degree weapon view).
export const PAINTKIT_TOOL_VIEW: ViewAnglePreset = {
  id: 'paintkit-tool',
  label: 'War Paint',
  // models/items/paintkit_tool.mdl, attachment "icon_camera". TF2's
  // CEmbeddedItemModelPanel reads this transform directly for inventory icons.
  dir: [0.8461242318, 0.172205776, 0.5043995976],
  cameraAttachment: {
    position: [52.8896865845, 28.1729717255, 32.5647087097],
    forward: [-0.8461242318, -0.172205776, -0.5043995976],
    up: [-0.1479191903, 0.9850609985, -0.0881745],
  },
};
// CEmbeddedItemModelPanel's inventory render uses the authored 54-degree icon
// FOV directly. At 128 square this reproduces the 77 x 86 pixel alpha bounds
// shared by TF2's shipped modern war-paint icons.
export const DEFAULT_VIEWER_FOV = 70;
export const TF2_ITEM_PANEL_FOV = 54;
export const PAINTKIT_TOOL_FOV = TF2_ITEM_PANEL_FOV;
