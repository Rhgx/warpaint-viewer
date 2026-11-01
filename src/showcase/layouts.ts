// Starting layouts for the showcase board, modelled on how paints are
// presented: Valve's Gun Mettle case boards for the 14 stock weapons, and the
// case-style boards people post with War Paint submissions on the Steam
// Workshop, which give the unlockables boards of their own. Weapons lie level
// in side profile, muzzles left, at their true sizes relative to each other.
//
// A layout only says which weapons go on the board and in what order. The
// board measures the loaded weapons and fits them to its own size, so the same
// layout works for any paint's weapon list.

import type { PaintkitEntry } from '../data/types';
import type { ShowcasePaint } from './ShowcaseBoard';

interface LayoutSlot {
  weaponKey: string;
  paint: ShowcasePaint;
}

/** Rows from top to bottom; each row is spread evenly across the board. */
export type LayoutRows = LayoutSlot[][];
export type LayoutPacking = 'size' | 'order';

export interface BoardLayout {
  id: string;
  label: string;
  rows: LayoutRows;
  /**
   * Rows only list the weapons; the board regroups them into rows or columns, whichever makes
   * them largest. 'size' groups similar sizes, 'order' keeps the listed order.
   */
  pack?: LayoutPacking;
  /**
   * Turn weapons to point at the middle of the board, as Valve's case boards
   * do: those on the left half face right, those on the right half face left.
   */
  inward?: boolean;
  /** Also try every weapon standing upright, tip up, and keep whichever fills the board better. */
  upright?: boolean;
}

/** The 14 stock weapons the Gun Mettle cases show, in the order boards lead with. */
const STOCK = [
  'c_rocketlauncher', 'c_minigun', 'c_sniperrifle', 'c_flamethrower', 'c_grenadelauncher', 'c_scattergun', 'c_shotgun',
  'c_stickybomb_launcher', 'c_smg', 'c_medigun', 'c_pistol', 'c_revolver', 'c_knife', 'c_wrench',
];
const MELEE = new Set([
  'c_amputator', 'c_back_scratcher', 'c_battleaxe', 'c_claidheamohmor', 'c_demo_sultan_sword', 'c_holymackerel', 'c_jag',
  'c_knife', 'c_powerjack', 'c_riding_crop', 'c_scimitar', 'c_ubersaw', 'c_wrench',
]);
/** Not a weapon; the paint's own preview tool. */
const EXCLUDED = new Set(['paintkit_tool']);
/** About as many weapons as one board holds before they get too small to read. */
const BOARD_LIMIT = 20;
/** How many weapons the RED and BLU layout pairs up, one pair per row. */
export const TEAM_PAIR_LIMIT = 3;
/** Factory New, Field-Tested and Battle Scarred, the wears boards usually compare. */
const COMPARED_WEARS = [0, 2, 4];

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let start = 0; start < items.length; start += size) rows.push(items.slice(start, start + size));
  return rows;
}

/**
 * The layouts that make sense for this paint: RED and BLU only when the teams
 * differ, the wears only when they do. `focus` is the weapon the wears show,
 * and RED and BLU pair up `pairs` (or the focus when none is given), each
 * when the paint covers it.
 */
export function boardLayouts(kit: PaintkitEntry, paint: ShowcasePaint, wearCount: number, focus: string | null, pairs: readonly string[] = []): BoardLayout[] {
  const available = kit.weapons.filter((key) => !EXCLUDED.has(key));
  const ordered = [...STOCK.filter((key) => available.includes(key)), ...available.filter((key) => !STOCK.includes(key))];
  if (!ordered.length) return [];
  const featured = focus && ordered.includes(focus) ? focus : ordered[0];
  const slot = (weaponKey: string, patch: Partial<ShowcasePaint> = {}): LayoutSlot => ({ weaponKey, paint: { ...paint, ...patch } });
  const layouts: BoardLayout[] = [];

  const board = (id: string, label: string, keys: readonly string[], upright = false) => {
    const shown = keys.slice(0, BOARD_LIMIT);
    if (shown.length) layouts.push({ id, label, rows: chunk(shown.map((key) => slot(key)), Math.ceil(Math.sqrt(shown.length * 1.5))), pack: 'size', inward: true, upright });
  };
  const unlocks = ordered.filter((key) => !STOCK.includes(key));
  if (!unlocks.length) {
    // A Gun Mettle or Tough Break skin: one case with everything it covers.
    board('case', 'Case', ordered);
  } else {
    // War Paints cover the unlockables too, more than one board can show.
    board('stock', 'Stock', ordered.filter((key) => STOCK.includes(key)));
    board('unlocks', 'Unlock guns', unlocks.filter((key) => !MELEE.has(key)));
    // Long blades stand in a row like a weapon rack when that fits them larger.
    const melee = ordered.filter((key) => MELEE.has(key));
    if (melee.length > 1) board('melee', 'Melee', melee, true);
  }

  const wears = COMPARED_WEARS.filter((wearIndex) => wearIndex < wearCount);
  if (kit.perWear && wears.length > 1) {
    layouts.push({ id: 'wears', label: 'Wears', rows: wears.map((wearIndex) => [slot(featured, { wearIndex })]), pack: 'order' });
  }

  if (kit.hasTeamTextures) {
    const paired = pairs.filter((key, index) => ordered.includes(key) && pairs.indexOf(key) === index).slice(0, TEAM_PAIR_LIMIT);
    const shown = paired.length ? paired : [featured];
    // One pair per row, RED beside BLU and facing each other. A single pair may
    // stack instead when that shows it larger.
    const rows = shown.map((key) => [slot(key, { team: 'red' }), slot(key, { team: 'blu' })]);
    layouts.push({ id: 'teams', label: 'RED and BLU', rows, pack: shown.length === 1 ? 'order' : undefined, inward: true });
  }
  return layouts;
}
