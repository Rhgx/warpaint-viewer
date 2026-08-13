import { useCallback, useEffect, useRef, useState } from 'react';
import {
  assignSelectGroupExclusively,
  clearSelectGroupIds,
  addStickerStages,
  EditorMutationAmbiguityError,
  moveStickerStages,
  removeStickerStages,
  setStickerDestQuad,
  setTextureTransformFlip,
  setTextureTransformRange,
  pushTextureTransformRangeToAllWeapons,
  setWeaponMaterialOverride,
  setWeaponMaterialOverrides,
  toggleSelectGroupId,
  type SelectGroupAssignmentResult,
  type SelectGroupAssignmentTarget,
  type SelectGroupTarget,
  type StickerQuad,
  type StickerStructureTarget,
  type StickerTarget,
  type TextureTransformRangeField,
  type TextureTransformRangeValue,
  type TextureTransformTarget,
  type WeaponMaterialTarget,
  type WeaponMaterialUpdate,
} from './mutations';
import { SnapshotHistory } from './history';
import {
  serializeProtoDefKitMessages,
  type ProtoDefKitJsonExport,
  type SerializeProtoDefKitOptions,
} from './jsonExport';
import type { ProtoDefKitMessages } from '../protodefs/types';

/** Fetches one imported kit by its catalog id. */
export type ProtoDefEditorKitLoader = (kitId: number) => Promise<ProtoDefKitMessages | null>;

export interface UseProtoDefEditorSessionOptions {
  /** The selected imported catalog id, or null when the editor has no kit. */
  kitId: number | null | undefined;
  /** Usually useCustomDefinitions().exportKit. */
  loadKit: ProtoDefEditorKitLoader;
}

export interface ReloadProtoDefEditorSessionOptions {
  /**
   * Reloading replaces the session baseline and discards edits. The caller
   * must opt into that when the session is dirty rather than losing work as a
   * side effect of a refresh.
   */
  discardEdits?: boolean;
}

export interface ProtoDefEditorSession {
  status: 'idle' | 'loading' | 'ready' | 'error';
  kitId: number | null;
  /** Immutable baseline as it was loaded from the imported definition source. */
  original: ProtoDefKitMessages | null;
  /** Immutable working snapshot. Do not mutate it; use the session actions. */
  current: ProtoDefKitMessages | null;
  /** Incremented whenever current changes, so a renderer can rebuild from it. */
  revision: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  error: string | null;
  /** Safely applies one literal select-group toggle to the exact target stage. */
  toggleSelectGroup: (target: SelectGroupTarget, groupId: number) => boolean;
  /** Assigns a group to one layer, clearing any existing owner in one undo step. */
  assignSelectGroup: (
    active: SelectGroupAssignmentTarget,
    candidates: readonly SelectGroupAssignmentTarget[],
    groupId: number,
  ) => Omit<SelectGroupAssignmentResult, 'messages'> | null;
  /** Assigns several raw ids as one atomic editor action. */
  assignSelectGroups: (
    active: SelectGroupAssignmentTarget,
    candidates: readonly SelectGroupAssignmentTarget[],
    groupIds: readonly number[],
  ) => readonly Omit<SelectGroupAssignmentResult, 'messages'>[] | null;
  /** Clears several selected ids from one layer in one atomic editor action. */
  clearSelectGroups: (target: SelectGroupTarget, groupIds: readonly number[]) => boolean;
  /** Moves, scales, or rotates one sticker as a single undoable quad edit. */
  setStickerDestQuad: (target: StickerTarget, quad: StickerQuad) => boolean;
  addSticker: (target: StickerStructureTarget, quad: StickerQuad, baseReference: string) => boolean;
  removeSticker: (target: StickerStructureTarget) => boolean;
  moveSticker: (target: StickerStructureTarget, direction: -1 | 1) => boolean;
  /**
   * Opens a batched transform gesture: calls to setTransformRange/setTransformFlip
   * made before the matching endTransformGesture() update `current` live (so the
   * viewer keeps redrawing as a slider moves) but collapse into the single
   * history entry recorded by the first of those calls, exactly like a sticker
   * drag committing one quad at pointer-up.
   */
  beginTransformGesture: () => void;
  endTransformGesture: () => void;
  setTransformRange: (target: TextureTransformTarget, field: TextureTransformRangeField, value: TextureTransformRangeValue) => boolean;
  pushTransformRangeToAll: (
    target: TextureTransformTarget,
    field: TextureTransformRangeField,
    value: TextureTransformRangeValue,
    weaponOverridePaths: readonly (readonly string[])[],
  ) => boolean;
  setTransformFlip: (target: TextureTransformTarget, axis: 'u' | 'v', allowed: boolean) => boolean;
  /** Writes or clears one weapon's material override as a single undo step. */
  setWeaponMaterial: (target: WeaponMaterialTarget, overridePath: string | null) => boolean;
  /** Applies several material overrides as one undoable editor action. */
  setWeaponMaterials: (updates: readonly WeaponMaterialUpdate[]) => boolean;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  /** Reloads the source kit. Dirty work requires discardEdits: true. */
  reload: (options?: ReloadProtoDefEditorSessionOptions) => Promise<boolean>;
  /** Serializes the current working snapshot to portable operation/definition JSON. */
  serialize: (options?: SerializeProtoDefKitOptions) => ProtoDefKitJsonExport | null;
  /**
   * Returns a mutable copy suitable for a renderer or a one-off resolver. The
   * returned copy is intentionally detached from editor history.
   */
  getCurrentMessages: () => ProtoDefKitMessages | null;
  clearError: () => void;
}

function cloneMessages(messages: ProtoDefKitMessages): ProtoDefKitMessages {
  return structuredClone(messages) as ProtoDefKitMessages;
}

/**
 * Decoder messages are plain data, but freezing them catches accidental UI
 * mutation early. The WeakSet also makes this safe for an unexpected cycle.
 */
function freezeDeep<T>(value: T, visited = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return value;
  const object = value as object;
  if (visited.has(object)) return value;
  visited.add(object);
  for (const child of Object.values(object as Record<string, unknown>)) freezeDeep(child, visited);
  return Object.freeze(value);
}

function snapshot(messages: ProtoDefKitMessages): ProtoDefKitMessages {
  return freezeDeep(cloneMessages(messages));
}

function errorMessage(cause: unknown): string {
  if (cause instanceof EditorMutationAmbiguityError || cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * A small editor-only state machine for one imported proto_defs kit. It does
 * not guess which external weapon/wear source should receive an edit: the
 * mutation primitives reject ambiguous fields and surface the reason in error.
 */
export function useProtoDefEditorSession({
  kitId: requestedKitId,
  loadKit,
}: UseProtoDefEditorSessionOptions): ProtoDefEditorSession {
  const kitId = requestedKitId ?? null;
  const [status, setStatus] = useState<ProtoDefEditorSession['status']>('idle');
  const [original, setOriginal] = useState<ProtoDefKitMessages | null>(null);
  const [current, setCurrent] = useState<ProtoDefKitMessages | null>(null);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentRef = useRef<ProtoDefKitMessages | null>(null);
  const originalRef = useRef<ProtoDefKitMessages | null>(null);
  const dirtyRef = useRef(false);
  const historyRef = useRef(new SnapshotHistory<ProtoDefKitMessages>());
  const requestRef = useRef(0);
  const loaderRef = useRef(loadKit);
  loaderRef.current = loadKit;

  const install = useCallback((messages: ProtoDefKitMessages) => {
    const nextOriginal = snapshot(messages);
    // Both references deliberately begin at the same frozen snapshot. Every
    // edit produces a fresh snapshot, making identity a precise dirty check
    // and letting undo return to the actual baseline without deep comparison.
    const nextCurrent = nextOriginal;
    originalRef.current = nextOriginal;
    currentRef.current = nextCurrent;
    historyRef.current.clear();
    dirtyRef.current = false;
    setOriginal(nextOriginal);
    setCurrent(nextCurrent);
    setRevision((value) => value + 1);
    setDirty(false);
    setCanUndo(false);
    setCanRedo(false);
    setStatus('ready');
    setError(null);
  }, []);

  const clear = useCallback((nextStatus: ProtoDefEditorSession['status'] = 'idle') => {
    originalRef.current = null;
    currentRef.current = null;
    historyRef.current.clear();
    dirtyRef.current = false;
    setOriginal(null);
    setCurrent(null);
    setRevision((value) => value + 1);
    setDirty(false);
    setCanUndo(false);
    setCanRedo(false);
    setStatus(nextStatus);
  }, []);

  const load = useCallback(async (allowDiscard: boolean): Promise<boolean> => {
    if (kitId === null) {
      clear();
      return false;
    }
    if (dirtyRef.current && !allowDiscard) {
      setError('This session has unsaved edits. Pass discardEdits: true before reloading it.');
      return false;
    }
    const request = ++requestRef.current;
    setStatus('loading');
    setError(null);
    try {
      const messages = await loaderRef.current(kitId);
      // A selection or loader change won while awaiting the source.
      if (request !== requestRef.current) return false;
      if (!messages) throw new Error('The selected imported definition is no longer available.');
      install(messages);
      return true;
    } catch (cause) {
      if (request !== requestRef.current) return false;
      clear('error');
      setError(errorMessage(cause));
      return false;
    }
  }, [clear, install, kitId]);

  // A kit selection intentionally starts a fresh session. Source refreshes
  // remain explicit through reload(), so a parent re-render cannot discard
  // unsaved work merely because it supplied a new callback identity.
  useEffect(() => {
    void load(true);
    return () => { requestRef.current += 1; };
  }, [load]);

  const commitEdit = useCallback((prior: ProtoDefKitMessages, next: ProtoDefKitMessages) => {
    historyRef.current.record(prior);
    currentRef.current = next;
    dirtyRef.current = true;
    setCurrent(next);
    setRevision((value) => value + 1);
    setDirty(true);
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(historyRef.current.canRedo);
    setError(null);
  }, []);

  const toggleSelectGroup = useCallback((target: SelectGroupTarget, groupId: number): boolean => {
    const prior = currentRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    try {
      const next = snapshot(toggleSelectGroupId(prior, target, groupId));
      commitEdit(prior, next);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  const assignSelectGroup = useCallback((
    active: SelectGroupAssignmentTarget,
    candidates: readonly SelectGroupAssignmentTarget[],
    groupId: number,
  ): Omit<SelectGroupAssignmentResult, 'messages'> | null => {
    const prior = currentRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return null;
    }
    try {
      const result = assignSelectGroupExclusively(prior, active, candidates, groupId);
      const next = snapshot(result.messages);
      commitEdit(prior, next);
      return { action: result.action, displacedLabels: result.displacedLabels };
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    }
  }, [commitEdit]);

  const assignSelectGroups = useCallback((
    active: SelectGroupAssignmentTarget,
    candidates: readonly SelectGroupAssignmentTarget[],
    groupIds: readonly number[],
  ): readonly Omit<SelectGroupAssignmentResult, 'messages'>[] | null => {
    const prior = currentRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return null;
    }
    try {
      let next = prior;
      const results: Array<Omit<SelectGroupAssignmentResult, 'messages'>> = [];
      const seen = new Set<number>();
      for (const groupId of groupIds) {
        if (seen.has(groupId)) continue;
        seen.add(groupId);
        const result = assignSelectGroupExclusively(next, active, candidates, groupId);
        next = result.messages;
        results.push({ action: result.action, displacedLabels: result.displacedLabels });
      }
      if (results.length === 0) return [];
      commitEdit(prior, snapshot(next));
      return results;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    }
  }, [commitEdit]);

  const clearSelectGroups = useCallback((target: SelectGroupTarget, groupIds: readonly number[]): boolean => {
    const prior = currentRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    if (groupIds.length === 0) return false;
    try {
      const cleared = clearSelectGroupIds(prior, target, groupIds);
      if (cleared === prior) return false;
      commitEdit(prior, snapshot(cleared));
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  const setStickerQuad = useCallback((target: StickerTarget, quad: StickerQuad): boolean => {
    const prior = currentRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    try {
      // A drag may update all three corners many times in the UI, but each
      // completed gesture calls this action once and therefore produces one
      // immutable history snapshot.
      const next = snapshot(setStickerDestQuad(prior, target, quad));
      commitEdit(prior, next);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  // Batches a transform drag or typing burst into one history entry while
  // still updating `current` (and therefore the live viewer) on every
  // intermediate value, unlike setStickerQuad's single end-of-drag commit:
  // a rotated/scaled paint layer has no cheap shader-uniform preview the way
  // a sticker quad does, so the live redraw has to go through the same
  // recipe recomposite path a committed edit already uses.
  const transformGestureRef = useRef<{ baseline: ProtoDefKitMessages; recorded: boolean } | null>(null);

  const beginTransformGesture = useCallback(() => {
    const current = currentRef.current;
    if (current) transformGestureRef.current = { baseline: current, recorded: false };
  }, []);

  const endTransformGesture = useCallback(() => {
    transformGestureRef.current = null;
  }, []);

  const applyTransformEdit = useCallback((mutate: (prior: ProtoDefKitMessages) => ProtoDefKitMessages): boolean => {
    const prior = currentRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    try {
      const next = snapshot(mutate(prior));
      const gesture = transformGestureRef.current;
      if (gesture) {
        if (!gesture.recorded) {
          historyRef.current.record(gesture.baseline);
          gesture.recorded = true;
        }
        currentRef.current = next;
        dirtyRef.current = true;
        setCurrent(next);
        setRevision((value) => value + 1);
        setDirty(true);
        setCanUndo(historyRef.current.canUndo);
        setCanRedo(historyRef.current.canRedo);
        setError(null);
      } else {
        commitEdit(prior, next);
      }
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  const setTransformRange = useCallback((
    target: TextureTransformTarget,
    field: TextureTransformRangeField,
    value: TextureTransformRangeValue,
  ): boolean => applyTransformEdit((prior) => setTextureTransformRange(prior, target, field, value)), [applyTransformEdit]);

  const setTransformFlip = useCallback((
    target: TextureTransformTarget,
    axis: 'u' | 'v',
    allowed: boolean,
  ): boolean => applyTransformEdit((prior) => setTextureTransformFlip(prior, target, axis, allowed)), [applyTransformEdit]);

  const pushTransformRangeToAll = useCallback((
    target: TextureTransformTarget,
    field: TextureTransformRangeField,
    value: TextureTransformRangeValue,
    weaponOverridePaths: readonly (readonly string[])[],
  ): boolean => applyTransformEdit((prior) => pushTextureTransformRangeToAllWeapons(
    prior,
    target,
    field,
    value,
    weaponOverridePaths,
  )), [applyTransformEdit]);

  const setWeaponMaterial = useCallback((target: WeaponMaterialTarget, overridePath: string | null): boolean => {
    const prior = currentRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    try {
      const changed = setWeaponMaterialOverride(prior, target, overridePath);
      if (changed === prior) return false;
      commitEdit(prior, snapshot(changed));
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  const setWeaponMaterials = useCallback((updates: readonly WeaponMaterialUpdate[]): boolean => {
    const prior = currentRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    try {
      const changed = setWeaponMaterialOverrides(prior, updates);
      if (changed === prior) return false;
      commitEdit(prior, snapshot(changed));
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  const applyStickerStructureEdit = useCallback((edit: (prior: ProtoDefKitMessages) => ProtoDefKitMessages): boolean => {
    const prior = currentRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    try {
      commitEdit(prior, snapshot(edit(prior)));
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  const addSticker = useCallback((target: StickerStructureTarget, quad: StickerQuad, baseReference: string) => (
    applyStickerStructureEdit((prior) => addStickerStages(prior, target, quad, baseReference))
  ), [applyStickerStructureEdit]);

  const removeSticker = useCallback((target: StickerStructureTarget) => (
    applyStickerStructureEdit((prior) => removeStickerStages(prior, target))
  ), [applyStickerStructureEdit]);

  const moveSticker = useCallback((target: StickerStructureTarget, direction: -1 | 1) => (
    applyStickerStructureEdit((prior) => moveStickerStages(prior, target, direction))
  ), [applyStickerStructureEdit]);

  const undo = useCallback(() => {
    const currentMessages = currentRef.current;
    if (!currentMessages) return;
    const prior = historyRef.current.undo(currentMessages);
    if (!prior) return;
    currentRef.current = prior;
    const nextDirty = prior !== originalRef.current;
    dirtyRef.current = nextDirty;
    setCurrent(prior);
    setRevision((value) => value + 1);
    setDirty(nextDirty);
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(historyRef.current.canRedo);
    setError(null);
  }, []);

  const redo = useCallback(() => {
    const currentMessages = currentRef.current;
    if (!currentMessages) return;
    const next = historyRef.current.redo(currentMessages);
    if (!next) return;
    currentRef.current = next;
    const nextDirty = next !== originalRef.current;
    dirtyRef.current = nextDirty;
    setCurrent(next);
    setRevision((value) => value + 1);
    setDirty(nextDirty);
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(historyRef.current.canRedo);
    setError(null);
  }, []);

  const reset = useCallback(() => {
    const baseline = originalRef.current;
    const prior = currentRef.current;
    if (!baseline || !prior || prior === baseline) return;
    historyRef.current.record(prior);
    currentRef.current = baseline;
    dirtyRef.current = false;
    setCurrent(baseline);
    setRevision((value) => value + 1);
    setDirty(false);
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(false);
    setError(null);
  }, []);

  const reload = useCallback(
    (options: ReloadProtoDefEditorSessionOptions = {}) => load(options.discardEdits === true),
    [load],
  );

  const serialize = useCallback((options: SerializeProtoDefKitOptions = {}): ProtoDefKitJsonExport | null => {
    const messages = currentRef.current;
    if (!messages) {
      setError('Load an imported definition before exporting it.');
      return null;
    }
    try {
      const result = serializeProtoDefKitMessages(messages, options);
      setError(null);
      return result;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    }
  }, []);

  const getCurrentMessages = useCallback(() => {
    const messages = currentRef.current;
    return messages ? cloneMessages(messages) : null;
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    status,
    kitId,
    original,
    current,
    revision,
    dirty,
    canUndo,
    canRedo,
    error,
    toggleSelectGroup,
    assignSelectGroup,
    assignSelectGroups,
    clearSelectGroups,
    setStickerDestQuad: setStickerQuad,
    addSticker,
    removeSticker,
    moveSticker,
    beginTransformGesture,
    endTransformGesture,
    setTransformRange,
    pushTransformRangeToAll,
    setTransformFlip,
    setWeaponMaterial,
    setWeaponMaterials,
    undo,
    redo,
    reset,
    reload,
    serialize,
    getCurrentMessages,
    clearError,
  };
}
