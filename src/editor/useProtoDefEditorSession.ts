import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  assignSelectGroupExclusively,
  clearSelectGroupIds,
  addStickerStages,
  addStickerVariant,
  equalizeStickerVariantWeights,
  EditorMutationAmbiguityError,
  moveStickerStages,
  removeStickerStages,
  removeStickerVariant,
  setStickerDestQuad,
  setStickerBaseReference,
  setStickerVariantBase,
  setStickerVariantWeight,
  setTextureLayerTeamColors,
  setTextureLayerTeamTexture,
  setTextureTransformFlip,
  setTextureTransformRange,
  pushTextureTransformRangeToAllWeapons,
  setWeaponMaterialOverride,
  setWeaponMaterialOverrides,
  setGroupTextureReference,
  type SelectGroupAssignmentResult,
  type SelectGroupAssignmentTarget,
  type SelectGroupTarget,
  type GroupTextureTarget,
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
  serializeProtoDefKitBundle,
  type ProtoDefKitBundleJsonExport,
  type SerializeProtoDefKitOptions,
} from './export/jsonExport';
import {
  activeOperationIndex,
  applyBundleEdit,
  operationMessages,
  selectActiveScope,
  snapshotBundle,
  type KitViewerScope,
} from './kitBundle';
import type { ProtoDefKitBundle, ProtoDefKitMessages, ProtoDefOperationScope } from '../protodefs/types';
import type { VarDefMsg } from '../protodefs/messages';
import {
  graphToOperation,
  validateOperationGraph,
  type OperationGraph,
} from './graph';
import type { OperationMsg } from '../protodefs/messages';

/** Fetches one imported kit's bundle by its catalog id. */
type ProtoDefEditorKitLoader = (kitId: number) => Promise<ProtoDefKitBundle | null>;

export interface UseProtoDefEditorSessionOptions {
  /** The selected imported catalog id, or null when the editor has no kit. */
  kitId: number | null | undefined;
  /** Loads the whole kit: useStockDefinitions or useCustomDefinitions exportKitBundle, by kind. */
  loadKit: ProtoDefEditorKitLoader;
  /**
   * The weapon and wear the viewer shows. For a per-wear paint this picks the
   * operation `current` exposes. Changing it never resets the session.
   */
  scope?: KitViewerScope;
}

interface ReloadProtoDefEditorSessionOptions {
  /**
   * Reloading replaces the session baseline and discards edits. The caller
   * must opt into that when the session is dirty rather than losing work as a
   * side effect of a refresh.
   */
  discardEdits?: boolean;
}

interface GroupTextureDefaultAssignment {
  readonly active: SelectGroupAssignmentTarget;
  readonly candidates: readonly SelectGroupAssignmentTarget[];
  readonly groupIds: readonly number[];
}

export interface ProtoDefEditorSession {
  status: 'idle' | 'loading' | 'ready' | 'error';
  kitId: number | null;
  /** The active operation's baseline, with the shared definition. */
  original: ProtoDefKitMessages | null;
  /** The active operation's working snapshot. Do not mutate it; use the session actions. */
  current: ProtoDefKitMessages | null;
  /** Immutable working bundle: every operation of the paint, the definition, and its item definitions. */
  bundle: ProtoDefKitBundle | null;
  /** Immutable baseline bundle, the one `dirty` is measured against. */
  originalBundle: ProtoDefKitBundle | null;
  /** Which operation each weapon and wear reads. Empty for a top-level paint. */
  scopes: readonly ProtoDefOperationScope[];
  /** The scope `current` edits for the viewer's weapon and wear, or null for a top-level paint. */
  activeScope: { weaponKey: string; wear: number } | null;
  /** Incremented whenever current changes (including when the viewer's scope changes it), so a renderer can rebuild from it. */
  revision: number;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  error: string | null;
  /** Assigns several raw ids as one atomic editor action. */
  assignSelectGroups: (
    active: SelectGroupAssignmentTarget,
    candidates: readonly SelectGroupAssignmentTarget[],
    groupIds: readonly number[],
  ) => readonly Omit<SelectGroupAssignmentResult, 'messages'>[] | null;
  /** Clears several selected ids from one layer in one atomic editor action. */
  clearSelectGroups: (target: SelectGroupTarget, groupIds: readonly number[]) => boolean;
  /** Changes the group-map layout and applies optional defaults in one undo step. */
  setGroupTexture: (
    target: GroupTextureTarget,
    textureRef: string,
    defaultAssignment?: GroupTextureDefaultAssignment,
  ) => boolean;
  /** Moves, scales, or rotates one sticker as a single undoable quad edit. */
  setStickerDestQuad: (target: StickerTarget, quad: StickerQuad) => boolean;
  addSticker: (target: StickerStructureTarget, quad: StickerQuad, baseReference: string) => boolean;
  removeSticker: (target: StickerStructureTarget) => boolean;
  moveSticker: (target: StickerStructureTarget, direction: -1 | 1) => boolean;
  /** Points one logical sticker at new artwork without touching stickers that shared it. */
  setStickerBase: (target: StickerStructureTarget, baseReference: string) => boolean;
  /** Sets one variant's relative weight, one history entry per call. */
  setStickerVariantWeight: (target: StickerStructureTarget, index: number, weight: number) => boolean;
  /** Appends artwork as a new weight-1 variant of one logical sticker. */
  addStickerVariant: (target: StickerStructureTarget, baseReference: string) => boolean;
  removeStickerVariant: (target: StickerStructureTarget, index: number) => boolean;
  /** Points one variant at new artwork, leaving the other variants and their artwork alone. */
  setStickerVariantBase: (target: StickerStructureTarget, index: number, baseReference: string) => boolean;
  /** Sets every variant's weight to 1 in one history entry. */
  equalizeStickerVariantWeights: (target: StickerStructureTarget) => boolean;
  /** Gives one texture layer separate RED and BLU artwork, or folds it back to one. */
  setLayerTeamColors: (target: Pick<TextureTransformTarget, 'stagePath'>, enabled: boolean) => boolean;
  setLayerTeamTexture: (target: Pick<TextureTransformTarget, 'stagePath'>, team: 'red' | 'blu', textureReference: string) => boolean;
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
  /** Replaces only the operation graph in one validated, undoable edit. */
  replaceOperationGraph: (graph: OperationGraph) => boolean;
  /**
   * Writes one paint-kit header variable. These are the values operation
   * stages bind to, so editing the declaration is how a bound parameter
   * changes without detaching the binding.
   */
  setDefinitionVariable: (name: string, value: string) => boolean;
  undo: () => void;
  redo: () => void;
  reset: () => void;
  /** Restores a locally saved working bundle as one undoable edit. */
  restoreDraft: (bundle: ProtoDefKitBundle) => boolean;
  /** Reloads the source kit. Dirty work requires discardEdits: true. */
  reload: (options?: ReloadProtoDefEditorSessionOptions) => Promise<boolean>;
  /** Serializes the whole working bundle to portable JSON fragments. */
  serialize: (options?: SerializeProtoDefKitOptions) => ProtoDefKitBundleJsonExport | null;
  clearError: () => void;
}

/** The paint kit's declared variables, whatever Many<T> shape they were authored in. */
function definitionHeaderVariables(definition: Record<string, unknown>): VarDefMsg[] {
  const header = definition.header;
  if (!header || typeof header !== 'object' || Array.isArray(header)) return [];
  const variables = (header as { variables?: unknown }).variables;
  const list = variables === undefined ? [] : Array.isArray(variables) ? variables : [variables];
  return list.filter((entry): entry is VarDefMsg => (
    Boolean(entry) && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string'
  ));
}

const NO_SCOPES: readonly ProtoDefOperationScope[] = [];

function errorMessage(cause: unknown): string {
  if (cause instanceof EditorMutationAmbiguityError || cause instanceof Error) return cause.message;
  return String(cause);
}

function isOperationMessage(value: Record<string, unknown>): value is Record<string, unknown> & OperationMsg {
  const header = value.header;
  return Boolean(
    header
    && typeof header === 'object'
    && !Array.isArray(header)
    && typeof (header as { defindex?: unknown }).defindex === 'number',
  );
}

/**
 * A small editor-only state machine for one imported proto_defs kit. It does
 * not guess which external weapon/wear source should receive an edit: the
 * mutation primitives reject ambiguous fields and surface the reason in error.
 */
export function useProtoDefEditorSession({
  kitId: requestedKitId,
  loadKit,
  scope,
}: UseProtoDefEditorSessionOptions): ProtoDefEditorSession {
  const kitId = requestedKitId ?? null;
  const [status, setStatus] = useState<ProtoDefEditorSession['status']>('idle');
  const [bundle, setBundle] = useState<ProtoDefKitBundle | null>(null);
  const [originalBundle, setOriginalBundle] = useState<ProtoDefKitBundle | null>(null);
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const bundleRef = useRef<ProtoDefKitBundle | null>(null);
  const originalRef = useRef<ProtoDefKitBundle | null>(null);
  const dirtyRef = useRef(false);
  const historyRef = useRef(new SnapshotHistory<ProtoDefKitBundle>());
  const requestRef = useRef(0);
  const loaderRef = useRef(loadKit);
  loaderRef.current = loadKit;
  const viewerWeaponKey = scope?.weaponKey;
  const viewerWear = scope?.wear;
  const viewer = useMemo<KitViewerScope | undefined>(
    () => (viewerWeaponKey === undefined || viewerWear === undefined
      ? undefined
      : { weaponKey: viewerWeaponKey, wear: viewerWear }),
    [viewerWeaponKey, viewerWear],
  );
  // Edit callbacks read the viewer's scope through a ref so they keep stable identities.
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;

  // Scope only chooses which operation is exposed. The bundle, its history,
  // and its dirty state are untouched by a change of weapon or wear.
  const activeIndex = bundle ? activeOperationIndex(bundle, viewer) : 0;
  const current = useMemo(
    () => (bundle ? operationMessages(bundle, activeIndex) : null),
    [bundle, activeIndex],
  );
  const original = useMemo(
    () => (originalBundle ? operationMessages(originalBundle, activeIndex) : null),
    [originalBundle, activeIndex],
  );
  const activeScope = bundle ? selectActiveScope(bundle.scopes, viewer) : null;

  // A different operation under `current` must count as a new revision, since
  // renderers (such as the operation graph's pending drafts) key on it.
  const [shownIndex, setShownIndex] = useState(activeIndex);
  if (shownIndex !== activeIndex) {
    setShownIndex(activeIndex);
    setRevision((value) => value + 1);
  }

  const install = useCallback((nextBundle: ProtoDefKitBundle) => {
    const nextOriginal = snapshotBundle(nextBundle);
    // Both references deliberately begin at the same frozen snapshot. Every
    // edit produces a fresh snapshot, making identity a precise dirty check
    // and letting undo return to the actual baseline without deep comparison.
    originalRef.current = nextOriginal;
    bundleRef.current = nextOriginal;
    historyRef.current.clear();
    dirtyRef.current = false;
    setOriginalBundle(nextOriginal);
    setBundle(nextOriginal);
    setRevision((value) => value + 1);
    setDirty(false);
    setCanUndo(false);
    setCanRedo(false);
    setStatus('ready');
    setError(null);
  }, []);

  const clear = useCallback((nextStatus: ProtoDefEditorSession['status'] = 'idle') => {
    originalRef.current = null;
    bundleRef.current = null;
    historyRef.current.clear();
    dirtyRef.current = false;
    setOriginalBundle(null);
    setBundle(null);
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
    clear('loading');
    setError(null);
    try {
      const loaded = await loaderRef.current(kitId);
      // A selection or loader change won while awaiting the source.
      if (request !== requestRef.current) return false;
      if (!loaded) throw new Error('The selected imported definition is no longer available.');
      install(loaded);
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

  const commitEdit = useCallback((prior: ProtoDefKitBundle, next: ProtoDefKitBundle) => {
    historyRef.current.record(prior);
    bundleRef.current = next;
    dirtyRef.current = true;
    setBundle(next);
    setRevision((value) => value + 1);
    setDirty(true);
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(historyRef.current.canRedo);
    setError(null);
  }, []);

  const applyEdit = useCallback((edit: (prior: ProtoDefKitMessages) => ProtoDefKitMessages): boolean => {
    const prior = bundleRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    try {
      const next = applyBundleEdit(prior, activeOperationIndex(prior, viewerRef.current), edit);
      if (next === prior) return false;
      commitEdit(prior, snapshotBundle(next));
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  const assignSelectGroups = useCallback((
    active: SelectGroupAssignmentTarget,
    candidates: readonly SelectGroupAssignmentTarget[],
    groupIds: readonly number[],
  ): readonly Omit<SelectGroupAssignmentResult, 'messages'>[] | null => {
    const prior = bundleRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return null;
    }
    try {
      const results: Array<Omit<SelectGroupAssignmentResult, 'messages'>> = [];
      const seen = new Set<number>();
      const next = applyBundleEdit(prior, activeOperationIndex(prior, viewerRef.current), (messages) => {
        let edited = messages;
        for (const groupId of groupIds) {
          if (seen.has(groupId)) continue;
          seen.add(groupId);
          const result = assignSelectGroupExclusively(edited, active, candidates, groupId);
          edited = result.messages;
          results.push({ action: result.action, displacedLabels: result.displacedLabels });
        }
        return edited;
      });
      if (results.length === 0) return [];
      commitEdit(prior, snapshotBundle(next));
      return results;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    }
  }, [commitEdit]);

  const clearSelectGroups = useCallback((target: SelectGroupTarget, groupIds: readonly number[]): boolean => (
    applyEdit((prior) => clearSelectGroupIds(prior, target, groupIds))
  ), [applyEdit]);

  const setGroupTexture = useCallback((
    target: GroupTextureTarget,
    textureRef: string,
    defaultAssignment?: GroupTextureDefaultAssignment,
  ): boolean => applyEdit((prior) => {
    let next = setGroupTextureReference(prior, target, textureRef);
    if (defaultAssignment) {
      // A literal map is renamed in place, so assignment targets that name the old value must follow it.
      const previousLiteral = 'kind' in target ? target.groupsValue : undefined;
      const follow = (entry: SelectGroupAssignmentTarget): SelectGroupAssignmentTarget => (
        previousLiteral !== undefined && entry.target.groupsValue === previousLiteral
          ? { ...entry, target: { ...entry.target, groupsValue: textureRef.trim() } }
          : entry
      );
      const active = follow(defaultAssignment.active);
      const candidates = defaultAssignment.candidates.map(follow);
      for (const groupId of defaultAssignment.groupIds) {
        next = assignSelectGroupExclusively(next, active, candidates, groupId).messages;
      }
    }
    return next;
  }), [applyEdit]);

  // The UI commits the quad once per completed drag, keeping one undo step.
  const setStickerQuad = useCallback((target: StickerTarget, quad: StickerQuad): boolean => (
    applyEdit((prior) => setStickerDestQuad(prior, target, quad))
  ), [applyEdit]);

  // Batches a transform drag or typing burst into one history entry while
  // still updating `current` (and therefore the live viewer) on every
  // intermediate value, unlike setStickerQuad's single end-of-drag commit:
  // a rotated/scaled paint layer has no cheap shader-uniform preview the way
  // a sticker quad does, so the live redraw has to go through the same
  // recipe recomposite path a committed edit already uses.
  const transformGestureRef = useRef<{ baseline: ProtoDefKitBundle; recorded: boolean } | null>(null);

  const beginTransformGesture = useCallback(() => {
    const working = bundleRef.current;
    if (working) transformGestureRef.current = { baseline: working, recorded: false };
  }, []);

  const endTransformGesture = useCallback(() => {
    transformGestureRef.current = null;
  }, []);

  const applyTransformEdit = useCallback((mutate: (prior: ProtoDefKitMessages) => ProtoDefKitMessages): boolean => {
    const prior = bundleRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    try {
      const next = snapshotBundle(applyBundleEdit(prior, activeOperationIndex(prior, viewerRef.current), mutate));
      const gesture = transformGestureRef.current;
      if (gesture) {
        if (!gesture.recorded) {
          historyRef.current.record(gesture.baseline);
          gesture.recorded = true;
        }
        bundleRef.current = next;
        dirtyRef.current = true;
        setBundle(next);
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

  const setWeaponMaterial = useCallback((target: WeaponMaterialTarget, overridePath: string | null): boolean => (
    applyEdit((prior) => setWeaponMaterialOverride(prior, target, overridePath))
  ), [applyEdit]);

  const setWeaponMaterials = useCallback((updates: readonly WeaponMaterialUpdate[]): boolean => (
    applyEdit((prior) => setWeaponMaterialOverrides(prior, updates))
  ), [applyEdit]);

  const replaceOperationGraph = useCallback((graph: OperationGraph): boolean => {
    const prior = bundleRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    const validation = validateOperationGraph(graph);
    if (!validation.valid) {
      setError(validation.diagnostics.map((diagnostic) => diagnostic.message).join(' '));
      return false;
    }
    const index = activeOperationIndex(prior, viewerRef.current);
    const messages = operationMessages(prior, index);
    if (!messages || !isOperationMessage(messages.operation)) {
      setError('The selected definition has an invalid operation message.');
      return false;
    }
    try {
      const operation = graphToOperation(graph);
      const merged = {
        ...messages.operation,
        ...operation,
        header: {
          ...messages.operation.header,
          ...operation.header,
        },
        operation_node: operation.operation_node,
      };
      const next = snapshotBundle(applyBundleEdit(prior, index, (active) => ({ ...active, operation: merged })));
      commitEdit(prior, next);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  const setDefinitionVariable = useCallback((name: string, value: string): boolean => {
    const prior = bundleRef.current;
    if (!prior) {
      setError('Load an imported definition before editing it.');
      return false;
    }
    const declared = definitionHeaderVariables(prior.definition);
    const index = declared.findIndex((variable) => variable.name === name);
    if (index < 0) {
      setError(`Variable “${name}” is not declared by this paint kit.`);
      return false;
    }
    if (declared[index]?.value === value) return false;
    const replacement = declared.map((variable, position) => (
      position === index ? { ...variable, value } : variable
    ));
    const definition = structuredClone(prior.definition) as Record<string, unknown>;
    const header = definition.header as Record<string, unknown>;
    // Preserve the authored Many<T> shape: a lone declaration stays a lone
    // declaration so the serialized definition keeps byte-for-byte structure.
    header.variables = Array.isArray(header.variables) ? replacement : replacement[0];
    commitEdit(prior, snapshotBundle({ ...prior, definition }));
    return true;
  }, [commitEdit]);

  const addSticker = useCallback((target: StickerStructureTarget, quad: StickerQuad, baseReference: string) => (
    applyEdit((prior) => addStickerStages(prior, target, quad, baseReference))
  ), [applyEdit]);

  const removeSticker = useCallback((target: StickerStructureTarget) => (
    applyEdit((prior) => removeStickerStages(prior, target))
  ), [applyEdit]);

  const moveSticker = useCallback((target: StickerStructureTarget, direction: -1 | 1) => (
    applyEdit((prior) => moveStickerStages(prior, target, direction))
  ), [applyEdit]);

  const setStickerBase = useCallback((target: StickerStructureTarget, baseReference: string) => (
    applyEdit((prior) => setStickerBaseReference(prior, target, baseReference))
  ), [applyEdit]);

  const setVariantWeight = useCallback((target: StickerStructureTarget, index: number, weight: number) => (
    applyEdit((prior) => setStickerVariantWeight(prior, target, index, weight))
  ), [applyEdit]);

  const addVariant = useCallback((target: StickerStructureTarget, baseReference: string) => (
    applyEdit((prior) => addStickerVariant(prior, target, baseReference))
  ), [applyEdit]);

  const removeVariant = useCallback((target: StickerStructureTarget, index: number) => (
    applyEdit((prior) => removeStickerVariant(prior, target, index))
  ), [applyEdit]);

  const setVariantBase = useCallback((target: StickerStructureTarget, index: number, baseReference: string) => (
    applyEdit((prior) => setStickerVariantBase(prior, target, index, baseReference))
  ), [applyEdit]);

  const equalizeVariantWeights = useCallback((target: StickerStructureTarget) => (
    applyEdit((prior) => equalizeStickerVariantWeights(prior, target))
  ), [applyEdit]);

  const setLayerTeamColors = useCallback((target: Pick<TextureTransformTarget, 'stagePath'>, enabled: boolean) => (
    applyEdit((prior) => setTextureLayerTeamColors(prior, target, enabled))
  ), [applyEdit]);

  const setLayerTeamTexture = useCallback((
    target: Pick<TextureTransformTarget, 'stagePath'>,
    team: 'red' | 'blu',
    textureReference: string,
  ) => (
    applyEdit((prior) => setTextureLayerTeamTexture(prior, target, team, textureReference))
  ), [applyEdit]);

  const undo = useCallback(() => {
    const working = bundleRef.current;
    if (!working) return;
    const prior = historyRef.current.undo(working);
    if (!prior) return;
    bundleRef.current = prior;
    const nextDirty = prior !== originalRef.current;
    dirtyRef.current = nextDirty;
    setBundle(prior);
    setRevision((value) => value + 1);
    setDirty(nextDirty);
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(historyRef.current.canRedo);
    setError(null);
  }, []);

  const redo = useCallback(() => {
    const working = bundleRef.current;
    if (!working) return;
    const next = historyRef.current.redo(working);
    if (!next) return;
    bundleRef.current = next;
    const nextDirty = next !== originalRef.current;
    dirtyRef.current = nextDirty;
    setBundle(next);
    setRevision((value) => value + 1);
    setDirty(nextDirty);
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(historyRef.current.canRedo);
    setError(null);
  }, []);

  const reset = useCallback(() => {
    const baseline = originalRef.current;
    const prior = bundleRef.current;
    if (!baseline || !prior || prior === baseline) return;
    historyRef.current.record(prior);
    bundleRef.current = baseline;
    dirtyRef.current = false;
    setBundle(baseline);
    setRevision((value) => value + 1);
    setDirty(false);
    setCanUndo(historyRef.current.canUndo);
    setCanRedo(false);
    setError(null);
  }, []);

  const restoreDraft = useCallback((draft: ProtoDefKitBundle): boolean => {
    const baseline = originalRef.current;
    if (!baseline) {
      setError('Load a war paint before restoring its draft.');
      return false;
    }
    // A draft saved from a different source file under the same name must not
    // leave the viewer's scope pointing at an operation that does not exist.
    if (draft.operations.length !== baseline.operations.length
      || JSON.stringify(draft.scopes) !== JSON.stringify(baseline.scopes)) {
      setError('This draft does not match the loaded war paint.');
      return false;
    }
    try {
      commitEdit(baseline, snapshotBundle(draft));
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    }
  }, [commitEdit]);

  const reload = useCallback(
    (options: ReloadProtoDefEditorSessionOptions = {}) => load(options.discardEdits === true),
    [load],
  );

  const serialize = useCallback((options: SerializeProtoDefKitOptions = {}): ProtoDefKitBundleJsonExport | null => {
    const working = bundleRef.current;
    if (!working) {
      setError('Load an imported definition before exporting it.');
      return null;
    }
    try {
      const result = serializeProtoDefKitBundle(working, options);
      setError(null);
      return result;
    } catch (cause) {
      setError(errorMessage(cause));
      return null;
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    status,
    kitId,
    original,
    current,
    bundle,
    originalBundle,
    scopes: bundle?.scopes ?? NO_SCOPES,
    activeScope,
    revision,
    dirty,
    canUndo,
    canRedo,
    error,
    assignSelectGroups,
    clearSelectGroups,
    setGroupTexture,
    setStickerDestQuad: setStickerQuad,
    addSticker,
    removeSticker,
    moveSticker,
    setStickerBase,
    setStickerVariantWeight: setVariantWeight,
    addStickerVariant: addVariant,
    removeStickerVariant: removeVariant,
    setStickerVariantBase: setVariantBase,
    equalizeStickerVariantWeights: equalizeVariantWeights,
    setLayerTeamColors,
    setLayerTeamTexture,
    beginTransformGesture,
    endTransformGesture,
    setTransformRange,
    pushTransformRangeToAll,
    setTransformFlip,
    setWeaponMaterial,
    setWeaponMaterials,
    replaceOperationGraph,
    setDefinitionVariable,
    undo,
    redo,
    reset,
    restoreDraft,
    reload,
    serialize,
    clearError,
  };
}
