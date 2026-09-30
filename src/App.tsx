import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import './ui/catalog/WarpaintList.css';
import './ui/stage/StageToolbar.css';
import './ui/stage/Inspector.css';
import './styles/stage.css';
import './styles/layout.css';
import type { Viewer } from './viewer/Viewer';
import { isStockMaterialCubemap } from './viewer/env';
import type { Compositor } from './compositor/compositor';
import type { PaintkitEntry } from './data/types';
import { WarpaintList } from './ui/catalog/WarpaintList';
import { Inspector } from './ui/stage/Inspector';
import type { ControlsState } from './viewer/controls';
import { CanvasHint } from './ui/stage/CanvasHint';
import { StageOverlay } from './ui/stage/StageOverlay';
import { MobileTabStrip } from './ui/stage/MobileTabStrip';
import type { MobilePanel } from './ui/stage/MobileTabStrip';
import { StageToolbar } from './ui/stage/StageToolbar';
import { SupportLink } from './ui/stage/SupportLink';
import { FirstPersonControls } from './ui/stage/FirstPersonControls';
import { LightingPanel } from './ui/lighting/LightingPanel';
import { PanelEdgeToggle } from './ui/common/PanelEdgeToggle';
import { DefinitionsPrompt } from './ui/workbench/DefinitionsPrompt';
import type { WarpaintAssetOverrides, WorkbenchTab } from './workbench/types';
import { revokeAssetOverrideCache } from './workbench/assetUrls';
import { BootLoader } from './ui/boot/BootLoader';
import { DEFAULT_VIEWER_FOV } from './viewer/presets';
import { CUSTOM_LIGHTING_ID } from './viewer/lighting/customLighting';
import { useBootData, randomSeed } from './hooks/useBootData';
import { useComposedPaint, useComposeCache } from './hooks/useComposedPaint';
import { useLightingRig } from './hooks/useLightingRig';
import { useWorkspace } from './hooks/useWorkspace';
import { useViewerEngine } from './hooks/useViewerEngine';
import { useExportDefinitions, useWorkbenchRecipes } from './hooks/useWorkbenchRecipes';
import { useSeedHistory } from './hooks/useSeedHistory';
import { useTurntableCapture } from './hooks/useTurntableCapture';
import { useSourcePackage } from './hooks/useSourcePackage';
import { useCustomDefinitions } from './hooks/useCustomDefinitions';
import { useStockDefinitions } from './hooks/useStockDefinitions';
import { TURNTABLE_FORMATS, useScreenshotActions } from './hooks/useScreenshotActions';
import { useCustomWarpaintIcons } from './hooks/useCustomWarpaintIcons';
import { indexPackageMaterialPaths } from './source/vmt';
import { isCustomKitId } from './protodefs/types';
import type { CustomDefinitionsState } from './protodefs/types';
import { useEditorCore, useEditorHistoryShortcuts } from './editor/useEditorCore';
import { useEditorLayers } from './editor/layers/useEditorLayers';
import { useMaterialOverridesEditor } from './editor/materials/useMaterialOverridesEditor';
import { useEditorViewport } from './editor/useEditorViewport';
import { useOperationGraphEditor } from './editor/graph/useOperationGraphEditor';
import { usePartsEditor } from './editor/layers/usePartsEditor';
import { useStickerEditor } from './editor/sticker/useStickerEditor';
import { useTransformEditor } from './editor/transform/useTransformEditor';
import { collectPackageStickerSpecularOverrides } from './workbench/assetSlots';
import { ClearWorkspaceDialog } from './ui/common/ClearWorkspaceDialog';
import { AppToasts } from './ui/common/AppToasts';

// Selftest page is code-split: it never loads in normal use.
const SelfTestPage = lazy(() => import('./dev/selftest').then((m) => ({ default: m.SelfTestPage })));
// The custom-file UI includes texture decoders and a large interactive editor.
// It is not needed to view a paint, so mount it only after the drawer opens.
const CustomWarpaintWorkbench = lazy(() => import('./ui/workbench/CustomWarpaintWorkbench').then((m) => ({ default: m.CustomWarpaintWorkbench })));

const EMPTY_OVERRIDES: WarpaintAssetOverrides = { revision: 0, assets: {} };

export default function App() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('selftest') === '1') {
    return (
      <Suspense fallback={<div className="loading">Loading selftest...</div>}>
        <SelfTestPage />
      </Suspense>
    );
  }
  return <MainApp />;
}

function MainApp() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const compositorRef = useRef<Compositor | null>(null);

  const [engineReady, setEngineReady] = useState(false);
  const [firstPersonEnabled, setFirstPersonEnabled] = useState(false);
  const [autoSpin, setAutoSpin] = useState(false);
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchMounted, setWorkbenchMounted] = useState(false);
  const [workbenchExpanded, setWorkbenchExpanded] = useState(false);
  // 0 keeps the CSS default drawer height; anything else is a user drag.
  const [workbenchHeight, setWorkbenchHeight] = useState(0);
  // The drawer is keyed to remount per paint/weapon, so its tab lives out here.
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>('files');
  const [visibleCatalogKitIds, setVisibleCatalogKitIds] = useState<readonly number[]>([]);
  const [assetOverrideCache, setAssetOverrideCache] = useState<Record<string, WarpaintAssetOverrides>>({});
  const [catalogVisible, setCatalogVisible] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [cameraMode, setCameraMode] = useState<'inspect' | 'advanced'>('inspect');
  const [loadedAssetKey, setLoadedAssetKey] = useState('');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');
  const [state, setState] = useState<ControlsState>(() => ({
    weaponKey: '',
    wearIndex: 0,
    team: 'red',
    seed: randomSeed(),
    preset: 'inspect',
    sheen: 'none',
    unusual: 'none',
    fov: DEFAULT_VIEWER_FOV,
    projection: 'perspective',
    captureFormat: 'image',
    screenshotMaxEdge: 1920,
    turntableFormat: 'gif',
    turntableProfiles: {
      gif: TURNTABLE_FORMATS.gif.defaults,
      webp: TURNTABLE_FORMATS.webp.defaults,
      apng: TURNTABLE_FORMATS.apng.defaults,
      mp4: TURNTABLE_FORMATS.mp4.defaults,
    },
    turntableTransparent: true,
    turntableColor: '#1c1f24',
  }));
  const { patch, undoSeed, canUndoSeed, randomizeSeed } = useSeedHistory({ state, setState });
  const { lightingStore, lightingPanelOpen, selectLight, toggleLightingPanel } = useLightingRig({
    presetId: state.preset,
    weaponKey: state.weaponKey,
    engineReady,
    viewerRef,
    setMobilePanel,
  });

  const { data, boot, advanceBoot } = useBootData({ state, setState, selectedKitId, setSelectedKitId, setError });
  const weaponName = data?.manifest.weapons.find((w) => w.key === state.weaponKey)?.name ?? state.weaponKey;

  const reportVisibleCatalogKitIds = useCallback((ids: readonly number[]) => {
    setVisibleCatalogKitIds((current) => (
      current.length === ids.length && current.every((id, index) => id === ids[index])
        ? current
        : [...ids]
    ));
  }, []);

  const clearAssetOverrideCache = useCallback(() => {
    setAssetOverrideCache((cache) => {
      revokeAssetOverrideCache(cache);
      return {};
    });
  }, []);

  const { provider: sourceProvider, sourcePackage, packageGeneration, suggestedPaintkitId, removePackage } = useSourcePackage(
    data?.resolveTexture ?? ((ref) => ref),
    clearAssetOverrideCache,
    (ref) => !!data?.manifest.textures?.[ref] || isStockMaterialCubemap(ref),
  );
  const getAssetUrl = useCallback((rel: string) => data?.getAssetUrl(rel) ?? null, [data]);
  const definitions = useCustomDefinitions({
    manifest: data?.manifest ?? null,
    getAssetUrl,
    provider: sourceProvider,
    packageGeneration,
  });
  const stockDefinitions = useStockDefinitions(data?.manifest ?? null, getAssetUrl);
  const {
    getRecipe: getStockRecipe,
    getRecipeWithProvenance: getStockRecipeWithProvenance,
    editGeneration: stockEditGeneration,
  } = stockDefinitions;
  const {
    exportKit: exportImportedKit,
    getRecipeWithProvenance: getImportedRecipeWithProvenance,
  } = definitions;
  const composeCache = useComposeCache(compositorRef);
  const { resetComposeKey, disposeCache } = composeCache;

  // Definitions imported from a proto_defs file join the catalog under their own
  // collection. Everything downstream reads this merged list, so a custom kit is
  // an ordinary catalog entry apart from where its recipe comes from.
  const paintkits = useMemo<PaintkitEntry[]>(() => {
    if (!data) return [];
    return definitions.catalogKits.length
      ? [...data.manifest.paintkits, ...definitions.catalogKits]
      : data.manifest.paintkits;
  }, [data, definitions.catalogKits]);

  const selectedKit: PaintkitEntry | null =
    selectedKitId != null ? paintkits.find((p) => p.id === selectedKitId) ?? null : null;
  const editor = useEditorCore({
    selectedKitId,
    workbenchOpen,
    workbenchTab,
    definitions,
    stockDefinitions,
    selectedKit,
    sourceProvider,
    state,
  });
  const {
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
  } = editor;
  // Team colors switched on in the editor count as soon as the edit lands, so
  // the RED/BLU toggle and the Files list follow the working definition.
  const kitHasTeamTextures = (selectedKit?.hasTeamTextures ?? false)
    || (editableKitId !== null && editorSessionKitId === editableKitId
      && editorCurrent?.definition.has_team_textures === true);
  // Camera policy follows the Edit tab itself, even while its group map is
  // loading or unavailable. Selection input remains stricter: it only starts
  // once the editor has a usable target and image.
  const editorTabActive = workbenchOpen && workbenchTab === 'editor';
  const firstPersonActive = firstPersonEnabled && !!selectedKit && !!state.weaponKey
    && state.weaponKey !== 'paintkit_tool' && !editorTabActive && !lightingPanelOpen;
  useEffect(() => {
    // Only a switched-off team layer (or leaving First Person, whose arms keep
    // the team meaningful) lands here: picking a paint already clamps the
    // team, and the kit is unknown while the catalog boots.
    if (selectedKit && !kitHasTeamTextures && !firstPersonActive && state.team === 'blu' && state.sheen !== 'team_shine') {
      setState((current) => ({ ...current, team: 'red' }));
    }
  }, [kitHasTeamTextures, firstPersonActive, selectedKit, state.sheen, state.team]);
  const selectedMaterialOverrideId = selectedKit?.materialOverrides?.[state.weaponKey] ?? '';
  const selectedAssetKey = selectedKit && state.weaponKey
    ? `${state.weaponKey}|material:${selectedMaterialOverrideId || 'stock'}|package:${packageGeneration}`
    : '';
  // Artwork refs are shared by a paintkit even when its weapon recipe changes.
  // Keep one edit set per paintkit so imported textures follow weapon changes;
  // recipe-specific refs that do not exist on the next weapon are simply unused.
  const assetOverrideScope = selectedKit ? String(selectedKit.id) : '';
  const assetOverrides = assetOverrideCache[assetOverrideScope] ?? EMPTY_OVERRIDES;

  // One entry point for a recipe, whichever catalog the kit came from.
  const { getRecipe: getImportedRecipe } = definitions;
  const resolveRecipe = useCallback(
    (kit: PaintkitEntry, weaponKey: string, team: ControlsState['team'], wearIndex: number) => (
      isCustomKitId(kit.id)
        ? getImportedRecipe(kit.id, weaponKey, team, wearIndex)
        : editorCurrent && editableKitId === kit.id
          ? getStockRecipe(kit.id, weaponKey, team, wearIndex)
          : data?.getRecipe(kit, weaponKey, team, wearIndex) ?? Promise.resolve(null)
    ),
    [data, editableKitId, editorCurrent, getImportedRecipe, getStockRecipe],
  );

  // An import can point at the kit it is meant for: a numeric ZIP wrapper is a
  // conventional paintkit index, and a proto_defs file nominates its first new
  // definition. Either way, switch only when it resolves to a catalog entry;
  // unknown ids leave the current selection alone.
  const suggestedKitId = definitions.suggestedKitId ?? suggestedPaintkitId;
  // Re-importing is a deliberate act, so the same suggestion from a later
  // import applies again; a merely re-rendered catalog does not re-apply it.
  const suggestionToken = definitions.suggestedKitId !== undefined
    ? `defs:${definitions.generation}:${definitions.suggestedKitId}`
    : `pkg:${packageGeneration}:${suggestedPaintkitId}`;
  const appliedSuggestionRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (suggestedKitId === undefined || suggestionToken === appliedSuggestionRef.current || editorDirty) return;
    const kit = paintkits.find((entry) => entry.id === suggestedKitId);
    if (!kit) return;
    appliedSuggestionRef.current = suggestionToken;
    setSelectedKitId(kit.id);
    setState((current) => ({
      ...current,
      weaponKey: kit.weapons.includes(current.weaponKey) ? current.weaponKey : (kit.weapons[0] ?? current.weaponKey),
      team: kit.hasTeamTextures || current.sheen === 'team_shine' || firstPersonActive ? current.team : 'red',
    }));
  }, [editorDirty, firstPersonActive, paintkits, suggestedKitId, suggestionToken]);
  const { editorLoading, editorRecipes } = useWorkbenchRecipes({
    workbenchMounted,
    workbenchOpen,
    workbenchTab,
    data,
    resolveRecipe,
    selectedKit,
    state,
    editorDefinitionGeneration,
    packageGeneration,
    kitHasTeamTextures,
  });
  const resolvePackageTexture = useCallback((ref: string) => sourceProvider.resolvePreview(ref), [sourceProvider]);
  const manualTextureOverrides = useMemo(
    () => Object.fromEntries(
      Object.entries(assetOverrides.assets).flatMap(([ref, asset]) => asset.output ? [[ref, asset.output]] : []),
    ),
    [assetOverrides],
  );
  const mountedSourcePackage = sourceProvider.package;
  const packageStickerSpecularOverrides = useMemo(
    () => collectPackageStickerSpecularOverrides(
      editorRecipes,
      (ref) => Boolean(sourceProvider.packagePathFor(ref)),
    ),
    // SourceTextureProvider keeps a stable identity while its mounted package
    // changes internally, so generation is the required invalidation token.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [editorRecipes, packageGeneration, sourceProvider],
  );
  const activeTextureOverrides = useMemo(() => ({
    ...packageStickerSpecularOverrides,
    ...manualTextureOverrides,
  }), [manualTextureOverrides, packageStickerSpecularOverrides]);
  const mountedMaterialPaths = useMemo(
    () => mountedSourcePackage ? indexPackageMaterialPaths(mountedSourcePackage) : null,
    [mountedSourcePackage],
  );

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
  const {
    groupImage,
    activeSelectedGroupBuckets,
    groupAssignActive,
    groupPointerRef,
    setEditorSample,
    setPanelPreviewGroup,
    sampleEditorSurface,
    toggleEditorGroup,
  } = parts;
  const transform = useTransformEditor({
    editableKitId,
    editorStatus,
    editorCurrent,
    editorOriginal,
    editorDefinitionGeneration,
    provenanceRecipe,
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
  const {
    transformDraft,
    transformPreviewRecipe,
    handleVisiblePaintResult,
    resolvedPreviewRecipe,
    layerHasTransformEdits,
    layerTransformLocked,
  } = transform;
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
    undoEditor,
    redoEditor,
    resetEditor,
    resolvedPreviewRecipe,
    state,
    data,
    engineReady,
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
  const {
    stickerTransformTool,
    stickerTargets,
    setActiveStickerTarget,
    selectedStickerUsesComposedArtwork,
    updateStickerDraft,
    undoEditorSynced,
    redoEditorSynced,
    resetEditorSynced,
    stickerEditorPreparing,
    stickerPlacementActive,
    stickerPartPickingActive,
  } = sticker;
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
  // First Person renders a live view, not the inspect pose a turntable needs, so it can only capture images.
  const captureFormat = firstPersonActive ? 'image' : state.captureFormat;
  const editingMode = lightingPanelOpen && state.preset === CUSTOM_LIGHTING_ID
    ? 'lighting'
    : editorTabActive
      // The graph is a sub-view of paint editing, but its controls share
      // almost nothing with the weapon surface, so it gets its own page in
      // the reference.
      ? editorTool === 'paint' && paintSubView === 'graph' ? 'graph' : editorTool
      : null;

  const graph = useOperationGraphEditor({
    editableKitId,
    editorStatus,
    editorCurrent,
    editorRevision,
    provenanceRecipe,
    paintSubView,
    setPaintSubView,
    setEditorTool,
    replaceOperationGraph,
    setDefinitionVariable,
    groupDiscovery,
    transformDiscovery,
    baseTextureTransform,
    editableGroupTargets,
    setActiveEditorSelector,
    setWeaponBaseLayerActive,
    stickerTargets,
    updateStickerDraft,
    setActiveStickerTarget,
    state,
    data,
    engineReady,
    compositorRef,
    sourceProvider,
    packageGeneration,
    selectedKit,
  });
  const { composing, visibleDefinitionGeneration } = useComposedPaint({
    cache: composeCache,
    suspended: stickerPlacementActive && selectedStickerUsesComposedArtwork,
    // Isolation owns the live layer preview. Keep the normal compositor idle
    // during its drag, but available for weapon and committed recipe changes so
    // the translucent context always belongs to the current weapon.
    interactive: paintSubView === 'transform' && transformDraft !== null,
    interactiveRecipe: transformDraft ? transformPreviewRecipe : null,
    interactiveKey: transformDraft
      ? `${transformDraft.key}:${transformDraft.value.mode}:${transformDraft.value.min}:${transformDraft.value.max}`
      : '',
    onVisibleResult: handleVisiblePaintResult,
    engineReady,
    data,
    selectedKit,
    resolveRecipe,
    selectedAssetKey,
    loadedAssetKey,
    state,
    assetOverrides,
    packageGeneration,
    definitionGeneration: editorDefinitionGeneration,
    activeTextureOverrides,
    viewerRef,
    compositorRef,
    advanceBoot,
    setError,
    setState,
  });
  const viewport = useEditorViewport({
    editorPreviewPending,
    editorDefinitionGeneration,
    setSessionStickerQuad,
    groupAssignActive,
    groupPointerRef,
    setEditorSample,
    sampleEditorSurface,
    toggleEditorGroup,
    canvasRef,
    viewerRef,
    engineReady,
    editorTabActive,
    visibleDefinitionGeneration,
    setHintDismissed,
    sticker,
  });
  const { editorSelectionHeld, editorInteractionActive, canvasHandlers } = viewport;

  const {
    clearWorkspaceOpen,
    setClearWorkspaceOpen,
    clearingWorkspace,
    clearWorkspaceError,
    workspaceCleared,
    setWorkspaceCleared,
    hasWorkspace,
    openClearWorkspace,
    clearWorkspaceWarning,
    clearWorkspace,
    candidateKey,
    setAnsweredCandidateKey,
    promptedCandidate,
  } = useWorkspace({
    definitions,
    sourcePackage,
    packageGeneration,
    editorDraft,
    editorDirty,
    selectedKit,
    assetOverrideCache,
    removePackage,
    clearAssetOverrideCache,
    setWorkbenchExpanded,
    setWorkbenchTab,
  });

  const { viewAngleId, onViewAngle } = useViewerEngine({
    canvasRef,
    viewerRef,
    compositorRef,
    data,
    sourceProvider,
    selectedKit,
    selectedAssetKey,
    selectedMaterialOverrideId,
    packageGeneration,
    definitionsGeneration: definitions.generation,
    state,
    patch,
    autoSpin,
    firstPersonActive,
    editingMode,
    engineReady,
    environmentReady,
    advanceBoot,
    disposeCache,
    resetComposeKey,
    resolveRecipe,
    setEngineReady,
    setEnvironmentReady,
    setCameraMode,
    setLoadedAssetKey,
    setError,
  });

  const onSelectKit = useCallback(
    (id: number) => {
      if (id !== selectedKitId && editorDirty && !window.confirm('Discard unsaved edits and open another war paint?')) return;
      setSelectedKitId(id);
      const kit = paintkits.find((p) => p.id === id);
      const next: Partial<ControlsState> = {};
      if (kit && !kit.weapons.includes(state.weaponKey)) {
        next.weaponKey = kit.weapons[0] ?? state.weaponKey;
      }
      // Team Shine is the one sheen with a per-team color, so the team choice
      // stays meaningful (and selectable) even on single-team warpaints, as
      // it does in First Person, where the arms follow the team.
      if (kit && !kit.hasTeamTextures && state.sheen !== 'team_shine' && !firstPersonActive) next.team = 'red';
      patch(next);
    },
    [editorDirty, paintkits, selectedKitId, state.weaponKey, state.sheen, firstPersonActive, patch],
  );

  // Selecting a kit belongs to the app, so the hook leaves that hole for it.
  const definitionsState = useMemo<CustomDefinitionsState>(() => ({
    ...definitions.state,
    onSelectKit,
    onImport: (files) => {
      if (editorDirty && !window.confirm('Discard unsaved edits and replace the imported definitions?')) return;
      definitions.state.onImport(files);
    },
    onRemove: () => {
      if (editorDirty && !window.confirm('Discard unsaved edits and remove the imported definitions?')) return;
      definitions.state.onRemove();
    },
  }), [definitions.state, editorDirty, onSelectKit]);

  const exportDefinitions = useExportDefinitions({
    data,
    selectedKit,
    exportImportedKit,
    sourceProvider,
    packageGeneration,
    editorRecipes,
    manualTextureOverrides,
  });

  const {
    saveImage: onScreenshot,
    saveTurntable: onSaveTurntable,
    copyImage: onCopyImage,
  } = useScreenshotActions({
    viewerRef,
    paintName: selectedKit?.name,
    weaponKey: state.weaponKey,
    seed: state.seed,
    maxEdge: state.screenshotMaxEdge,
    turntable: {
      turntableFormat: state.turntableFormat,
      turntableProfiles: state.turntableProfiles,
      turntableTransparent: state.turntableTransparent,
      turntableColor: state.turntableColor,
    },
  });
  const { turntableFormats, startTurntableCapture, turntableToastProps, closeTurntableToast } = useTurntableCapture({
    turntableFormat: state.turntableFormat,
    patch,
    onSaveTurntable,
    selectedKitId,
    weaponKey: state.weaponKey,
    team: state.team,
    wearIndex: state.wearIndex,
    seed: state.seed,
    sheen: state.sheen,
    unusual: state.unusual,
    fov: state.fov,
    projection: state.projection,
    preset: state.preset,
    selectedMaterialOverrideId,
    packageGeneration,
    editorDefinitionGeneration,
    activeTextureOverrides,
    viewAngleId,
    firstPersonActive,
    editingMode,
  });
  const paintToolForIcons = data?.manifest.weapons.find((weapon) => weapon.key === 'paintkit_tool');
  const customCatalogKitIds = useMemo(
    () => definitions.catalogKits.map((kit) => kit.id),
    [definitions.catalogKits],
  );
  const resolveCustomIconTexture = useCallback(
    (ref: string) => sourceProvider.resolve(ref),
    [sourceProvider],
  );
  const renderedCustomIcons = useCustomWarpaintIcons({
    enabled: engineReady,
    generation: definitions.generation,
    packageGeneration,
    kits: definitions.catalogKits,
    paintTool: paintToolForIcons,
    modelUrl: data && paintToolForIcons ? data.getModelUrl(paintToolForIcons.key) : null,
    compositorRef,
    getRecipe: definitions.getRecipe,
    resolveTexture: resolveCustomIconTexture,
    visibleKitIds: visibleCatalogKitIds,
  });

  const materials = useMaterialOverridesEditor({
    editorStatus,
    editorCurrent,
    weaponSlots,
    setSessionWeaponMaterial,
    setSessionWeaponMaterials,
    data,
    mountedMaterialPaths,
  });

  if (error) return <div className="fatal">Failed to start: {error}</div>;
  if (!data) return <BootLoader boot={boot} />;

  const weaponOptions = (selectedKit?.weapons ?? data.manifest.weapons.map((w) => w.key)).map((key) => {
    const weapon = data.manifest.weapons.find((w) => w.key === key);
    return {
      value: key,
      label: weapon?.name ?? key,
      icon: weapon?.icon ? data.getAssetUrl(weapon.icon) : null,
    };
  });

  const collectionIcons: Record<string, string> = {};
  if (data.manifest.collectionIcons) {
    for (const [name, rel] of Object.entries(data.manifest.collectionIcons)) {
      const url = data.getAssetUrl(rel);
      if (url) collectionIcons[name] = url;
    }
  }

  // Imported kits have no shipped thumbnail; theirs is resolved from the
  // pattern texture the definition names, through the mounted package.
  const paintIcons: Record<number, string> = { ...definitions.icons, ...renderedCustomIcons };
  for (const kit of data.manifest.paintkits) {
    const url = kit.icon ? data.getAssetUrl(kit.icon) : null;
    if (url) paintIcons[kit.id] = url;
  }

  // selectedKit is set well before boot finishes (it drives the first model
  // load), so the header also waits on the boot overlay itself; otherwise
  // it would flash in over the loading screen.
  const showStageHeader = boot.progress >= 100 && !!selectedKit;

  return (
    <div
      className="app"
      data-mobile-panel={mobilePanel}
      data-catalog-hidden={!catalogVisible ? '' : undefined}
      data-controls-hidden={!controlsVisible ? '' : undefined}
    >
      <aside className="sidebar" id="warpaint-catalog-panel">
        <WarpaintList
          paintkits={paintkits}
          selectedId={selectedKitId}
          onSelect={onSelectKit}
          collectionIcons={collectionIcons}
          paintIcons={paintIcons}
          visibilityTrackedKitIds={customCatalogKitIds}
          onVisibleKitIdsChange={reportVisibleCatalogKitIds}
        />
      </aside>
      <main className="stage">
        <PanelEdgeToggle
          side="left"
          open={catalogVisible}
          label={catalogVisible ? 'Hide warpaint catalog' : 'Show warpaint catalog'}
          controls="warpaint-catalog-panel"
          onToggle={() => setCatalogVisible((visible) => !visible)}
        />
        <PanelEdgeToggle
          side="right"
          open={controlsVisible}
          label={controlsVisible ? 'Hide controls' : 'Show controls'}
          controls="viewer-controls-panel"
          onToggle={() => setControlsVisible((visible) => !visible)}
        />
        <div
          className="canvas-wrap"
          data-prompt={promptedCandidate ? '' : undefined}
          data-editor-selecting={editorInteractionActive && editorSelectionHeld ? '' : undefined}
          data-model-part-picking={stickerPartPickingActive ? '' : undefined}
          {...canvasHandlers}
          onPointerDown={() => setHintDismissed(true)}
          onWheel={() => setHintDismissed(true)}
        >
          <canvas ref={canvasRef} className="viewer-canvas" />
          {firstPersonActive && <div className="first-person-input-shield" aria-hidden="true" />}
          <StageOverlay
            selectedKit={selectedKit}
            showStageHeader={showStageHeader}
            weaponName={weaponName}
            hasCustomFiles={Object.keys(manualTextureOverrides).length > 0}
            composing={composing}
            cameraMode={cameraMode}
          />
          <StageToolbar
            workbenchOpen={workbenchOpen}
            editingMode={editingMode}
            onToggleWorkbench={() => {
              setWorkbenchMounted(true);
              setWorkbenchOpen((open) => !open);
            }}
            captureFormat={captureFormat}
            saveLabel={captureFormat === 'image' ? 'Save PNG' : `Save ${TURNTABLE_FORMATS[state.turntableFormat].label}`}
            onSave={captureFormat === 'animated' ? startTurntableCapture : onScreenshot}
            onCopyImage={onCopyImage}
            onResetView={() => viewerRef.current?.resetView()}
            autoSpin={autoSpin}
            onToggleAutoSpin={() => setAutoSpin((spinning) => !spinning)}
            showAutoSpin={!firstPersonActive}
          />
          {state.preset === CUSTOM_LIGHTING_ID && (
            <LightingPanel store={lightingStore} />
          )}
          <CanvasHint
            dismissed={hintDismissed}
            editorInteractionActive={editorInteractionActive}
            stickerEditorPreparing={stickerEditorPreparing}
            stickerPartPickingActive={stickerPartPickingActive}
            stickerPlacementActive={stickerPlacementActive}
            stickerTransformTool={stickerTransformTool}
            groupAssignActive={groupAssignActive}
          />
          {!editingMode && <SupportLink />}
          {promptedCandidate && (
            <DefinitionsPrompt
              path={promptedCandidate.path}
              onImport={() => {
                promptedCandidate.onLoad();
                // Land on the tab that will show what was imported, whether the
                // drawer is open now or opened later.
                setWorkbenchTab('definitions');
                setAnsweredCandidateKey(candidateKey);
              }}
              onDismiss={() => setAnsweredCandidateKey(candidateKey)}
            />
          )}
        </div>
        <div
          className="custom-workbench-slot"
          data-open={workbenchOpen ? '' : undefined}
          data-expanded={workbenchExpanded ? '' : undefined}
          inert={!workbenchOpen}
          style={workbenchHeight ? ({ '--workbench-h': `${workbenchHeight}px` } as CSSProperties) : undefined}
        >
          {workbenchMounted && (
            <Suspense fallback={<div className="custom-workbench-loading">Loading custom files…</div>}>
              <CustomWarpaintWorkbench
                key={`${selectedKitId ?? 'empty'}|${state.weaponKey}`}
                recipes={workbenchTab === 'package' || workbenchTab === 'definitions' ? [] : editorRecipes}
                definitions={definitionsState}
                tab={workbenchTab}
                onTabChange={(nextTab) => {
                  setWorkbenchTab(nextTab);
                  if (nextTab !== 'editor') setWorkbenchExpanded(false);
                }}
                expanded={workbenchExpanded}
                onExpandedChange={setWorkbenchExpanded}
                resolveTexture={data.resolveTexture}
                textureMetadata={data.manifest.textures}
                paintName={selectedKit?.name}
                weaponName={weaponName}
                gameBuild={data.manifest.gameBuild}
                snapshotDate={data.manifest.generatedAt}
                exportDefinitions={exportDefinitions}
                editor={{
                  mode: editorTool,
                  onModeChange: (mode) => {
                    setEditorTool(mode);
                    updateStickerDraft(null);
                    setEditorSample(null);
                    setPanelPreviewGroup(null);
                  },
                  ...(sticker.props ? { sticker: sticker.props } : {}),
                  ...parts.props,
                  teamColors: transform.teamColors,
                  dirty: editorDirty,
                  draft: editorDraft,
                  onDownloadRecovery: downloadEditorRecovery,
                  canDownload: editableKitId !== null && !editorLoading && !editorPackageExporting,
                  exporting: editorPackageExporting,
                  canUndo: editorCanUndo,
                  canRedo: editorCanRedo,
                  error: editableKitId !== null
                    ? (editorPackageExportError
                      ?? graph.operationGraphEditError
                      ?? editorSessionError
                      ?? editorPreviewError)
                    : null,
                  onUndo: undoEditorSynced,
                  onRedo: redoEditorSynced,
                  onReset: resetEditorSynced,
                  onDownloadPackage: downloadEditorPackage,
                  ...(transform.props ? { transform: transform.props } : {}),
                  ...(graph.props ? { graph: graph.props } : {}),
                  ...(materials ? { materials } : {}),
                  paintSubView,
                  onPaintSubViewChange: setPaintSubView,
                  layerHasTransformEdits,
                  layerTransformLocked,
                }}
                sourcePackage={sourcePackage}
                resolvePackageTexture={resolvePackageTexture}
                hasPackageTexture={(ref) => Boolean(sourceProvider.packagePathFor(ref))}
                packageGeneration={packageGeneration}
                loading={editorLoading}
                open={workbenchOpen}
                initialOverrides={assetOverrides}
                onChange={(overrides) => {
                  resetComposeKey();
                  setAssetOverrideCache((cache) => ({ ...cache, [assetOverrideScope]: overrides }));
                }}
                onResetAll={() => {
                  removePackage();
                  clearAssetOverrideCache();
                }}
                onClearWorkspace={hasWorkspace ? openClearWorkspace : undefined}
                // A height of 0 means "back to the default clamp", which is what
                // double-clicking the drawer's resize handle asks for.
                onResize={setWorkbenchHeight}
                onClose={() => {
                  setWorkbenchExpanded(false);
                  setWorkbenchOpen(false);
                }}
              />
            </Suspense>
          )}
        </div>
      </main>
      <aside className="inspector" id="viewer-controls-panel">
        <Inspector
          firstPersonActive={firstPersonActive}
          previewControls={engineReady && viewerRef.current && <FirstPersonControls
            viewer={viewerRef.current}
            weaponKey={state.weaponKey}
            team={state.team}
            enabled={firstPersonActive}
            onEnabledChange={setFirstPersonEnabled}
            disabled={!selectedKit || !state.weaponKey || editorTabActive || lightingPanelOpen}
          />}
          manifest={data.manifest}
          weaponOptions={weaponOptions}
          hasTeamTextures={firstPersonActive || kitHasTeamTextures}
          state={state}
          turntableFormats={turntableFormats}
          viewAngle={viewAngleId}
          onChange={patch}
          onRandomizeSeed={randomizeSeed}
          onUndoSeed={undoSeed}
          canUndoSeed={canUndoSeed}
          onViewAngle={onViewAngle}
          lightingStore={lightingStore}
          onToggleLightingPanel={toggleLightingPanel}
          onSelectLight={selectLight}
        />
      </aside>
      <MobileTabStrip mobilePanel={mobilePanel} setMobilePanel={setMobilePanel} />
      <AppToasts
        editorDraft={editorDraft}
        editorDraftKey={editorDraftKey}
        editorDirty={editorDirty}
        onDownloadRecovery={downloadEditorRecovery}
        turntableToastProps={turntableToastProps}
        closeTurntableToast={closeTurntableToast}
        workspaceCleared={workspaceCleared}
        onWorkspaceClearedClose={() => setWorkspaceCleared(null)}
      />
      <ClearWorkspaceDialog
        open={clearWorkspaceOpen}
        onOpenChange={setClearWorkspaceOpen}
        unsavedWarning={clearWorkspaceWarning}
        onDownloadRecovery={downloadEditorRecovery}
        clearing={clearingWorkspace}
        error={clearWorkspaceError}
        onConfirm={clearWorkspace}
      />
      {boot.progress < 100 && <BootLoader boot={boot} />}
    </div>
  );
}
