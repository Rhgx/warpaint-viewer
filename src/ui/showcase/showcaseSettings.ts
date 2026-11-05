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
  exportBackdrop: boolean;
  /** Drag handles on the moving parts of the selected weapon, next to the pose sliders. */
  poseHandles: boolean;
  weaponSize: number;
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
  exportBackdrop: true,
  poseHandles: true,
  weaponSize: 100,
};

export const PLACEMENT_KEYS = ['snapToGrid', 'grid', 'keepApart', 'spacing', 'keepInside', 'rotationSnap', 'showFootprints'] as const;
export const LOOK_KEYS = ['lightAzimuth', 'lightElevation', 'shadows', 'shadow', 'background'] as const;
export const EXPORT_KEYS = ['outputWidth', 'exportBackdrop'] as const;
type SettingKeys = readonly (keyof ShowcaseSettings)[];

/** How this person likes to work, not what a board looks like: a file from someone else leaves these alone. */
const PERSONAL_KEYS = ['snapToGrid', 'rotationSnap', 'showFootprints', 'poseHandles', 'outputWidth', 'exportBackdrop'] as const;
export const withSharedSettings = (mine: ShowcaseSettings, theirs: ShowcaseSettings): ShowcaseSettings => ({
  ...theirs,
  ...Object.fromEntries(PERSONAL_KEYS.map((key) => [key, mine[key]])),
});
/** Whether two sets of settings give the same board, whatever each person's working preferences. */
export const sameBoardSettings = (a: ShowcaseSettings, b: ShowcaseSettings) => (Object.keys(a) as (keyof ShowcaseSettings)[])
  .every((key) => a[key] === b[key] || (PERSONAL_KEYS as readonly string[]).includes(key));

export const sameSettings = (a: ShowcaseSettings, b: ShowcaseSettings) => (Object.keys(a) as (keyof ShowcaseSettings)[]).every((key) => a[key] === b[key]);

export const SETTINGS_STORAGE_KEY = 'warpaint-viewer:showcase-settings';
export const ROTATION_SNAPS = [45, 30, 15, 5, 0];
export const WEAPON_SIZE = { min: 50, max: 100, step: 5 };
const ALLOWED_VALUES: Partial<Record<keyof ShowcaseSettings, readonly unknown[]>> = {
  grid: ['fine', 'normal', 'coarse'],
  background: ['framed', 'pegboard', 'transparent'],
  rotationSnap: ROTATION_SNAPS,
  outputWidth: OUTPUT_WIDTHS,
  weaponSize: Array.from({ length: (WEAPON_SIZE.max - WEAPON_SIZE.min) / WEAPON_SIZE.step + 1 }, (_, index) => WEAPON_SIZE.min + index * WEAPON_SIZE.step),
};

/** Saved settings, keeping only values that still match the current options. */
export function parseSettings(saved: unknown): ShowcaseSettings {
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

export function loadSettings(): ShowcaseSettings {
  try {
    return parseSettings(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null'));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** A transparent background has no backdrop to leave out, and keeps the shadows set in Look. */
export const exportsBackdrop = (settings: ShowcaseSettings) => settings.exportBackdrop || settings.background === 'transparent';

export function describeProblem(problem: FitProblem): string {
  if (!problem) return 'Fits on the board';
  return problem.kind === 'outside' ? 'Hangs off the board' : `Too close to the ${problem.otherName}`;
}

export const settingsChanged = (settings: ShowcaseSettings, keys: SettingKeys) => keys.some((key) => settings[key] !== DEFAULT_SETTINGS[key]);
export const defaultsFor = (keys: SettingKeys): Partial<ShowcaseSettings> => Object.fromEntries(keys.map((key) => [key, DEFAULT_SETTINGS[key]]));
