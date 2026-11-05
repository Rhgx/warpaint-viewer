import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { AppliedLayout, BoardEditSideEffect, ShowcaseItem } from '../../showcase/showcaseTypes';
import { downloadBlob } from '../common/download';
import { isLayoutFileName } from '../../showcase/boardFileName';
import { LAYOUT_FILE_EXTENSION, LayoutFileError, layoutFileName, pictureIndex, readLayoutFile, writeLayoutFile, type SharedLayout } from './layoutFile';
import {
  inPaint, isSlotStorageKey, matchesBoard, readLayoutSlots, readSlotBackups, SLOT_NAME_LIMIT, writeLayoutSlot, writeSlotBackup, type LayoutSlot, type LayoutSlots, type SavedBoard,
} from './layoutSlots';
import { sameSettings, withSharedSettings, type ShowcaseSettings } from './showcaseSettings';

// Saving, loading and sharing boards. Kept above the panel section, which unmounts while a weapon is selected,
// so a selection cannot cost anyone the way back that replaces confirmation dialogs here.

const ACTIVE_SLOT_KEY = 'warpaint-viewer:showcase-active-slot';
const THUMBNAIL_WIDTH = 240;
/** A double click on an empty slot saves with its first click; its second must not load what was just saved. */
const SAVE_CLICK_GUARD_MS = 400;
const SAVE_FAILED = 'Could not save: this browser\'s storage is full or blocked. Use Share file to keep this board.';
const CHANGE_FAILED = 'Could not change this slot: this browser\'s storage is full or blocked.';

/** Steps the board back over a load or import, while that is still the last thing that happened to it. */
export interface BoardUndo {
  message: string;
  label: string;
  undo: () => void;
  board: readonly ShowcaseItem[];
}

/** Stays until the next message or until the board changes, so nothing moves or goes away on a timer. */
export interface SlotNote {
  message: string;
  isProgress?: boolean;
  action?: { label: string; ariaLabel: string; restores: boolean; run: () => void };
  board: readonly ShowcaseItem[] | null;
  /** Makes an identical message a new one, so that it is announced and seen again. */
  tick: number;
}

export interface SlotAlert {
  message: string;
  kind: 'warning' | 'error';
  tick: number;
}

export type SlotFocus = { target: 'slot' | 'more' | 'undo' | 'restore' | 'open'; index: number; tick: number };

interface SavedLayoutsOptions {
  board: ShowcaseBoard | null;
  items: readonly ShowcaseItem[];
  settings: ShowcaseSettings;
  featured: string | null;
  pairs: readonly string[];
  isKnownPaint: (kitId: number) => boolean;
  wearCount: number;
  /** The paint selected in the catalog, which a saved board can be loaded in. */
  selectedPaint: { id: number; name: string; weapons: readonly string[] } | null;
  hasReplacedTextures: (kitId: number) => boolean;
  onSettingsChange: (settings: ShowcaseSettings) => void;
  onFeaturedChange: (weapon: string | null, pairs: readonly string[]) => void;
  /** Called as a saved board starts going on, for whatever the panel tidies then. */
  onApplyStart: () => void;
  /** False when the board could not be restored. */
  onRestore: (items: readonly ShowcaseItem[], layout: AppliedLayout | null, sideEffect: BoardEditSideEffect) => Promise<boolean>;
}

function readActiveSlot(): number | null {
  try {
    const index = Number(localStorage.getItem(ACTIVE_SLOT_KEY) ?? 'NaN');
    return readLayoutSlots()[index] ? index : null;
  } catch {
    return null;
  }
}

/** Numbered if another slot already goes by that name. */
function uniqueName(base: string, slots: LayoutSlots, index: number): string {
  const taken = new Set(slots.flatMap((slot, at) => (slot && at !== index ? [slot.name] : [])));
  if (!taken.has(base)) return base;
  let number = 2;
  while (taken.has(`${base} ${number}`)) number += 1;
  return `${base.slice(0, SLOT_NAME_LIMIT - 3)} ${number}`;
}

/** A board with no name of its own goes by the paint it shows. */
const paintName = (items: readonly ShowcaseItem[]) => items.find((item) => !item.image)?.paint.kitName ?? 'Showcase board';

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const atIndex = (slots: LayoutSlots, index: number, slot: LayoutSlot | null): LayoutSlots => slots.map((entry, at) => (at === index ? slot : entry));

export function useSavedLayouts({ board, items, settings, featured, pairs, isKnownPaint, wearCount, selectedPaint, hasReplacedTextures, onSettingsChange, onFeaturedChange, onApplyStart, onRestore }: SavedLayoutsOptions) {
  const [slots, setSlots] = useState(readLayoutSlots);
  /** What each slot held before it was last replaced or deleted, kept until it is next written. */
  const [backups, setBackups] = useState(readSlotBackups);
  const [activeSlot, setActiveSlot] = useState(readActiveSlot);
  /** The name an imported or repainted board came with, for saving or sharing it again. */
  const [boardName, setBoardName] = useState<string | null>(null);
  const [boardUndo, setBoardUndo] = useState<BoardUndo | null>(null);
  const [note, setNoteState] = useState<SlotNote | null>(null);
  const [alert, setAlertState] = useState<SlotAlert | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<SlotFocus | null>(null);
  /** The board as it was when it was detached from its slot, which must not link straight back while a layout loads. */
  const [detachedBoard, setDetachedBoard] = useState<readonly ShowcaseItem[] | null>(null);
  const lastSave = useRef({ index: -1, at: 0 });
  const messageTick = useRef(0);

  // A board that exactly matches a slot belongs to it, whichever way it got there: undoing a clear or a layout, for one.
  const matching = useMemo(
    () => (activeSlot === null && items.length && items !== detachedBoard ? slots.findIndex((slot) => slot && matchesBoard(slot, items, settings)) : -1),
    [activeSlot, detachedBoard, items, settings, slots],
  );
  if (board && !items.length && (activeSlot !== null || boardName !== null)) {
    // Nothing on the board is no longer that slot; left linked, the next board could overwrite it with one click.
    setActiveSlot(null);
    setBoardName(null);
  } else if (matching >= 0) {
    setActiveSlot(matching);
  }

  useEffect(() => {
    try {
      if (activeSlot === null) localStorage.removeItem(ACTIVE_SLOT_KEY);
      else localStorage.setItem(ACTIVE_SLOT_KEY, String(activeSlot));
    } catch {
      // Without storage the link to the slot lasts for the session.
    }
  }, [activeSlot]);

  // Another tab's changes, so that this one cannot take a slot for empty and write over them.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && !isSlotStorageKey(event.key)) return;
      setSlots(readLayoutSlots());
      setBackups(readSlotBackups());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const nextTick = () => {
    messageTick.current += 1;
    return messageTick.current;
  };
  const setNote = (message: string | null, extra: Pick<SlotNote, 'isProgress' | 'action'> = {}) => setNoteState(message === null ? null : { message, ...extra, board: board?.getSnapshot().items ?? null, tick: nextTick() });
  const setAlert = (message: string | null, kind: SlotAlert['kind'] = 'error') => setAlertState(message === null ? null : { message, kind, tick: nextTick() });
  const focusOn = (target: SlotFocus['target'], index: number) => setFocus((current) => ({ target, index, tick: (current?.tick ?? 0) + 1 }));
  const active = activeSlot === null ? null : slots[activeSlot] ?? null;
  const modified = useMemo(() => !!active && items.length > 0 && !matchesBoard(active, items, settings), [active, items, settings]);
  /** Stricter than not being modified: a working preference is no change to the board, yet a save does hold it. */
  const unchanged = !!active && !modified && sameSettings(active.settings, settings);

  const write = (index: number, slot: LayoutSlot | null, failure: string): boolean => {
    if (!writeLayoutSlot(index, slot)) {
      setAlert(failure);
      return false;
    }
    setSlots((current) => atIndex(current, index, slot));
    // Whatever went wrong with the slots before is over now.
    setAlertState(null);
    return true;
  };

  /** A failure only costs the way back after a reload, so it is said out loud instead of refusing a change that may be freeing up storage. */
  const keepBackup = (index: number, slot: LayoutSlot | null) => {
    if (!writeSlotBackup(index, slot)) setAlert('Could not keep the previous save past this session: this browser\'s storage is full or blocked.', 'warning');
    setBackups((current) => atIndex(current, index, slot));
  };

  /**
   * Swaps the slot with its backup, so restoring can be taken back too.
   * Takes both saves, as a button offered at the moment of a change sees the state from before it.
   */
  const restore = (index: number, backup: LayoutSlot | null, current: LayoutSlot | null) => {
    if (!backup || !write(index, backup, CHANGE_FAILED)) return;
    keepBackup(index, current);
    // Whatever is on the board now has nothing to do with the save that came back, unless it matches and links again.
    setActiveSlot((active) => (active === index ? null : active));
    setNote(`Restored "${backup.name}".`, current ? {
      action: { label: 'Undo', ariaLabel: `Undo restoring ${backup.name}`, restores: false, run: () => restore(index, current, backup) },
    } : {});
    focusOn('slot', index);
  };

  /** A save made while weapons are still painting would keep a picture of them half done for good. */
  const retakeThumbnail = async (index: number, saved: LayoutSlot) => {
    if (!board) return;
    await board.whenPainted();
    const current = readLayoutSlots()[index];
    if (current?.savedAt !== saved.savedAt || board.getSnapshot().items !== saved.items) return;
    const thumbnail = board.thumbnail(THUMBNAIL_WIDTH);
    if (!thumbnail || thumbnail === current.thumbnail) return;
    const next = { ...current, thumbnail };
    if (writeLayoutSlot(index, next)) setSlots((all) => atIndex(all, index, next));
  };

  const saveTo = (index: number) => {
    if (!board || !items.length) return;
    const previous = slots[index];
    const name = previous?.name || uniqueName(boardName || paintName(items), slots, index);
    const updating = activeSlot === index;
    const deleted = previous ? null : backups[index];
    const slot: LayoutSlot = {
      name, savedAt: Date.now(), thumbnail: board.thumbnail(THUMBNAIL_WIDTH), items: board.getSnapshot().items, settings, layout: board.appliedLayout, featured, pairs,
    };
    if (!write(index, slot, backups.some(Boolean) ? `${SAVE_FAILED} Or clear a deleted save to make room.` : SAVE_FAILED)) return;
    // Saving into an emptied slot leaves the deleted save as its previous one, as that row sits right beside Restore.
    if (previous) keepBackup(index, previous);
    void retakeThumbnail(index, slot);
    lastSave.current = { index, at: performance.now() };
    setActiveSlot(index);
    setBoardName(null);
    setBoardUndo(null);
    const replaced = items.some((item) => !item.image && hasReplacedTextures(item.paint.kitId)) ? ' Replaced textures are not kept.' : '';
    if (previous) {
      setNote(`${updating ? `Updated "${name}".` : `Replaced "${previous.name}".`}${replaced}`, {
        action: { label: 'Undo', ariaLabel: `Undo, restoring the previous save of ${previous.name}`, restores: true, run: () => restore(index, previous, slot) },
      });
    } else {
      setNote(`Saved as "${name}" in this browser.${replaced}`, deleted ? {
        action: { label: 'Restore deleted', ariaLabel: `Restore the deleted save ${deleted.name}`, restores: true, run: () => restore(index, deleted, slot) },
      } : {});
    }
    focusOn('slot', index);
  };

  const remove = (index: number) => {
    const previous = slots[index];
    if (!previous || !write(index, null, CHANGE_FAILED)) return;
    keepBackup(index, previous);
    if (activeSlot === index) setActiveSlot(null);
    setNote(`Deleted "${previous.name}".`);
    focusOn('restore', index);
  };

  /** Lets go of a deleted save, so that its row is simply empty again and its storage is free. */
  const clearDeleted = (index: number) => {
    const backup = backups[index];
    if (!backup) return;
    // Clearing is what the storage error suggests, so that error is over.
    setAlertState(null);
    keepBackup(index, null);
    setNote(`Cleared "${backup.name}".`, {
      action: {
        label: 'Undo',
        ariaLabel: `Undo clearing ${backup.name}`,
        restores: false,
        run: () => {
          keepBackup(index, backup);
          setNote(null);
          focusOn('restore', index);
        },
      },
    });
    focusOn('open', 0);
  };

  const rename = (index: number, name: string) => {
    const previous = slots[index];
    const next = name.trim();
    if (!previous || !next || next === previous.name || !write(index, { ...previous, name: next }, CHANGE_FAILED)) return;
    setNote(`Renamed to "${next}".`);
  };

  /** What slots and files share. Settings and the rest go on only once the board is back, so a failed load changes nothing. */
  const apply = async (saved: SavedBoard, slot: number | null, nextSettings: ShowcaseSettings, name: string | null): Promise<boolean> => {
    const put = (state: { settings: ShowcaseSettings; featured: string | null; pairs: readonly string[]; slot: number | null; name: string | null }) => {
      onSettingsChange(state.settings);
      onFeaturedChange(state.featured, state.pairs);
      setActiveSlot(state.slot);
      setBoardName(state.name);
    };
    const before = { settings, featured, pairs, slot: activeSlot, name: boardName };
    const after = { settings: nextSettings, featured: saved.featured, pairs: saved.pairs, slot, name };
    onApplyStart();
    const restored = await onRestore(saved.items, saved.layout, { undo: () => put(before), redo: () => put(after) });
    if (restored) put(after);
    return restored;
  };

  const offerBoardUndo = (message: string, label: string) => {
    if (!board) return;
    setBoardUndo({
      message,
      label,
      board: board.getSnapshot().items,
      undo: () => {
        setBoardUndo(null);
        focusOn('open', 0);
        // Once the board is back, or this note would count as older than the change it reports.
        void board.undo().then(() => setNote('Back to the previous board.'));
      },
    });
  };

  const load = async (index: number) => {
    const slot = slots[index];
    // The second click of a double click on what was an empty slot.
    if (!board || !slot || busy || (lastSave.current.index === index && performance.now() - lastSave.current.at < SAVE_CLICK_GUARD_MS)) return;
    setBusy(true);
    setBoardUndo(null);
    setAlert(null);
    setNote(`Loading "${slot.name}"...`, { isProgress: true });
    try {
      if (!await apply(slot, index, slot.settings, null)) {
        setNote(null);
        setAlert(`Could not load "${slot.name}". The board was left as it was.`);
        focusOn('more', index);
        return;
      }
      const dropped = Math.max(0, slot.items.length - board.getSnapshot().items.length);
      setNote(null);
      if (dropped) setAlert(`${plural(dropped, 'item')} could not be restored.`, 'warning');
      offerBoardUndo(`Loaded "${slot.name}".`, `Undo loading ${slot.name}`);
      focusOn('slot', index);
    } finally {
      setBusy(false);
    }
  };

  /** Uses a saved board as a template: the result is a new board, so `Update` cannot overwrite the original by accident. */
  const loadInPaint = async (index: number) => {
    const slot = slots[index];
    if (!board || !slot || !selectedPaint || busy) return;
    const { board: repainted, kept } = inPaint(slot, selectedPaint);
    // The paint is what tells this board from the save, so it must not be what gets cut off.
    const both = `${slot.name}, ${selectedPaint.name}`;
    setBusy(true);
    setBoardUndo(null);
    setAlert(null);
    setNote(`Loading "${slot.name}" with ${selectedPaint.name}...`, { isProgress: true });
    try {
      if (!await apply(repainted, null, slot.settings, both.length <= SLOT_NAME_LIMIT ? both : selectedPaint.name.slice(0, SLOT_NAME_LIMIT))) {
        setNote(null);
        setAlert(`Could not load "${slot.name}". The board was left as it was.`);
        focusOn('more', index);
        return;
      }
      const dropped = Math.max(0, repainted.items.length - board.getSnapshot().items.length);
      const problems = [
        dropped ? `${plural(dropped, 'item')} could not be restored.` : '',
        kept ? `${plural(kept, 'weapon')} kept ${kept === 1 ? 'its' : 'their'} paint: not available in ${selectedPaint.name}.` : '',
      ].filter(Boolean).join(' ');
      setNote(null);
      if (problems) setAlert(problems, 'warning');
      offerBoardUndo(`Loaded "${slot.name}" with ${selectedPaint.name}. Not saved to a slot.`, `Undo loading ${slot.name} with ${selectedPaint.name}`);
      focusOn('slot', index);
    } finally {
      setBusy(false);
    }
  };

  const exportLayout = async (layout: SharedLayout) => {
    if (!board || busy) return;
    setBusy(true);
    setAlert(null);
    try {
      const fileName = layoutFileName(layout.name);
      const { file, missing } = await writeLayoutFile(layout, (assetId) => board.imageFile(assetId));
      downloadBlob(file, fileName);
      setNote(`Downloaded ${fileName} (${formatSize(file.size)}).`);
      const replaced = layout.items.some((item) => !item.image && hasReplacedTextures(item.paint.kitId));
      const problems = [
        missing ? `${plural(missing, 'picture was', 'pictures were')} missing and left out of ${fileName}.` : '',
        replaced ? 'Replaced textures are not included.' : '',
      ].filter(Boolean).join(' ');
      if (problems) setAlert(problems, 'warning');
    } catch (cause) {
      console.error('[showcase] could not create the board file', cause);
      setAlert('Could not create the board file.');
    } finally {
      setBusy(false);
    }
  };

  /** Gives back what went wrong, in words fit to show, or null when the file went on the board. */
  const importFile = async (file: File): Promise<string | null> => {
    // Only a dropped file can get here like this, as the button is disabled until the board is ready.
    if (!board || busy) return `Could not open ${file.name} while a board is loading. Drop it again.`;
    setBusy(true);
    setAlert(null);
    setNote(`Opening ${file.name}...`, { isProgress: true });
    try {
      const { layout, pictures } = await readLayoutFile(file);
      // Decoded and stored under new ids here, which also turns down anything that is not really a picture.
      const stored = await Promise.all(pictures.map((picture) => board.importImage(picture).catch(() => null)));
      const shared = layout.items.flatMap((item) => {
        const paint = { ...item.paint, wearIndex: Math.min(item.paint.wearIndex, Math.max(0, wearCount - 1)) };
        if (!item.image) return [{ ...item, paint }];
        const picture = stored[pictureIndex(item.image.assetId)];
        return picture ? [{ ...item, paint, image: picture }] : [];
      });
      const name = layout.name || (isLayoutFileName(file.name) ? file.name.slice(0, -LAYOUT_FILE_EXTENSION.length) : file.name);
      if (!await apply({ ...layout, items: shared }, null, withSharedSettings(settings, layout.settings), name)) {
        const message = `Could not open "${name}". The board was left as it was.`;
        setNote(null);
        setAlert(message);
        return message;
      }
      const dropped = Math.max(0, layout.items.length - board.getSnapshot().items.length);
      const unknownPaints = shared.filter((item) => !item.image && !isKnownPaint(item.paint.kitId)).length;
      const problems = [
        dropped ? `${plural(dropped, 'item')} could not be restored.` : '',
        unknownPaints ? `${plural(unknownPaints, 'weapon')} ${unknownPaints === 1 ? 'shows' : 'show'} unpainted: ${unknownPaints === 1 ? 'its paint is' : 'their paints are'} not in this viewer.` : '',
      ].filter(Boolean).join(' ');
      // Opened from a file is what the note below says, even if a slot happens to hold the same board.
      setDetachedBoard(board.getSnapshot().items);
      setNote(null);
      if (problems) setAlert(problems, 'warning');
      offerBoardUndo(`Opened "${name}". Not saved to a slot.`, `Undo opening ${name}`);
      focusOn('undo', 0);
      return null;
    } catch (cause) {
      if (!(cause instanceof LayoutFileError)) console.error('[showcase] could not open the board file', cause);
      const message = cause instanceof LayoutFileError ? cause.message : `Could not open ${file.name}.`;
      setNote(null);
      setAlert(message);
      return message;
    } finally {
      setBusy(false);
    }
  };

  const boardLayout = (): SharedLayout | null => (board
    ? { name: boardName ?? active?.name ?? uniqueName(paintName(items), slots, -1), items, settings, layout: board.appliedLayout, featured, pairs }
    : null);

  /** A ready-made layout has nothing to do with the slot or file the board came from. */
  const detachBoard = useCallback(() => {
    setDetachedBoard(board?.getSnapshot().items ?? null);
    setActiveSlot(null);
    setBoardName(null);
  }, [board]);

  return {
    slots, backups, activeSlot, modified, unchanged, busy, focus, alert, selectedPaint,
    note: note && !note.isProgress && note.board !== items ? null : note,
    boardUndo: boardUndo?.board === items ? boardUndo : null,
    saveTo, remove, clearDeleted, rename, restore: (index: number) => restore(index, backups[index], slots[index]), load, loadInPaint, exportLayout, boardLayout, importFile, detachBoard, focusOn,
    dismissAlert: () => {
      setAlert(null);
      focusOn('open', 0);
    },
  };
}

export type SavedLayouts = ReturnType<typeof useSavedLayouts>;
