import { useEditorCore, useEditorHistoryShortcuts } from './useEditorCore';
import { useEditorLayers } from './layers/useEditorLayers';
import { usePartsEditor } from './layers/usePartsEditor';
import { useStickerEditor } from './sticker/useStickerEditor';
import { useTransformEditor } from './transform/useTransformEditor';

// Hook order is fixed: each later hook reads the state the earlier ones return.
type LayersOptions = Parameters<typeof useEditorLayers>[0];
type PartsOptions = Parameters<typeof usePartsEditor>[0];
type TransformOptions = Parameters<typeof useTransformEditor>[0];
type StickerOptions = Parameters<typeof useStickerEditor>[0];
type HistoryOptions = Parameters<typeof useEditorHistoryShortcuts>[0];

type EditorToolsOptions = {
  editor: ReturnType<typeof useEditorCore>;
  state: PartsOptions['state'];
  workbenchOpen: PartsOptions['workbenchOpen'];
  workbenchTab: PartsOptions['workbenchTab'];
  editorTabActive: PartsOptions['editorTabActive'];
  definitions: PartsOptions['definitions'];
  data: PartsOptions['data'];
  engineReady: PartsOptions['engineReady'];
  viewerRef: PartsOptions['viewerRef'];
  compositorRef: TransformOptions['compositorRef'];
  contextRestores: TransformOptions['contextRestores'];
  sourceProvider: PartsOptions['sourceProvider'];
  packageGeneration: PartsOptions['packageGeneration'];
  assetOverrides: PartsOptions['assetOverrides'];
  activeTextureOverrides: PartsOptions['activeTextureOverrides'];
  manualTextureOverrides: StickerOptions['manualTextureOverrides'];
  packageStickerSpecularOverrides: StickerOptions['packageStickerSpecularOverrides'];
  mountedSourcePackage: StickerOptions['mountedSourcePackage'];
  selectedAssetKey: StickerOptions['selectedAssetKey'];
  weaponName: TransformOptions['weaponName'];
  editorRecipes: LayersOptions['editorRecipes'];
  stockEditGeneration: TransformOptions['stockEditGeneration'];
  getImportedRecipeWithProvenance: TransformOptions['getImportedRecipeWithProvenance'];
  getStockRecipeWithProvenance: TransformOptions['getStockRecipeWithProvenance'];
  resetComposeKey: TransformOptions['resetComposeKey'];
  setHintDismissed: StickerOptions['setHintDismissed'];
  cameraMode: HistoryOptions['cameraMode'];
  lightingPanelOpen: HistoryOptions['lightingPanelOpen'];
};

export function useEditorTools({
  editor,
  state,
  workbenchOpen,
  workbenchTab,
  editorTabActive,
  definitions,
  data,
  engineReady,
  viewerRef,
  compositorRef,
  contextRestores,
  sourceProvider,
  packageGeneration,
  assetOverrides,
  activeTextureOverrides,
  manualTextureOverrides,
  packageStickerSpecularOverrides,
  mountedSourcePackage,
  selectedAssetKey,
  weaponName,
  editorRecipes,
  stockEditGeneration,
  getImportedRecipeWithProvenance,
  getStockRecipeWithProvenance,
  resetComposeKey,
  setHintDismissed,
  cameraMode,
  lightingPanelOpen,
}: EditorToolsOptions) {
  const {
    editableKitId,
    editorStatus,
    editorOriginal,
    editorCurrent,
    editorDirty,
    editorCanUndo,
    editorCanRedo,
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
    undoEditor,
    redoEditor,
    resetEditor,
    weaponSlots,
    editorTool,
    setEditorTool,
    paintSubView,
    editorActiveScope,
    provenanceRecipe,
    provenanceStatus,
    editorDraft,
    editorDefinitionGeneration,
  } = editor;
  const layers = useEditorLayers({
    editableKitId,
    editorCurrent,
    provenanceRecipe,
    editorRecipes,
    state,
  });
  const {
    activeEditorSelector,
    setActiveEditorSelector,
    weaponBaseLayerActive,
    setWeaponBaseLayerActive,
    groupDiscovery,
    transformDiscovery,
    baseTextureTransform,
    editableGroupTargets,
    editorSelectors,
    activeGroupTarget,
    activeGroupVisualIndex,
    recipeLayerNodes,
    baseRecipeLayerNode,
    baseLayerTextureRef,
    activeResolvedGroupSelect,
    activeGroupRef,
    groupAssignmentTargets,
    activeGroupAssignmentTarget,
    activeGroupEditTarget,
    activeEditorLayerIndex,
  } = layers;
  const parts = usePartsEditor({
    workbenchOpen,
    workbenchTab,
    editorTabActive,
    state,
    definitions,
    data,
    engineReady,
    viewerRef,
    sourceProvider,
    packageGeneration,
    assetOverrides,
    activeTextureOverrides,
    editableKitId,
    editorStatus,
    editorTool,
    paintSubView,
    provenanceRecipe,
    weaponSlots,
    assignSessionGroups,
    clearSessionGroups,
    setSessionGroupTexture,
    editorActiveScope,
    activeEditorSelector,
    setActiveEditorSelector,
    weaponBaseLayerActive,
    setWeaponBaseLayerActive,
    groupDiscovery,
    baseTextureTransform,
    baseLayerTextureRef,
    editableGroupTargets,
    editorSelectors,
    activeGroupTarget,
    activeResolvedGroupSelect,
    activeGroupRef,
    groupAssignmentTargets,
    activeGroupAssignmentTarget,
    activeGroupEditTarget,
    activeEditorLayerIndex,
  });
  const { groupImage, activeSelectedGroupBuckets } = parts;
  const transform = useTransformEditor({
    editableKitId,
    editorStatus,
    editorCurrent,
    editorOriginal,
    editorDefinitionGeneration,
    provenanceRecipe,
    provenanceStatus,
    weaponSlots,
    paintSubView,
    beginSessionTransformGesture,
    endSessionTransformGesture,
    setSessionTransformRange,
    pushSessionTransformRangeToAll,
    setSessionTransformFlip,
    setSessionLayerTeamColors,
    setSessionLayerTeamTexture,
    activeEditorLayerIndex,
    activeGroupVisualIndex,
    activeGroupTarget,
    weaponBaseLayerActive,
    baseTextureTransform,
    transformDiscovery,
    editableGroupTargets,
    groupDiscovery,
    recipeLayerNodes,
    baseRecipeLayerNode,
    editorSelectors,
    groupImage,
    activeSelectedGroupBuckets,
    state,
    weaponName,
    data,
    engineReady,
    contextRestores,
    editorTabActive,
    viewerRef,
    compositorRef,
    activeTextureOverrides,
    definitions,
    stockEditGeneration,
    getImportedRecipeWithProvenance,
    getStockRecipeWithProvenance,
    resetComposeKey,
  });
  const { resolvedPreviewRecipe } = transform;
  const sticker = useStickerEditor({
    editableKitId,
    editorCurrent,
    editorTool,
    setEditorTool,
    provenanceRecipe,
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
    undoEditor,
    redoEditor,
    resetEditor,
    resolvedPreviewRecipe,
    state,
    data,
    engineReady,
    contextRestores,
    editorTabActive,
    viewerRef,
    compositorRef,
    selectedAssetKey,
    sourceProvider,
    packageGeneration,
    activeTextureOverrides,
    manualTextureOverrides,
    packageStickerSpecularOverrides,
    mountedSourcePackage,
    setHintDismissed,
  });
  const { undoEditorSynced, redoEditorSynced } = sticker;
  const { recovery: editorDraftRecovery, save: saveEditorDraft } = editorDraft;
  useEditorHistoryShortcuts({
    undo: undoEditorSynced,
    redo: redoEditorSynced,
    canUndo: editorCanUndo,
    canRedo: editorCanRedo,
    dirty: editorDirty,
    draftRecovery: editorDraftRecovery,
    saveDraft: saveEditorDraft,
    cameraMode,
    lightingPanelOpen,
    preset: state.preset,
    editorTabActive,
  });
  return { layers, parts, transform, sticker };
}
