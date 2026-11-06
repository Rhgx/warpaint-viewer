// Kept free of three.js so that links, saves and tests can use it.

/** The model has six digit meshes, one per stattrack_dial00N material. */
export const STAT_CLOCK_DIGITS = 6;
export const MAX_KILLS = 10 ** STAT_CLOCK_DIGITS - 1;
/** What a new clock reads in the game. */
export const DEFAULT_KILLS = 0;

export interface StatClockSetting {
  on: boolean;
  kills: number;
}

/** The one weapon whose model has no c_weapon_stattrack bone. tools/verify/viewer/stat-clock.test.ts checks this against the extracted data. */
const NO_CLOCK_BONE: ReadonlySet<string> = new Set(['c_flameball']);

export const supportsStatClock = (weaponKey: string) => !NO_CLOCK_BONE.has(weaponKey);

export const isValidKills = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_KILLS;

export function parseKills(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Math.min(MAX_KILLS, Number(trimmed));
}
