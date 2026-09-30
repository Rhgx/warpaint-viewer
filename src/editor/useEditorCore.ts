import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaintkitEntry } from '../data/types';
import type { useCustomDefinitions } from '../hooks/useCustomDefinitions';
import type { useStockDefinitions } from '../hooks/useStockDefinitions';
import { customKitDefindex, isCustomKitId } from '../protodefs/types';
import type { ProtoDefKitWeaponSlot, ProtoDefRecipeWithProvenance } from '../protodefs/types';
import type { SourceTextureProvider } from '../source/provider';
import { downloadBlob } from '../ui/common/download';
import { shortcutTargetsEditableContent } from '../ui/common/shortcuts';
import type { ControlsState } from '../viewer/controls';
import { CUSTOM_LIGHTING_ID } from '../viewer/customLighting';
import type { WorkbenchTab } from '../workbench/types';
import type { EditorDownloadFormat } from './definitionExport';
import { useEditorDraft } from './useEditorDraft';
import { useProtoDefEditorSession } from './useProtoDefEditorSession';

function downloadText(text: string, fileName: string): void {
  downloadBlob(new Blob([text], { type: 'application/json' }), fileName);
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
 * The editor session for the selected paint and everything that hangs directly
 * off it: the provenance recipe, draft persistence, preview messages, and
 * package export. Layer, parts, transform, sticker and graph editing build on
 * what this returns.
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
    exportKit: exportStockKit,
    exportKitWeaponSlots: exportStockKitWeaponSlots,
    getRecipeWithProvenance: getStockRecipeWithProvenance,
    previewKitMessages: previewStockKitMessages,
    clearPreviewKit: clearStockPreviewKit,
  } = stockDefinitions;
  const {
    exportKit: exportImportedKit,
    exportKitWeaponSlots: exportImportedKitWeaponSlots,
    getRecipeWithProvenance: getImportedRecipeWithProvenance,
    previewKitMessages: previewImportedKitMessages,
    clearPreviewKit: clearImportedPreviewKit,
  } = definitions;

  const [editorRequestedKitId, setEditorRequestedKitId] = useState<number | null>(null);

  useEffect(() => {
    if (!workbenchOpen || workbenchTab !== 'editor') return;
    void Promise.all([
      import('./packageExport'),
      import('./definitionExport'),
    ]).catch(() => undefined);
  }, [workbenchOpen, workbenchTab]);

  useEffect(() => {
    if (workbenchOpen && workbenchTab === 'editor' && selectedKitId !== null) {
      setEditorRequestedKitId(selectedKitId);
    }
  }, [selectedKitId, workbenchOpen, workbenchTab]);
  const editableKitId = selectedKitId === editorRequestedKitId ? selectedKitId : null;
  const loadEditorKit = useCallback((kitId: number) => (
    isCustomKitId(kitId) ? exportImportedKit(kitId) : exportStockKit(kitId)
  ), [exportImportedKit, exportStockKit]);
  const loadEditorKitWeaponSlots = useCallback((kitId: number) => (
    isCustomKitId(kitId) ? exportImportedKitWeaponSlots(kitId) : exportStockKitWeaponSlots(kitId)
  ), [exportImportedKitWeaponSlots, exportStockKitWeaponSlots]);
  const editorSession = useProtoDefEditorSession({ kitId: editableKitId, loadKit: loadEditorKit });
  const {
    kitId: editorSessionKitId,
    status: editorStatus,
    original: editorOriginal,
    current: editorCurrent,
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
    getCurrentMessages: getEditorMessages,
    replaceOperationGraph,
    setDefinitionVariable,
    revision: editorRevision,
  } = editorSession;
  // The definition/operation messages the editor session holds carry no
  // items_game defindex table, so the weapon each authored slot paints (and
  // where that slot lives) is resolved separately, off the decoded source,
  // whenever the editable kit changes. See src/editor/materialTargets.ts.
  const [weaponSlots, setWeaponSlots] = useState<ProtoDefKitWeaponSlot[]>([]);
  useEffect(() => {
    if (editableKitId === null) {
      setWeaponSlots([]);
      return;
    }
    let cancelled = false;
    void loadEditorKitWeaponSlots(editableKitId).then((slots) => {
      if (!cancelled) setWeaponSlots(slots ?? []);
    });
    return () => { cancelled = true; };
  }, [editableKitId, loadEditorKitWeaponSlots]);
  const [editorPreviewError, setEditorPreviewError] = useState<string | null>(null);
  const [editorPackageExportError, setEditorPackageExportError] = useState<string | null>(null);
  const [editorPackageExporting, setEditorPackageExporting] = useState(false);
  const [editorPreviewPending, setEditorPreviewPending] = useState(false);
  const [editorTool, setEditorTool] = useState<'paint' | 'sticker'>('paint');
  // Parts/Transform sub-view of paint mode. Lives beside editorTool rather
  // than nested under it, since it only matters while editorTool === 'paint'.
  const [paintSubView, setPaintSubView] = useState<'parts' | 'transform' | 'graph'>('parts');
  const provenanceRecipeKey = editableKitId !== null && state.weaponKey
    ? `${editableKitId}|${state.weaponKey}|${state.team}|${state.wearIndex}`
    : '';
  const [loadedProvenanceRecipe, setLoadedProvenanceRecipe] = useState<{
    readonly key: string;
    readonly recipe: ProtoDefRecipeWithProvenance | null;
  } | null>(null);
  const provenanceRecipe = loadedProvenanceRecipe?.key === provenanceRecipeKey
    ? loadedProvenanceRecipe.recipe
    : null;
  const editorSourceGenerationRef = useRef(definitions.generation);

  // A selected imported paint can be restored before its definition source
  // finishes hydrating. Retry once that source arrives, but never discard a
  // draft if the user is already editing it.
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
    original: editorStatus === 'ready' ? editorOriginal : null,
    current: editorStatus === 'ready' ? editorCurrent : null,
    dirty: editorDirty,
    restore: restoreEditorDraft,
  });
  const editorDefinitionGeneration = selectedKit && !isCustomKitId(selectedKit.id)
    ? stockEditGeneration
    : definitions.editGeneration;

  useEffect(() => {
    if (editableKitId === null || !selectedKit || !state.weaponKey) {
      setLoadedProvenanceRecipe(null);
      return;
    }
    let cancelled = false;
    const resolver = isCustomKitId(editableKitId)
      ? getImportedRecipeWithProvenance
      : getStockRecipeWithProvenance;
    void resolver(editableKitId, state.weaponKey, state.team, state.wearIndex).then((resolved) => {
      if (!cancelled) setLoadedProvenanceRecipe({ key: provenanceRecipeKey, recipe: resolved });
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
    provenanceRecipeKey,
    state.team,
    state.weaponKey,
    state.wearIndex,
  ]);

  useEffect(() => {
    if (editorStatus !== 'ready' || !editorCurrent || editableKitId === null) return;
    let cancelled = false;
    setEditorPreviewPending(true);
    setEditorPreviewError(null);
    const preview = isCustomKitId(editableKitId)
      ? previewImportedKitMessages
      : previewStockKitMessages;
    void preview(editableKitId, editorCurrent)
      .catch((cause) => {
        console.warn('[warpaint-viewer] editor preview could not be updated:', cause);
        if (!cancelled) setEditorPreviewError('The preview could not be updated.');
      })
      .finally(() => {
        if (!cancelled) setEditorPreviewPending(false);
      });
    return () => { cancelled = true; };
  }, [editableKitId, editorCurrent, editorStatus, previewImportedKitMessages, previewStockKitMessages]);

  useEffect(() => {
    // Selection changes must release the isolated draft source; the imported
    // container remains the stable baseline for the next edit session.
    return () => {
      clearImportedPreviewKit();
      clearStockPreviewKit();
    };
  }, [clearImportedPreviewKit, clearStockPreviewKit, editableKitId]);

  const downloadEditorPackage = useCallback((format: EditorDownloadFormat) => {
    const messages = getEditorMessages();
    if (!messages || editorPackageExporting || editableKitId === null) return;
    setEditorPackageExportError(null);
    setEditorPackageExporting(true);
    const pending = format === 'zip'
      ? import('./packageExport').then(({ exportEditedPackage }) => exportEditedPackage(messages, {
          package: sourceProvider.package,
          name: selectedKit?.name,
        }))
      : import('./definitionExport').then(({ exportEditorDefinition }) => exportEditorDefinition(
          messages,
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
  }, [editableKitId, editorPackageExporting, getEditorMessages, selectedKit?.name, sourceProvider]);

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
  // Keep one global listener for the editor tab while reading current actions
  // from a ref, rather than replacing it after every history-state render.
  const editorHistoryActionsRef = useRef({ undo, redo, canUndo, canRedo });
  editorHistoryActionsRef.current = { undo, redo, canUndo, canRedo };

  useEffect(() => {
    if (!editorTabActive || cameraMode === 'advanced' || (lightingPanelOpen && preset === CUSTOM_LIGHTING_ID)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || !(event.ctrlKey || event.metaKey)) return;
      // A modal owns its own keyboard loop and must not trigger editing behind
      // it, even when focus momentarily lands on its dialog container.
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
