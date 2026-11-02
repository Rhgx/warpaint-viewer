import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import '../ui/catalog/WarpaintList.css';
import '../ui/stage/StageToolbar.css';
import '../ui/stage/Inspector.css';
import '../styles/stage.css';
import '../styles/layout.css';
import type { Viewer } from '../viewer/Viewer';
import { isStockMaterialCubemap, stockMaterialCubemapUrls } from '../viewer/stockCubemapUrls';
import type { Compositor } from '../compositor/compositor';
import type { PaintkitEntry } from '../data/types';
import { WarpaintList } from '../ui/catalog/WarpaintList';
import { Inspector } from '../ui/stage/Inspector';
import type { ControlsState } from '../viewer/controls';
import { MobileTabStrip } from '../ui/stage/MobileTabStrip';
import type { MobilePanel } from '../ui/stage/MobileTabStrip';
import { FirstPersonControls } from '../ui/stage/FirstPersonControls';
import { StageCanvas } from './StageCanvas';
import { PanelEdgeToggle } from '../ui/common/PanelEdgeToggle';
import type { WarpaintAssetOverrides } from '../workbench/types';
import { revokeAssetOverrideCache } from '../workbench/assetUrls';
import { BootLoader } from '../ui/boot/BootLoader';
import { CUSTOM_LIGHTING_ID } from '../viewer/lighting/customLightingModel';
import { useBootData } from '../hooks/useBootData';
import { useComposedPaint, useComposeCache } from '../hooks/useComposedPaint';
import { createInitialControlsState } from './initialControlsState';
import { useContextRestores } from './useContextRestores';
import { useMobileViewInset } from './useMobileViewInset';
import { useAssetPreload } from './useAssetPreload';
import { useKitSuggestion } from './useKitSuggestion';
import { useTextureOverrides } from './useTextureOverrides';
import { useGuardedDefinitionsState } from './useGuardedDefinitionsState';
import { useWorkbenchDrawer } from './useWorkbenchDrawer';
import { useCatalogIcons } from './useCatalogIcons';
import { useLightingRig } from './useLightingRig';
import { useWorkspace } from './useWorkspace';
import { useViewerEngine } from './useViewerEngine';
import { useExportDefinitions, useWorkbenchRecipes } from '../hooks/useWorkbenchRecipes';
import { useSeedHistory } from './useSeedHistory';
import { useIntentPreload } from '../hooks/useIntentPreload';
import { useStableCallback } from '../hooks/useStableCallback';
import { useTurntableCapture } from './useTurntableCapture';
import { useSourcePackage } from '../hooks/useSourcePackage';
import { useCustomDefinitions } from '../hooks/useCustomDefinitions';
import { useStockDefinitions } from '../hooks/useStockDefinitions';
import { useScreenshotActions } from '../hooks/useScreenshotActions';
import { useCustomWarpaintIcons } from '../hooks/useCustomWarpaintIcons';
import { isCustomKitId } from '../protodefs/types';
import { useEditorCore } from '../editor/useEditorCore';
import { useEditorTools } from '../editor/useEditorTools';
import { useMaterialOverridesEditor } from '../editor/materials/useMaterialOverridesEditor';
import { useEditorViewport } from '../editor/useEditorViewport';
import { useOperationGraphEditor } from '../editor/graph/useOperationGraphEditor';
import { ClearWorkspaceDialog } from '../ui/common/ClearWorkspaceDialog';
import { AppToasts } from '../ui/common/AppToasts';
import { matchesMobileLayout, WORKSHOP_ENABLED } from '../device';
import { useSettings } from '../settings';

// Selftest page is code-split: it never loads in normal use.
const SelfTestPage = lazy(() => import('../dev/selftest').then((m) => ({ default: m.SelfTestPage })));
// Loaded lazily: the custom-file UI pulls in texture decoders and a large editor.
const loadWorkbench = () => import('../ui/workbench/CustomWarpaintWorkbench').then((m) => ({ default: m.CustomWarpaintWorkbench }));
const CustomWarpaintWorkbench = lazy(loadWorkbench);
const ShowcaseMode = lazy(() => import('../ui/showcase/ShowcaseMode'));

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
  const inspectorRef = useRef<HTMLElement | null>(null);
  const compositorRef = useRef<Compositor | null>(null);

  const [engineReady, setEngineReady] = useState(false);
  const [firstPersonEnabled, setFirstPersonEnabled] = useState(false);
  const [autoSpin, setAutoSpin] = useState(false);
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const {
    workbenchOpen,
    workbenchMounted,
    workbenchExpanded,
    setWorkbenchExpanded,
    workbenchHeight,
    setWorkbenchHeight,
    workbenchResizing,
    setWorkbenchResizing,
    workbenchTab,
    setWorkbenchTab,
    toggleWorkbench,
    changeWorkbenchTab,
    closeWorkbench,
  } = useWorkbenchDrawer();
  const [visibleCatalogKitIds, setVisibleCatalogKitIds] = useState<readonly number[]>([]);
  const [assetOverrideCache, setAssetOverrideCache] = useState<Record<string, WarpaintAssetOverrides>>({});
  const [catalogVisible, setCatalogVisible] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [showcaseOpen, setShowcaseOpen] = useState(false);
  // Hidden while the Settings toggle is off; it comes back when the toggle does.
  const showcaseActive = useSettings((s) => s.showcaseBoard) && WORKSHOP_ENABLED && showcaseOpen;
  // The board covers the stage, so the 3D viewer stops drawing until it closes.
  useEffect(() => {
    viewerRef.current?.setSuspended(showcaseActive);
  }, [showcaseActive, engineReady]);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [cameraMode, setCameraMode] = useState<'inspect' | 'advanced'>('inspect');
  const [loadedAssetKey, setLoadedAssetKey] = useState('');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('none');
  const [state, setState] = useState<ControlsState>(createInitialControlsState);
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
    exportKitBundle: exportImportedKitBundle,
    getRecipeWithProvenance: getImportedRecipeWithProvenance,
  } = definitions;
  const composeCache = useComposeCache(compositorRef);
  const { resetComposeKey, disposeCache } = composeCache;
  const contextRestores = useContextRestores(canvasRef, engineReady, disposeCache);

  // Imported definitions join the catalog; everything downstream reads this merged list.
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
    editorCurrent,
    editorDirty,
    editorCanUndo,
    editorCanRedo,
    editorSessionError,
    setSessionStickerQuad,
    setSessionWeaponMaterial,
    setSessionWeaponMaterials,
    replaceOperationGraph,
    setDefinitionVariable,
    editorRevision,
    weaponSlots,
    editorTool,
    setEditorTool,
    paintSubView,
    setPaintSubView,
    editorActiveScope,
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
  // Team colors switched on in the editor count once the edit lands, so the RED/BLU toggle follows it.
  // A per-wear paint has one operation per weapon and wear; the editor names the one it shows.
  const perWearScope = editorActiveScope && data
    ? {
      weapon: data.manifest.weapons.find((w) => w.key === editorActiveScope.weaponKey)?.name ?? editorActiveScope.weaponKey,
      wear: data.manifest.wearNames[editorActiveScope.wear] ?? `Wear ${editorActiveScope.wear}`,
    }
    : undefined;
  const kitHasTeamTextures = (selectedKit?.hasTeamTextures ?? false)
    || (editableKitId !== null && editorSessionKitId === editableKitId
      && editorCurrent?.definition.has_team_textures === true);
  // Camera policy follows the Edit tab even while its map loads; selection input
  // is stricter and waits for a usable target and image.
  const editorTabActive = workbenchOpen && workbenchTab === 'editor';
  const firstPersonActive = firstPersonEnabled && !!selectedKit && !!state.weaponKey
    && state.weaponKey !== 'paintkit_tool' && !editorTabActive && !lightingPanelOpen;
  useEffect(() => {
    // Reached only when a team layer is switched off or First Person is left;
    // picking a paint already clamps the team.
    if (selectedKit && !kitHasTeamTextures && !firstPersonActive && state.team === 'blu' && state.sheen !== 'team_shine') {
      setState((current) => ({ ...current, team: 'red' }));
    }
  }, [kitHasTeamTextures, firstPersonActive, selectedKit, state.sheen, state.team]);
  useMobileViewInset({
    viewerRef,
    inspectorRef,
    engineReady,
    mobilePanel,
    firstPersonActive,
  });
  const selectedMaterialOverrideId = selectedKit?.materialOverrides?.[state.weaponKey] ?? '';
  const selectedAssetKey = selectedKit && state.weaponKey
    ? `${state.weaponKey}|material:${selectedMaterialOverrideId || 'stock'}|package:${packageGeneration}`
    : '';
  // Edits are scoped per paintkit, not per weapon, so imported textures follow weapon changes.
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

  const preloadWorkbench = useIntentPreload(useCallback(async () => {
    await loadWorkbench();
  }, []));
  const preloadAssets = useAssetPreload({
    data,
    engineReady,
    paintkits,
    selectedKit,
    state,
    firstPersonActive,
    resolveRecipe,
    packageGeneration,
    sourceProvider,
    viewerRef,
    compositorRef,
  });

  useKitSuggestion({
    definitionsSuggestedKitId: definitions.suggestedKitId,
    definitionsGeneration: definitions.generation,
    suggestedPaintkitId,
    packageGeneration,
    editorDirty,
    firstPersonActive,
    paintkits,
    setSelectedKitId,
    setState,
  });
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
  const {
    resolvePackageTexture,
    manualTextureOverrides,
    mountedSourcePackage,
    packageStickerSpecularOverrides,
    activeTextureOverrides,
    mountedMaterialPaths,
  } = useTextureOverrides({ sourceProvider, assetOverrides, editorRecipes, packageGeneration });

  const { layers, parts, transform, sticker } = useEditorTools({
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
  });
  const {
    groupDiscovery,
    transformDiscovery,
    baseTextureTransform,
    editableGroupTargets,
    setActiveEditorSelector,
    setWeaponBaseLayerActive,
  } = layers;
  const {
    groupAssignActive,
    groupPointerRef,
    setHoverBucket,
    setPanelPreviewGroup,
    sampleEditorSurface,
    toggleEditorGroup,
  } = parts;
  const {
    transformDraft,
    transformPreviewRecipe,
    handleVisiblePaintResult,
    layerHasTransformEdits,
    layerTransformLocked,
  } = transform;
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
  // First Person renders a live view, not the inspect pose a turntable needs, so it can only capture images.
  const captureFormat = firstPersonActive ? 'image' : state.captureFormat;
  const editingMode = lightingPanelOpen && state.preset === CUSTOM_LIGHTING_ID
    ? 'lighting'
    : editorTabActive
      // The graph shares almost no controls with the weapon surface, so it gets its own page.
      ? editorTool === 'paint' && paintSubView === 'graph' ? 'graph' : editorTool
      : null;

  // Stable so catalog rows do not re-render when the seed or selection changes.
  const onSelectKit = useStableCallback((id: number) => {
    if (id !== selectedKitId && editorDirty && !window.confirm('Discard unsaved edits and open another war paint?')) return;
    setSelectedKitId(id);
    const kit = paintkits.find((p) => p.id === id);
    const next: Partial<ControlsState> = {};
    if (kit && !kit.weapons.includes(state.weaponKey)) {
      next.weaponKey = kit.weapons[0] ?? state.weaponKey;
    }
    // Team Shine is the only sheen with a per-team color, so the team stays selectable
    // on single-team paints.
    if (kit && !kit.hasTeamTextures && state.sheen !== 'team_shine' && !firstPersonActive) next.team = 'red';
    patch(next);
    // On mobile the catalog covers the stage, so picking a paint closes it.
    if (matchesMobileLayout()) setMobilePanel('none');
  });

  const paintNames = useMemo(
    () => new Map<number, string>(data?.manifest.paintkits.map((kit) => [kit.id, kit.name]) ?? []),
    [data],
  );

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
    paintNames,
    onSelectKit,
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
    contextRestores,
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
    setHoverBucket,
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

  const definitionsState = useGuardedDefinitionsState({
    definitionsState: definitions.state,
    exportStockKit: stockDefinitions.exportKit,
    editorDirty,
    onSelectKit,
    selectedKit,
  });

  const exportDefinitions = useExportDefinitions({
    data,
    selectedKit,
    exportImportedKitBundle,
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
    bootReady: boot.progress >= 100,
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

  const { weaponOptions, collectionIcons, paintIcons } = useCatalogIcons({
    data,
    selectedKitWeapons: selectedKit?.weapons,
    definitionIcons: definitions.icons,
    renderedCustomIcons,
  });

  const hasSelectedKit = !!selectedKit;
  // A fresh element every render would defeat the memoized Inspector.
  const previewControls = useMemo(() => engineReady && viewerRef.current && <FirstPersonControls
    viewer={viewerRef.current}
    weaponKey={state.weaponKey}
    team={state.team}
    enabled={firstPersonActive}
    onEnabledChange={setFirstPersonEnabled}
    disabled={!hasSelectedKit || !state.weaponKey || editorTabActive || lightingPanelOpen}
  />, [editorTabActive, engineReady, firstPersonActive, hasSelectedKit, lightingPanelOpen, state.team, state.weaponKey]);

  if (error) return <div className="fatal">Failed to start: {error}</div>;
  if (!data) return <BootLoader boot={boot} />;

  // selectedKit is set before boot finishes, so the header also waits on the boot overlay.
  const showStageHeader = boot.progress >= 100 && !!selectedKit;

  return (
    <div
      className="app"
      data-mobile-panel={mobilePanel}
      data-catalog-hidden={!catalogVisible ? '' : undefined}
      data-controls-hidden={!controlsVisible ? '' : undefined}
      data-first-person={firstPersonActive ? '' : undefined}
    >
      <aside className="sidebar" id="warpaint-catalog-panel">
        <WarpaintList
          paintkits={paintkits}
          selectedId={selectedKitId}
          onSelect={onSelectKit}
          onPreload={preloadAssets}
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
        <StageCanvas
          canvasHandlers={canvasHandlers}
          canvasRef={canvasRef}
          viewerRef={viewerRef}
          promptedCandidate={promptedCandidate}
          candidateKey={candidateKey}
          setAnsweredCandidateKey={setAnsweredCandidateKey}
          setWorkbenchTab={setWorkbenchTab}
          hintDismissed={hintDismissed}
          setHintDismissed={setHintDismissed}
          firstPersonActive={firstPersonActive}
          selectedKit={selectedKit}
          showStageHeader={showStageHeader}
          weaponName={weaponName}
          manualTextureOverrides={manualTextureOverrides}
          composing={composing}
          cameraMode={cameraMode}
          paintkits={paintkits}
          onSelectKit={onSelectKit}
          workbenchOpen={workbenchOpen}
          editingMode={editingMode}
          preloadWorkbench={preloadWorkbench}
          toggleWorkbench={toggleWorkbench}
          captureFormat={captureFormat}
          state={state}
          startTurntableCapture={startTurntableCapture}
          onScreenshot={onScreenshot}
          onCopyImage={onCopyImage}
          autoSpin={autoSpin}
          setAutoSpin={setAutoSpin}
          showcaseOpen={showcaseOpen}
          setShowcaseOpen={setShowcaseOpen}
          lightingStore={lightingStore}
          editorInteractionActive={editorInteractionActive}
          editorSelectionHeld={editorSelectionHeld}
          stickerPartPickingActive={stickerPartPickingActive}
          stickerEditorPreparing={stickerEditorPreparing}
          stickerPlacementActive={stickerPlacementActive}
          stickerTransformTool={stickerTransformTool}
          groupAssignActive={groupAssignActive}
        />
        {showcaseActive && (
          <Suspense fallback={null}>
            <ShowcaseMode
              manifest={data.manifest}
              paintkits={paintkits}
              selectedKit={selectedKit}
              team={state.team}
              wearIndex={state.wearIndex}
              seed={state.seed}
              resolveRecipe={resolveRecipe}
              resolveTexture={(ref) => sourceProvider.resolve(ref)}
              resolveCubemap={async (ref) => await sourceProvider.resolveCubemap(ref) ?? stockMaterialCubemapUrls(ref)}
              textureMetadataResolver={(ref) => sourceProvider.metadataFor(ref)}
              inspectorEl={inspectorRef.current}
              onClose={() => setShowcaseOpen(false)}
            />
          </Suspense>
        )}
        <div
          className="custom-workbench-slot"
          data-open={workbenchOpen ? '' : undefined}
          data-expanded={workbenchExpanded ? '' : undefined}
          data-editor-tab={workbenchMounted && workbenchTab === 'editor' ? '' : undefined}
          data-resizing={workbenchResizing ? '' : undefined}
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
                onTabChange={changeWorkbenchTab}
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
                    setHoverBucket(null);
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
                  perWearScope,
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
                // Height 0 restores the default clamp, which a resize-handle double-click asks for.
                onResize={setWorkbenchHeight}
                resizing={workbenchResizing}
                onResizingChange={setWorkbenchResizing}
                onClose={closeWorkbench}
              />
            </Suspense>
          )}
        </div>
      </main>
      <aside className="inspector" id="viewer-controls-panel" ref={inspectorRef}>
        {!showcaseActive && <Inspector
          firstPersonActive={firstPersonActive}
          previewControls={previewControls}
          manifest={data.manifest}
          weaponOptions={weaponOptions}
          onPreloadWeapon={preloadAssets}
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
        />}
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
