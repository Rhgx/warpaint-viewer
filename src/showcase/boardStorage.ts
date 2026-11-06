import { isValidKills } from '../data/statClock';
import type { LayoutPacking, LayoutRows } from './layouts';
import type { AppliedLayout, ShowcaseItem, ShowcasePaint } from './showcaseTypes';


const BOARD_STORAGE_KEY = 'warpaint-viewer:showcase-board';
const BOARD_VERSION = 1;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function parsePaint(value: unknown): ShowcasePaint | null {
  if (!isRecord(value)
    || !isFiniteNumber(value.kitId) || !Number.isSafeInteger(value.kitId)
    || typeof value.kitName !== 'string'
    || (value.team !== 'red' && value.team !== 'blu')
    || !isFiniteNumber(value.wearIndex) || !Number.isSafeInteger(value.wearIndex)
    || typeof value.seed !== 'string') return null;
  return { kitId: value.kitId, kitName: value.kitName, team: value.team, wearIndex: value.wearIndex, seed: value.seed };
}

function parsePose(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const pose: Record<string, number> = {};
  for (const [control, angle] of Object.entries(value)) {
    if (!isFiniteNumber(angle)) return null;
    pose[control] = angle;
  }
  return pose;
}

function parseImage(value: unknown): ShowcaseItem['image'] | null {
  if (!isRecord(value) || typeof value.assetId !== 'string' || !isFiniteNumber(value.aspect) || value.aspect <= 0) return null;
  return { assetId: value.assetId, aspect: value.aspect };
}

function parseItem(value: unknown): ShowcaseItem | null {
  if (!isRecord(value)) return null;
  const paint = parsePaint(value.paint);
  const pose = parsePose(value.pose);
  const { id, weaponKey, weaponName, x, y, roll, tilt, turn, scale, flipped, hidden, part, hiddenParts } = value;
  const image = value.image === undefined ? undefined : parseImage(value.image);
  if (image === null) return null;
  const { statClock, killCount } = value;
  if ((statClock !== undefined && typeof statClock !== 'boolean') || (killCount !== undefined && !isValidKills(killCount))) return null;
  if (!paint || !pose
    || typeof id !== 'string' || typeof weaponKey !== 'string' || typeof weaponName !== 'string'
    || !isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(roll) || !isFiniteNumber(tilt) || !isFiniteNumber(turn)
    || !isFiniteNumber(scale) || scale <= 0
    || typeof flipped !== 'boolean' || typeof hidden !== 'boolean'
    || (part !== null && typeof part !== 'string')
    || !Array.isArray(hiddenParts) || !hiddenParts.every((entry) => typeof entry === 'string')) return null;
  return { id, weaponKey, weaponName, paint, x, y, roll, tilt, turn, flipped, scale, hidden, pose, part, hiddenParts, ...(statClock !== undefined ? { statClock } : {}), ...(killCount !== undefined ? { killCount } : {}), ...(image ? { image } : {}) };
}

/** One bad item drops the whole save, so it never comes back half-restored. */
export function parseSavedBoard(value: unknown): ShowcaseItem[] | null {
  if (!isRecord(value) || value.version !== BOARD_VERSION || !Array.isArray(value.items)) return null;
  const items = value.items.map(parseItem);
  if (!items.every((item) => item !== null)) return null;
  return new Set(items.map((item) => item.id)).size === items.length ? items : null;
}

const isPacking = (value: unknown): value is LayoutPacking => value === 'size' || value === 'order' || value === 'composed';

/** A layout only feeds Fill, so a damaged one gives null rather than costing the weapons saved with it. */
export function parseSavedLayout(value: unknown): AppliedLayout | null {
  if (!isRecord(value) || !Array.isArray(value.rows)) return null;
  const { pack, inward, upright, logoSpace } = value;
  // JSON leaves out a pack that is undefined.
  if ((pack !== undefined && !isPacking(pack))
    || typeof inward !== 'boolean' || typeof upright !== 'boolean' || typeof logoSpace !== 'boolean') return null;
  const rows: LayoutRows = [];
  for (const row of value.rows) {
    if (!Array.isArray(row)) return null;
    const slots: LayoutRows[number] = [];
    for (const slot of row) {
      if (!isRecord(slot) || typeof slot.weaponKey !== 'string') return null;
      const paint = parsePaint(slot.paint);
      if (!paint) return null;
      slots.push({ weaponKey: slot.weaponKey, paint });
    }
    rows.push(slots);
  }
  return { rows, pack, inward, upright, logoSpace };
}

export function readSavedBoard(): ShowcaseItem[] {
  try {
    return parseSavedBoard(JSON.parse(localStorage.getItem(BOARD_STORAGE_KEY) ?? 'null')) ?? [];
  } catch {
    // Damaged JSON or storage that cannot be read starts an empty board.
    return [];
  }
}

/** The version and items checked by `parseSavedBoard`, for a save that carries more alongside them. */
export const boardSaveFields = (items: readonly ShowcaseItem[]) => ({ version: BOARD_VERSION, items });

export function writeSavedBoard(items: readonly ShowcaseItem[]): void {
  try {
    if (items.length) localStorage.setItem(BOARD_STORAGE_KEY, JSON.stringify(boardSaveFields(items)));
    else localStorage.removeItem(BOARD_STORAGE_KEY);
  } catch {
    // Private browsing or a full quota: the board lasts for the session.
  }
}
