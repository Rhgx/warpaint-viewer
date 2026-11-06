import { DEFAULT_KILLS } from '../../data/statClock';
import { boardSaveFields, isRecord, parseSavedBoard, parseSavedLayout } from '../../showcase/boardStorage';
import type { AppliedLayout, ShowcaseItem, ShowcasePaint } from '../../showcase/showcaseTypes';
import { parseSettings, sameBoardSettings, type ShowcaseSettings } from './showcaseSettings';

// Boards saved on purpose, apart from the autosave, each with the settings it was set up with.
// One key per slot, so a damaged slot costs only itself.

const SLOT_COUNT = 3;
const SLOT_KEY_PREFIX = 'warpaint-viewer:showcase-slot-';
const slotKey = (index: number) => `${SLOT_KEY_PREFIX}${index + 1}`;
const backupKey = (index: number) => `${SLOT_KEY_PREFIX}${index + 1}-previous`;
export const isSlotStorageKey = (key: string) => key.startsWith(SLOT_KEY_PREFIX);
export const SLOT_NAME_LIMIT = 32;
const THUMBNAIL = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;

/** Everything needed to put a board back as it was. */
export interface SavedBoard {
  items: readonly ShowcaseItem[];
  settings: ShowcaseSettings;
  /** What Fill lays out again once this is loaded. */
  layout: AppliedLayout | null;
  /** The weapons the Wears and RED and BLU layouts were showing. */
  featured: string | null;
  pairs: readonly string[];
}

export interface LayoutSlot extends SavedBoard {
  name: string;
  savedAt: number;
  /** A small picture of the board as a data URL; null shows a sketch of it instead. */
  thumbnail: string | null;
}

export type LayoutSlots = readonly (LayoutSlot | null)[];

export function parseLayoutSlot(value: unknown): LayoutSlot | null {
  const items = parseSavedBoard(value);
  if (!items?.length || !isRecord(value) || typeof value.savedAt !== 'number' || !Number.isFinite(value.savedAt)) return null;
  const { savedAt, name, thumbnail, featured, pairs } = value;
  return {
    name: typeof name === 'string' ? name.trim().slice(0, SLOT_NAME_LIMIT) : '',
    savedAt,
    thumbnail: typeof thumbnail === 'string' && THUMBNAIL.test(thumbnail) ? thumbnail : null,
    items,
    settings: parseSettings(value.settings),
    layout: parseSavedLayout(value.layout),
    featured: typeof featured === 'string' ? featured : null,
    pairs: Array.isArray(pairs) ? pairs.filter((key) => typeof key === 'string') : [],
  };
}

function readSlots(keyFor: (index: number) => string): LayoutSlots {
  return Array.from({ length: SLOT_COUNT }, (_, index) => {
    try {
      return parseLayoutSlot(JSON.parse(localStorage.getItem(keyFor(index)) ?? 'null'));
    } catch {
      // Damaged JSON or storage that cannot be read shows the slot as empty.
      return null;
    }
  });
}

export const readLayoutSlots = () => readSlots(slotKey);
/** What each slot held before it was last replaced or deleted. With no confirmation dialogs, this is what stands behind those actions. */
export const readSlotBackups = () => readSlots(backupKey);

function writeSlot(key: string, slot: LayoutSlot | null): boolean {
  try {
    if (slot) {
      const { items, ...rest } = slot;
      localStorage.setItem(key, JSON.stringify({ ...boardSaveFields(items), ...rest }));
    } else {
      localStorage.removeItem(key);
    }
    return true;
  } catch {
    return false;
  }
}

/** Saves a slot, or empties it for null. False when the browser refused, which the panel tells the user. */
export const writeLayoutSlot = (index: number, slot: LayoutSlot | null) => writeSlot(slotKey(index), slot);
export const writeSlotBackup = (index: number, slot: LayoutSlot | null) => writeSlot(backupKey(index), slot);

/** The same board in another paint, as far as that paint goes. A weapon it does not cover keeps the paint it has, and is counted. */
export function inPaint(saved: SavedBoard, kit: { id: number; name: string; weapons: readonly string[] }): { board: SavedBoard; kept: number } {
  const repaint = <T extends { weaponKey: string; paint: ShowcasePaint }>(entry: T): T => (kit.weapons.includes(entry.weaponKey)
    ? { ...entry, paint: { ...entry.paint, kitId: kit.id, kitName: kit.name } }
    : entry);
  const weapons = saved.items.filter((item) => !item.image);
  return {
    kept: weapons.filter((item) => !kit.weapons.includes(item.weaponKey)).length,
    board: {
      ...saved,
      items: saved.items.map((item) => (item.image ? item : repaint(item))),
      // Fill lays the board out again from these, which would otherwise bring the old paint back.
      layout: saved.layout && { ...saved.layout, rows: saved.layout.rows.map((row) => row.map(repaint)) },
    },
  };
}

/** Imported pictures live outside the save, so the board's start-up cleanup has to know which ones slots still use. */
export const slotImages = (slots: LayoutSlots): ReadonlySet<string> => new Set(
  slots.flatMap((slot) => slot?.items.flatMap((item) => (item.image ? [item.image.assetId] : [])) ?? []),
);

/** Everything about an item that shows, in a fixed order and without its id, which changes on every load. */
const itemKey = (item: ShowcaseItem) => [
  item.weaponKey, item.weaponName, item.paint.kitId, item.paint.team, item.paint.wearIndex, item.paint.seed,
  item.x, item.y, item.roll, item.tilt, item.turn, item.flipped, item.scale, item.hidden, item.part, item.hiddenParts,
  Object.entries(item.pose).sort(([a], [b]) => a.localeCompare(b)), item.image?.assetId ?? null,
  item.statClock === true, item.statClock ? item.killCount ?? DEFAULT_KILLS : null,
];

/** Whether a saved board still matches what is on the board now, which is what marks a slot as changed. */
export function matchesBoard(slot: SavedBoard, items: readonly ShowcaseItem[], settings: ShowcaseSettings): boolean {
  if (slot.items.length !== items.length) return false;
  if (!sameBoardSettings(settings, slot.settings)) return false;
  return JSON.stringify(slot.items.map(itemKey)) === JSON.stringify(items.map(itemKey));
}
