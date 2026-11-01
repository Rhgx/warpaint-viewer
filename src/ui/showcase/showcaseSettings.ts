import type { BoardBackground, FitProblem, GridSize } from '../../showcase/showcaseTypes';

// Board settings and their saved form: defaults, allowed values, and the keys each panel section resets.

export const OUTPUT_WIDTHS = [1280, 1920, 2560, 3840];

/** Board-wide settings; each panel section can return its part to these. */
export interface ShowcaseSettings {
  snapToGrid: boolean;
  grid: GridSize;
  keepApart: boolean;
  spacing: number;
  keepInside: boolean;
  rotationSnap: number;
  showFootprints: boolean;
  lightAzimuth: number;
  lightElevation: number;
  shadows: boolean;
  shadow: number;
  background: BoardBackground;
  outputWidth: number;
  /** Drag handles on the moving parts of the selected weapon, next to the pose sliders. */
  poseHandles: boolean;
}

const DEFAULT_SETTINGS: ShowcaseSettings = {
  snapToGrid: true,
  grid: 'normal',
  keepApart: true,
  spacing: 1,
  keepInside: true,
  rotationSnap: 30,
  showFootprints: false,
  lightAzimuth: 125,
  lightElevation: 55,
  shadows: true,
  shadow: 60,
  background: 'framed',
  outputWidth: 1920,
  poseHandles: true,
};

export const PLACEMENT_KEYS = ['snapToGrid', 'grid', 'keepApart', 'spacing', 'keepInside', 'rotationSnap', 'showFootprints'] as const;
export const LOOK_KEYS = ['lightAzimuth', 'lightElevation', 'shadows', 'shadow', 'background'] as const;
export const EXPORT_KEYS = ['outputWidth'] as const;
type SettingKeys = readonly (keyof ShowcaseSettings)[];

export const SETTINGS_STORAGE_KEY = 'warpaint-viewer:showcase-settings';
export const ROTATION_SNAPS = [45, 30, 15, 5, 0];
const ALLOWED_VALUES: Partial<Record<keyof ShowcaseSettings, readonly unknown[]>> = {
  grid: ['fine', 'normal', 'coarse'],
  background: ['framed', 'pegboard', 'transparent'],
  rotationSnap: ROTATION_SNAPS,
  outputWidth: OUTPUT_WIDTHS,
};

/** Saved settings, keeping only values that still match the current options. */
export function loadSettings(): ShowcaseSettings {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null');
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!saved || typeof saved !== 'object') return DEFAULT_SETTINGS;
  const settings: ShowcaseSettings = { ...DEFAULT_SETTINGS };
  const record = saved as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ShowcaseSettings)[]) {
    const value = record[key];
    const allowed = ALLOWED_VALUES[key];
    if (typeof value !== typeof DEFAULT_SETTINGS[key] || (allowed && !allowed.includes(value))) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    Object.assign(settings, { [key]: value });
  }
  return settings;
}

export function describeProblem(problem: FitProblem): string {
  if (!problem) return 'Fits on the board';
  return problem.kind === 'outside' ? 'Hangs off the board' : `Too close to the ${problem.otherName}`;
}

export const settingsChanged = (settings: ShowcaseSettings, keys: SettingKeys) => keys.some((key) => settings[key] !== DEFAULT_SETTINGS[key]);
export const defaultsFor = (keys: SettingKeys): Partial<ShowcaseSettings> => Object.fromEntries(keys.map((key) => [key, DEFAULT_SETTINGS[key]]));
