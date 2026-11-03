import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { PaintkitEntry } from '../data/types';
import { WORKSHOP_ENABLED } from '../device';
import type { useCustomDefinitions } from '../hooks/useCustomDefinitions';
import type { useStockDefinitions } from '../hooks/useStockDefinitions';
import { customKitDefindex, isCustomKitId } from '../protodefs/types';
import type { ProtoDefKitWeaponSlot, ProtoDefRecipeWithProvenance } from '../protodefs/types';
import type { SourceTextureProvider } from '../source/provider';
import { downloadBlob } from '../ui/common/download';
import { shortcutTargetsEditableContent } from '../ui/common/shortcuts';
import type { ControlsState } from '../viewer/controls';
import { CUSTOM_LIGHTING_ID } from '../viewer/lighting/customLightingModel';
import type { WorkbenchTab } from '../workbench/types';
import type { EditorDownloadFormat } from './export/definitionExport';
import { provenanceRecipeKey, provenanceStatus } from './provenanceStatus';
import { useEditorDraft } from './useEditorDraft';
import { useProtoDefEditorSession } from './useProtoDefEditorSession';

function downloadText(text: string, fileName: string): void {
  downloadBlob(new Blob([text], { type: 'application/json' }), fileName);
}

/** The selected kit must still be in the catalog; a selected id can outlive a removed or unloaded kit. */
function resolveEditableKitId(
  selectedKitId: number | null,
  requestedKitId: number | null,
  selectedKit: PaintkitEntry | null,
): number | null {
  return selectedKit && selectedKitId === requestedKitId ? selectedKitId : null;
}

const NO_WEAPON_SLOTS: ProtoDefKitWeaponSlot[] = [];

/** A burst of edits or a drag builds one preview, once it has paused this long. */
const PREVIEW_DEBOUNCE_MS = 120;

/** Runs one task at a time; a task submitted while one is in flight replaces any waiting task. */
export function createLatestOnlyQueue(): (task: () => Promise<void>) => void {
  let busy = false;
  let waiting: (() => Promise<void>) | null = null;
  const drain = (): void => {
    const task = waiting;
    if (busy || !task) return;
    waiting = null;
    busy = true;
    void task().finally(() => {
      busy = false;
      drain();
    });
  };
  return (task) => {
    waiting = task;
    drain();
  };
}

interface UseEditorCoreOptions {
  selectedKitId: number | null;
  workbenchOpen: boolean;
  workbenchTab: WorkbenchTab;
  definitions: ReturnType<typeof useCustomDefinitions>;
  stockDefinitions: ReturnType<typeof useStockDefinitions>;
  selectedKit: PaintkitEntry | null;
  sourceProvider: SourceTextureProvider;
  state: ControlsState;
}

/**
 * The editor session for the selected paint: provenance recipe, draft persistence, preview and package export.
 */
export function useEditorCore({
  selectedKitId,
  workbenchOpen,
  workbenchTab,
  definitions,
  stockDefinitions,
  selectedKit,
  sourceProvider,
  state,
}: UseEditorCoreOptions) {
  const {
    editGeneration: stockEditGeneration,
    exportKitBundle: exportStockKitBundle,
    exportKitWeaponSlots: exportStockKitWeaponSlots,
    getRecipeWithProvenance: getStockRecipeWithProvenance,
    previewKitBundle: previewStockKitBundle,
    clearPreviewKit: clearStockPreviewKit,
  } = stockDefinitions;
  const {
    exportKitBundle: exportImportedKitBundle,
    exportKitWeaponSlots: exportImportedKitWeaponSlots,
    getRecipeWithProvenance: getImportedRecipeWithProvenance,
    previewKitBundle: previewImportedKitBundle,
    clearPreviewKit: clearImportedPreviewKit,
  } = definitions;

  const [editorRequestedKitId, setEditorRequestedKitId] = useState<number | null>(null);
  // Without a requested kit the session, draft, recipe and preview work below all stay idle.
  const editorTabOpen = WORKSHOP_ENABLED && workbenchOpen && workbenchTab === 'editor';

  useEffect(() => {
    if (!editorTabOpen) return;
    void Promise.all([
      import('./export/packageExport'),
      import('./export/definitionExport'),
    ]).catch(() => undefined);
  }, [editorTabOpen]);

  if (editorTabOpen && selectedKitId !== null && editorRequestedKitId !== selectedKitId) {
    setEditorRequestedKitId(selectedKitId);
  }
  const editableKitId = resolveEditableKitId(selectedKitId, editorRequestedKitId, selectedKit);
  const loadEditorKit = useCallback((kitId: number) => (
    isCustomKitId(kitId) ? exportImportedKitBundle(kitId) : exportStockKitBundle(kitId)
  ), [exportImportedKitBundle, exportStockKitBundle]);
  const loadEditorKitWeaponSlots = useCallback((kitId: number) => (
    isCustomKitId(kitId) ? exportImportedKitWeaponSlots(kitId) : exportStockKitWeaponSlots(kitId)
  ), [exportImportedKitWeaponSlots, exportStockKitWeaponSlots]);
  // The viewer's weapon and wear choose which operation a per-wear paint edits.
  const editorSession = useProtoDefEditorSession({
    kitId: editableKitId,
    loadKit: loadEditorKit,
    scope: { weaponKey: state.weaponKey, wear: state.wearIndex },
  });
  const {
    kitId: editorSessionKitId,
    status: editorStatus,
    original: editorOriginal,
    current: editorCurrent,
    bundle: editorBundle,
    originalBundle: editorOriginalBundle,
    dirty: editorDirty,
    canUndo: editorCanUndo,
    canRedo: editorCanRedo,
    error: editorSessionError,
    assignSelectGroups: assignSessionGroups,
    clearSelectGroups: clearSessionGroups,
    setGroupTexture: setSessionGroupTexture,
    setStickerDestQuad: setSessionStickerQuad,
    addSticker: addSessionSticker,
    removeSticker: removeSessionSticker,
    moveSticker: moveSessionSticker,
    setStickerBase: setSessionStickerBase,
    setStickerVariantWeight: setSessionStickerVariantWeight,
    addStickerVariant: addSessionStickerVariant,
    removeStickerVariant: removeSessionStickerVariant,
    setStickerVariantBase: setSessionStickerVariantBase,
    equalizeStickerVariantWeights: equalizeSessionStickerVariantWeights,
    setLayerTeamColors: setSessionLayerTeamColors,
    setLayerTeamTexture: setSessionLayerTeamTexture,
    beginTransformGesture: beginSessionTransformGesture,
    endTransformGesture: endSessionTransformGesture,
    setTransformRange: setSessionTransformRange,
    pushTransformRangeToAll: pushSessionTransformRangeToAll,
    setTransformFlip: setSessionTransformFlip,
    setWeaponMaterial: setSessionWeaponMaterial,
    setWeaponMaterials: setSessionWeaponMaterials,
    undo: undoEditor,
    redo: redoEditor,
    reset: resetEditor,
    restoreDraft: restoreEditorDraft,
    reload: reloadEditor,
    serialize: serializeEditor,
    replaceOperationGraph,
    setDefinitionVariable,
    revision: editorRevision,
    activeScope: editorActiveScope,
  } = editorSession;
  // Weapon slots come from the decoded source, not the session, so resolve them whenever the editable kit changes.
  const [loadedWeaponSlots, setLoadedWeaponSlots] = useState<{
    readonly kitId: number;
    readonly slots: ProtoDefKitWeaponSlot[];
  } | null>(null);
  const weaponSlots = loadedWeaponSlots !== null && loadedWeaponSlots.kitId === editableKitId
    ? loadedWeaponSlots.slots
    : NO_WEAPON_SLOTS;
  useEffect(() => {
    if (editableKitId === null) return;
    let cancelled = false;
    void loadEditorKitWeaponSlots(editableKitId).then((slots) => {
      if (!cancelled) setLoadedWeaponSlots({ kitId: editableKitId, slots: slots ?? [] });
    });
    return () => { cancelled = true; };
  }, [editableKitId, loadEditorKitWeaponSlots]);
  const [editorPreviewError, setEditorPreviewError] = useState<string | null>(null);
  const [editorPackageExportError, setEditorPackageExportError] = useState<string | null>(null);
  const [editorPackageExporting, setEditorPackageExporting] = useState(false);
  const [editorPreviewPending, setEditorPreviewPending] = useState(false);
  const [editorTool, setEditorTool] = useState<'paint' | 'sticker'>('paint');
  // Parts/Transform/Graph sub-view of paint mode, kept beside editorTool since it only matters in paint mode.
  const [paintSubView, setPaintSubView] = useState<'parts' | 'transform' | 'graph'>('parts');
  // Imported kits key provenance by source generation, so a re-import cannot reuse the replaced definitions.
  const currentProvenanceRecipeKey = editableKitId !== null && state.weaponKey
    ? provenanceRecipeKey({
      kitId: editableKitId,
      sourceGeneration: isCustomKitId(editableKitId) ? definitions.generation : 'stock',
      weaponKey: state.weaponKey,
      team: state.team,
      wearIndex: state.wearIndex,
    })
    : '';
  const [loadedProvenanceRecipe, setLoadedProvenanceRecipe] = useState<{
    readonly key: string;
    readonly recipe: ProtoDefRecipeWithProvenance | null;
  } | null>(null);
  const provenanceStatusNow = provenanceStatus(loadedProvenanceRecipe, currentProvenanceRecipeKey);
  const provenanceRecipe = loadedProvenanceRecipe?.key === currentProvenanceRecipeKey
    ? loadedProvenanceRecipe.recipe
    : null;
  if (!currentProvenanceRecipeKey && loadedProvenanceRecipe) setLoadedProvenanceRecipe(null);
  const editorSourceGenerationRef = useRef(definitions.generation);

  // Retry once a restored imported paint's source hydrates, but never discard a draft being edited.
  useEffect(() => {
    if (editorSourceGenerationRef.current === definitions.generation) return;
    if (editableKitId === null) {
      editorSourceGenerationRef.current = definitions.generation;
      return;
    }
    if (editorDirty) return;
    editorSourceGenerationRef.current = definitions.generation;
    void reloadEditor();
  }, [definitions.generation, editableKitId, editorDirty, reloadEditor]);

  const editorDraftKey = editableKitId === null
    ? null
    : isCustomKitId(editableKitId)
      ? `custom:${customKitDefindex(editableKitId)}:${definitions.state.fileName ?? 'definitions'}`
      : `stock:${editableKitId}`;
  const editorDraft = useEditorDraft({
    key: editorStatus === 'ready' ? editorDraftKey : null,
    kitId: editorStatus === 'ready' ? editableKitId : null,
    paintName: selectedKit?.name,
    revision: editorRevision,
    original: editorStatus === 'ready' ? editorOriginalBundle : null,
    current: editorStatus === 'ready' ? editorBundle : null,
    dirty: editorDirty,
    restore: restoreEditorDraft,
  });
  const editorDefinitionGeneration = selectedKit && !isCustomKitId(selectedKit.id)
    ? stockEditGeneration
    : definitions.editGeneration;

  useEffect(() => {
    if (editableKitId === null || !selectedKit || !state.weaponKey) return;
    let cancelled = false;
    const resolver = isCustomKitId(editableKitId)
      ? getImportedRecipeWithProvenance
      : getStockRecipeWithProvenance;
    void resolver(editableKitId, state.weaponKey, state.team, state.wearIndex).then((resolved) => {
      if (!cancelled) setLoadedProvenanceRecipe({ key: currentProvenanceRecipeKey, recipe: resolved });
    });
    return () => { cancelled = true; };
  }, [
    definitions,
    definitions.editGeneration,
    stockEditGeneration,
    getImportedRecipeWithProvenance,
    getStockRecipeWithProvenance,
    editableKitId,
    editorCurrent,
    selectedKit,
    currentProvenanceRecipeKey,
    state.team,
    state.weaponKey,
    state.wearIndex,
  ]);

  const [submitPreviewBuild] = useState(() => createLatestOnlyQueue());
  // Keyed on the whole bundle so weapon or wear switches do not rebuild the preview. Each change restarts the debounce.
  useEffect(() => {
    if (editorStatus !== 'ready' || !editorBundle || editableKitId === null) return;
    let current = true;
    // Pending must cover the debounce of this external preview build, so it starts with the effect that schedules it.
    // oxlint-disable-next-line react/set-state-in-effect
    setEditorPreviewPending(true);
    setEditorPreviewError(null);
    const preview = isCustomKitId(editableKitId)
      ? previewImportedKitBundle
      : previewStockKitBundle;
    const timer = window.setTimeout(() => {
      submitPreviewBuild(async () => {
        // A newer bundle, a kit switch or unmount ends this request; the newer one builds instead.
        if (!current) return;
        try {
          await preview(editableKitId, editorBundle);
          if (current) setEditorPreviewPending(false);
        } catch (cause) {
          console.warn('[warpaint-viewer] editor preview could not be updated:', cause);
          if (current) {
            setEditorPreviewError('The preview could not be updated.');
            setEditorPreviewPending(false);
          }
        }
      });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [
    editableKitId,
    editorBundle,
    editorStatus,
    previewImportedKitBundle,
    previewStockKitBundle,
    submitPreviewBuild,
  ]);

  useEffect(() => {
    // Selection changes release the isolated preview source; the imported container stays the baseline.
    return () => {
      clearImportedPreviewKit();
      clearStockPreviewKit();
    };
  }, [clearImportedPreviewKit, clearStockPreviewKit, editableKitId]);

  const downloadEditorPackage = useCallback((format: EditorDownloadFormat) => {
    // The whole bundle, not the active operation: a per-wear paint needs every operation and item definition.
    if (!editorBundle || editorPackageExporting || editableKitId === null) return;
    setEditorPackageExportError(null);
    setEditorPackageExporting(true);
    const pending = format === 'zip'
      ? import('./export/packageExport').then(({ exportEditedPackage }) => exportEditedPackage(editorBundle, {
          package: sourceProvider.package,
          name: selectedKit?.name,
        }))
      : import('./export/definitionExport').then(({ exportEditorDefinition }) => exportEditorDefinition(
          editorBundle,
          format,
          isCustomKitId(editableKitId) ? customKitDefindex(editableKitId) : editableKitId,
          selectedKit?.name,
          !isCustomKitId(editableKitId),
        ));
    void pending.then((result) => {
      downloadBlob(result.blob, result.fileName);
    }).catch((cause) => {
      setEditorPackageExportError(cause instanceof Error ? cause.message : 'The edited package could not be exported.');
    }).finally(() => setEditorPackageExporting(false));
  }, [editableKitId, editorBundle, editorPackageExporting, selectedKit?.name, sourceProvider]);

  const downloadEditorRecovery = useCallback(() => {
    const serialized = serializeEditor({ name: selectedKit?.name });
    if (!serialized) return;
    for (const fragment of serialized.fragments) downloadText(fragment.text, fragment.name);
  }, [selectedKit?.name, serializeEditor]);

  return {
    editableKitId,
    editorSessionKitId,
    editorStatus,
    editorOriginal,
    editorCurrent,
    editorActiveScope,
    editorDirty,
    editorCanUndo,
    editorCanRedo,
    editorSessionError,
    assignSessionGroups,
    clearSessionGroups,
    setSessionGroupTexture,
    setSessionStickerQuad,
    addSessionSticker,
    removeSessionSticker,
    moveSessionSticker,
    setSessionStickerBase,
    setSessionStickerVariantWeight,
    addSessionStickerVariant,
    removeSessionStickerVariant,
    setSessionStickerVariantBase,
    equalizeSessionStickerVariantWeights,
    setSessionLayerTeamColors,
    setSessionLayerTeamTexture,
    beginSessionTransformGesture,
    endSessionTransformGesture,
    setSessionTransformRange,
    pushSessionTransformRangeToAll,
    setSessionTransformFlip,
    setSessionWeaponMaterial,
    setSessionWeaponMaterials,
    undoEditor,
    redoEditor,
    resetEditor,
    replaceOperationGraph,
    setDefinitionVariable,
    editorRevision,
    weaponSlots,
    editorTool,
    setEditorTool,
    paintSubView,
    setPaintSubView,
    provenanceRecipe,
    provenanceStatus: provenanceStatusNow,
    editorDraftKey,
    editorDraft,
    editorDefinitionGeneration,
    editorPreviewPending,
    editorPreviewError,
    editorPackageExporting,
    editorPackageExportError,
    downloadEditorPackage,
    downloadEditorRecovery,
  };
}

export type EditorCore = ReturnType<typeof useEditorCore>;

interface UseEditorHistoryShortcutsOptions {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  draftRecovery: ReturnType<typeof useEditorDraft>['recovery'];
  saveDraft: ReturnType<typeof useEditorDraft>['save'];
  cameraMode: 'inspect' | 'advanced';
  lightingPanelOpen: boolean;
  preset: ControlsState['preset'];
  editorTabActive: boolean;
}

/** Ctrl+S saves the draft and Ctrl+Z / Ctrl+Y walk the edit history while the Edit tab is open. */
export function useEditorHistoryShortcuts({
  undo,
  redo,
  canUndo,
  canRedo,
  dirty: editorDirty,
  draftRecovery: editorDraftRecovery,
  saveDraft: saveEditorDraft,
  cameraMode,
  lightingPanelOpen,
  preset,
  editorTabActive,
}: UseEditorHistoryShortcutsOptions) {
  // One listener for the editor tab, reading current actions from a ref instead of re-subscribing per render.
  const editorHistoryActionsRef = useRef({ undo, redo, canUndo, canRedo });
  useLayoutEffect(() => {
    editorHistoryActionsRef.current = { undo, redo, canUndo, canRedo };
  });

  useEffect(() => {
    if (!editorTabActive || cameraMode === 'advanced' || (lightingPanelOpen && preset === CUSTOM_LIGHTING_ID)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !(event.ctrlKey || event.metaKey)) return;
      // A modal owns its keyboard loop; do not edit behind it, even when focus lands on the dialog.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === 's' && !event.altKey && !event.shiftKey && editorDirty && !editorDraftRecovery) {
        event.preventDefault();
        saveEditorDraft();
        return;
      }
      if (shortcutTargetsEditableContent(event.target)) return;
      const actions = editorHistoryActionsRef.current;
      if (key === 'z' && !event.shiftKey && actions.canUndo) {
        event.preventDefault();
        actions.undo();
      } else if ((key === 'y' || (key === 'z' && event.shiftKey)) && actions.canRedo) {
        event.preventDefault();
        actions.redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cameraMode, editorDirty, editorDraftRecovery, editorTabActive, lightingPanelOpen, saveEditorDraft, preset]);
}
