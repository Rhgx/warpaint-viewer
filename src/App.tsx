import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Eye, Palette, SlidersHorizontal } from 'lucide-react';
import './ui/catalog/WarpaintList.css';
import './ui/stage/StageToolbar.css';
import './ui/stage/Inspector.css';
import './styles/stage.css';
import './styles/layout.css';
import type { Viewer } from './viewer/Viewer';
import type { Compositor } from './compositor/compositor';
import type { PaintkitEntry } from './data/types';
import { WarpaintList } from './ui/catalog/WarpaintList';
import { Inspector } from './ui/stage/Inspector';
import type { ControlsState } from './viewer/controls';
import { StageToolbar } from './ui/stage/StageToolbar';
import { PanelEdgeToggle } from './ui/common/PanelEdgeToggle';
import { DefinitionsPrompt } from './ui/workbench/DefinitionsPrompt';
import type { WarpaintAssetOverrides, WearRecipe, WorkbenchTab } from './workbench/types';
import { BootLoader } from './ui/boot/BootLoader';
import { VIEW_ANGLES } from './viewer/presets';
import { useBootData, randomSeed } from './hooks/useBootData';
import { useComposedPaint } from './hooks/useComposedPaint';
import { useSourcePackage } from './hooks/useSourcePackage';
import { useCustomDefinitions } from './hooks/useCustomDefinitions';
import { useScreenshotActions } from './hooks/useScreenshotActions';
import { sourceTextureIdentity } from './source/paths';
import { collectTextureRefs, exportPathFor, resolvePackageTextures } from './export/plan';
import { isCustomKitId } from './protodefs/types';
import type { CustomDefinitionsState } from './protodefs/types';

// Selftest page is code-split: it never loads in normal use.
const SelfTestPage = lazy(() => import('./dev/selftest').then((m) => ({ default: m.SelfTestPage })));
// The custom-file UI includes texture decoders and a large interactive editor.
// It is not needed to view a paint, so mount it only after the drawer opens.
const CustomWarpaintWorkbench = lazy(() => import('./ui/workbench/CustomWarpaintWorkbench').then((m) => ({ default: m.CustomWarpaintWorkbench })));

const SEED_HISTORY_CAP = 20;

const EMPTY_OVERRIDES: WarpaintAssetOverrides = { revision: 0, assets: {} };

type MobilePanel = 'none' | 'catalog' | 'controls';

export default function App() {
  if (new URLSearchParams(window.location.search).get('selftest') === '1') {
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
  const seedHistoryRef = useRef<string[]>([]);

  const [engineReady, setEngineReady] = useState(false);
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchMounted, setWorkbenchMounted] = useState(false);
  // 0 keeps the CSS default drawer height; anything else is a user drag.
  const [workbenchHeight, setWorkbenchHeight] = useState(0);
  // The drawer is keyed to remount per paint/weapon, so its tab lives out here.
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>('files');
  const [editorRecipes, setEditorRecipes] = useState<WearRecipe[]>([]);
  const [editorLoading, setEditorLoading] = useState(false);
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
    fov: 75,
    projection: 'perspective',
    screenshotScale: 2,
  }));

  const { data, boot, advanceBoot } = useBootData({ state, setState, selectedKitId, setSelectedKitId, setError });

  const { provider: sourceProvider, sourcePackage, packageGeneration, suggestedPaintkitId, removePackage } = useSourcePackage(
    data?.resolveTexture ?? ((ref) => ref),
    () => setAssetOverrideCache({}),
    (ref) => !!data?.manifest.textures?.[ref],
  );
  const getAssetUrl = useCallback((rel: string) => data?.getAssetUrl(rel) ?? null, [data]);
  const definitions = useCustomDefinitions({
    manifest: data?.manifest ?? null,
    getAssetUrl,
    provider: sourceProvider,
    packageGeneration,
  });

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
  const selectedAssetKey = selectedKit && state.weaponKey ? `${selectedKit.id}|${state.weaponKey}` : '';
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
        : data?.getRecipe(kit, weaponKey, team, wearIndex) ?? Promise.resolve(null)
    ),
    [data, getImportedRecipe],
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
    if (suggestedKitId === undefined || suggestionToken === appliedSuggestionRef.current) return;
    const kit = paintkits.find((entry) => entry.id === suggestedKitId);
    if (!kit) return;
    appliedSuggestionRef.current = suggestionToken;
    setSelectedKitId(kit.id);
    setState((current) => ({
      ...current,
      weaponKey: kit.weapons.includes(current.weaponKey) ? current.weaponKey : (kit.weapons[0] ?? current.weaponKey),
      team: kit.hasTeamTextures || current.sheen === 'team_shine' ? current.team : 'red',
    }));
  }, [paintkits, suggestedKitId, suggestionToken]);
  const resolvePackageTexture = useCallback((ref: string) => sourceProvider.resolvePreview(ref), [sourceProvider]);
  const activeTextureOverrides = useMemo(
    () => Object.fromEntries(
      Object.entries(assetOverrides.assets).flatMap(([ref, asset]) => asset.output ? [[ref, asset.output]] : []),
    ),
    [assetOverrides],
  );

  const { composing, resetComposeKey, disposeCache } = useComposedPaint({
    engineReady,
    data,
    selectedKit,
    resolveRecipe,
    selectedAssetKey,
    loadedAssetKey,
    state,
    assetOverrides,
    packageGeneration,
    activeTextureOverrides,
    viewerRef,
    compositorRef,
    advanceBoot,
    setError,
    setState,
  });

  // Set up viewer + compositor on the canvas. The three.js stack is dynamically
  // imported so it lands in its own chunk and the UI shell paints first.
  useEffect(() => {
    if (!canvasRef.current || !data) return;
    let disposed = false;
    let viewer: Viewer | null = null;
    let compositor: Compositor | null = null;
    let unsubscribeCameraMode: (() => void) | null = null;
    (async () => {
      advanceBoot(22, 'Starting renderer…');
      const [{ Viewer: ViewerCls }, { Compositor: CompositorCls }] = await Promise.all([
        import('./viewer/Viewer'),
        import('./compositor/compositor'),
      ]);
      if (disposed || !canvasRef.current) return;
      viewer = new ViewerCls(canvasRef.current);
      compositor = new CompositorCls((ref) => sourceProvider.resolve(ref), {
        renderer: viewer.renderer,
        size: 1024,
        textureMetadata: data.manifest.textures,
        textureMetadataResolver: (ref) => sourceProvider.metadataFor(ref),
      });
      viewerRef.current = viewer;
      compositorRef.current = compositor;
      unsubscribeCameraMode = viewer.onCameraModeChange(setCameraMode);
      // Dev-only escape hatch for debugging the viewer from the console.
      if (import.meta.env.DEV) (window as unknown as { __viewer?: Viewer }).__viewer = viewer;
      setEngineReady(true);
      advanceBoot(34, 'Loading TF2 environment…');
      await viewer.ready();
      if (!disposed) {
        setEnvironmentReady(true);
        advanceBoot(43, 'Environment ready');
      }
    })();
    return () => {
      disposed = true;
      setEngineReady(false);
      setEnvironmentReady(false);
      disposeCache();
      compositor?.dispose();
      unsubscribeCameraMode?.();
      viewer?.dispose();
      viewerRef.current = null;
      compositorRef.current = null;
    };
  }, [data, advanceBoot, disposeCache, sourceProvider]);

  // Custom files only live in memory. Let the browser warn before a refresh,
  // tab close, or navigation would discard any cached edit set.
  useEffect(() => {
    const hasCachedEdits = Object.values(assetOverrideCache).some((entry) => Object.keys(entry.assets).length > 0);
    if (!hasCachedEdits && sourcePackage.status !== 'mounted' && definitions.state.status !== 'loaded') return;
    const confirmLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', confirmLoss);
    return () => window.removeEventListener('beforeunload', confirmLoss);
  }, [assetOverrideCache, sourcePackage.status, definitions.state.status]);

  // A blank catalog selection has no model/paint work to wait for. Once the
  // renderer environment is ready, the intentionally empty stage is ready too.
  useEffect(() => {
    if (environmentReady && !selectedKit) advanceBoot(100, 'Ready');
  }, [environmentReady, selectedKit, advanceBoot]);

  // Start the tiny recipe request as soon as selection state changes, in
  // parallel with the lazily imported renderer/model setup.
  useEffect(() => {
    if (!data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) return;
    void resolveRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex);
  }, [data, resolveRecipe, selectedKit, state.weaponKey, state.team, state.wearIndex]);

  // The editor and exporter list every input the paint can use, not just the
  // ones the current wear or team happens to reach. Team-aware operation
  // stages resolve texture_red and texture_blue to different refs; collecting
  // only the selected team produced packs whose definition referenced BLU
  // artwork that was never included. Bundles are cached, so the extra
  // team/wear resolutions cost no extra network requests.
  useEffect(() => {
    // Keep this editor-only fan-out off the normal viewer path. Once mounted,
    // the workbench remains alive while its drawer is closed, so continue
    // keeping its recipes current after the user's first open.
    if (!workbenchMounted || !data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) {
      setEditorRecipes([]);
      setEditorLoading(false);
      return;
    }
    let cancelled = false;
    setEditorLoading(true);
    const wearIndexes = selectedKit.perWear
      ? data.manifest.wearLevels.map((_, index) => index)
      : [state.wearIndex];
    const teams = selectedKit.hasTeamTextures ? (['red', 'blu'] as const) : [state.team];
    void Promise.all(
      teams.flatMap((team) =>
        wearIndexes.map((wearIndex) => resolveRecipe(selectedKit, state.weaponKey, team, wearIndex)
          .then((recipe) => ({ wearIndex, recipe }))),
      ),
    ).then((loaded) => {
      if (cancelled) return;
      setEditorRecipes(loaded.flatMap(({ wearIndex, recipe }) => recipe ? [{ wearIndex, recipe }] : []));
    }).finally(() => {
      if (!cancelled) setEditorLoading(false);
    });
    return () => { cancelled = true; };
  }, [workbenchMounted, data, resolveRecipe, selectedKit, state.weaponKey, state.team, state.wearIndex]);

  // Load the model when the weapon changes.
  useEffect(() => {
    if (!engineReady || !data || !viewerRef.current || !state.weaponKey) return;
    let cancelled = false;
    const viewer = viewerRef.current;
    const weapon = data.manifest.weapons.find((w) => w.key === state.weaponKey);
    if (!weapon || !selectedAssetKey) return;
    setLoadedAssetKey('');
    advanceBoot(48, 'Loading initial weapon…');
    const overrideId = selectedKit?.materialOverrides?.[state.weaponKey];
    const builtInMaterial = (overrideId && data.manifest.materials?.[overrideId]) || weapon.material;
    // A mounted package may ship its own VMT for this weapon, which the game
    // would load in place of the stock material. Its parameters replace the
    // baked-in ones wholesale, the way a Source material does.
    const applyMaterial = sourceProvider.resolveMaterial(state.weaponKey, overrideId)
      .then((packaged) => viewer.applyMaterialParams(
        packaged?.material ?? builtInMaterial,
        (ref) => sourceProvider.resolve(ref),
      ));
    void Promise.all([
      viewer.ready(),
      viewer.loadModel(data.getModelUrl(state.weaponKey)),
      applyMaterial,
    ]).then(() => {
      if (cancelled) return;
      setLoadedAssetKey(selectedAssetKey);
      advanceBoot(62, 'Weapon and material maps ready');
    }).catch((e) => {
      if (!cancelled) setError(`Failed to load weapon assets: ${String(e)}`);
    });
    return () => { cancelled = true; };
  }, [engineReady, data, selectedKit, selectedAssetKey, state.weaponKey, packageGeneration, advanceBoot, sourceProvider]);

  // Archive replacement changes the answer for existing Source paths, so
  // release old source uploads and composite targets before the generation-keyed
  // compose starts. The provider ignores stale reads from the removed package.
  // A re-imported definitions file reuses the same catalog ids, so the compose
  // cache has to be dropped for it too or an edited paint would render stale.
  useEffect(() => {
    compositorRef.current?.invalidateTextures();
    disposeCache();
    resetComposeKey();
  }, [packageGeneration, definitions.generation, disposeCache, resetComposeKey]);

  // Lighting.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setLighting(state.preset);
  }, [engineReady, state.preset]);

  // Killstreak sheen.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setSheen(state.sheen, state.team);
  }, [engineReady, state.sheen, state.team]);

  // Unusual particle effect.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setUnusual(state.unusual, state.weaponKey);
  }, [engineReady, state.unusual, state.weaponKey]);

  // Field of view.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setFov(state.fov);
  }, [engineReady, state.fov]);

  // Projection mode.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setProjection(state.projection);
  }, [engineReady, state.projection]);

  // Pushing history here (rather than inside the setState updater) keeps the
  // updater pure: React/StrictMode may invoke an updater function twice in
  // dev, which would double-push if the ref mutation lived in there.
  const patch = useCallback(
    (p: Partial<ControlsState>) => {
      if (p.seed !== undefined && p.seed !== state.seed) {
        const stack = seedHistoryRef.current;
        stack.push(state.seed);
        if (stack.length > SEED_HISTORY_CAP) stack.shift();
      }
      setState((s) => ({ ...s, ...p }));
    },
    [state.seed],
  );

  // Pops the history stack and jumps straight to that seed, bypassing patch
  // so the undo itself is not recorded as a new history entry.
  const undoSeed = useCallback(() => {
    const prev = seedHistoryRef.current.pop();
    if (prev === undefined) return;
    setState((s) => ({ ...s, seed: prev }));
  }, []);
  const canUndoSeed = seedHistoryRef.current.length > 0;

  const onSelectKit = useCallback(
    (id: number) => {
      setSelectedKitId(id);
      const kit = paintkits.find((p) => p.id === id);
      const next: Partial<ControlsState> = {};
      if (kit && !kit.weapons.includes(state.weaponKey)) {
        next.weaponKey = kit.weapons[0] ?? state.weaponKey;
      }
      // Team Shine is the one sheen with a per-team color, so the team choice
      // stays meaningful (and selectable) even on single-team warpaints.
      if (kit && !kit.hasTeamTextures && state.sheen !== 'team_shine') next.team = 'red';
      patch(next);
    },
    [paintkits, state.weaponKey, state.sheen, patch],
  );

  // Selecting a kit belongs to the app, so the hook leaves that hole for it.
  const definitionsState = useMemo<CustomDefinitionsState>(
    () => ({ ...definitions.state, onSelectKit }),
    [definitions.state, onSelectKit],
  );

  // A mounted package often carries the definitions its textures belong to, but
  // the Definitions tab that says so is behind a drawer most people never open.
  // Ask over the stage instead, once per package: importing or dismissing
  // answers it, and so does importing definitions from anywhere else.
  const { packageCandidate } = definitions.state;
  const candidateKey = packageCandidate ? `${packageGeneration}:${packageCandidate.path}` : '';
  const candidateKeyRef = useRef(candidateKey);
  candidateKeyRef.current = candidateKey;
  const [answeredCandidateKey, setAnsweredCandidateKey] = useState('');
  useEffect(() => {
    if (definitions.generation > 0) setAnsweredCandidateKey(candidateKeyRef.current);
  }, [definitions.generation]);
  const promptedCandidate = packageCandidate
    && candidateKey !== answeredCandidateKey
    && definitions.state.status !== 'importing'
    ? packageCandidate
    : null;

  // What the Export tab needs beyond the hand-replaced textures: the selected
  // paint's own definitions, and the package textures the compositor read.
  // Both are fetched only when an export actually runs, so opening the tab
  // costs nothing.
  const { exportKit } = definitions;
  const exportDefinitions = useMemo(() => {
    // Which of this paint's textures the mounted package supplies, answered
    // from the recipe rather than from what has been rendered so far, so the
    // count is right the moment the tab opens.
    const pkg = sourceProvider.package;
    const refs = collectTextureRefs(editorRecipes.map((entry) => entry.recipe));
    const supplied = pkg ? resolvePackageTextures(refs, (ref: string) => sourceProvider.packagePathFor(ref)) : [];
    const unresolvedTextureRefs = refs.filter((ref) => {
      if (!sourceTextureIdentity(ref).startsWith('materials/patterns/')) return false;
      if (sourceProvider.packagePathFor(ref)) return false;
      return !data?.manifest.textures?.[ref];
    });
    return {
      isImported: selectedKit ? isCustomKitId(selectedKit.id) : false,
      builtInKits: (data?.manifest.paintkits ?? []).map((kit) => ({ defindex: kit.id, name: kit.name })),
      loadKitMessages: async () => (
        selectedKit && isCustomKitId(selectedKit.id) ? exportKit(selectedKit.id) : null
      ),
      packageFiles: async () => {
        if (!pkg) return [];
        const { collectPackageFiles } = await import('./export/bundle');
        // Files the user replaced by hand win over the package's copy, matching
        // what the viewer is rendering.
        const replaced = new Set(
          Object.keys(activeTextureOverrides).map((ref) => `${sourceTextureIdentity(ref)}.vtf`),
        );
        return collectPackageFiles(
          supplied.map(({ ref, path }) => ({ path, writeAs: exportPathFor(ref) })),
          (path) => pkg.read(path),
          replaced,
        );
      },
      materialFiles: async (overrides: readonly string[]) => {
        if (!pkg) return { files: [], missing: [...overrides], repaired: [] };
        const { collectMaterialFiles } = await import('./export/bundle');
        return collectMaterialFiles(
          overrides,
          (path: string) => sourceProvider.packagePathForFile(path),
          (path: string) => pkg.read(path),
        );
      },
      packageFileCount: supplied.length,
      packageMounted: Boolean(pkg),
      unresolvedTextureRefs,
    };
    // packageGeneration is what marks a mount or removal: the provider keeps
    // its own identity across both, so without it this would keep answering for
    // whatever archive was mounted first.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedKit, exportKit, sourceProvider, packageGeneration, editorRecipes, activeTextureOverrides]);

  const randomizeSeed = useCallback(() => patch({ seed: randomSeed() }), [patch]);

  const onViewAngle = useCallback((id: string) => {
    const preset = VIEW_ANGLES.find((p) => p.id === id) ?? VIEW_ANGLES[0];
    viewerRef.current?.setViewAngle(preset);
  }, []);

  const {
    saveImage: onScreenshot,
    copyImage: onCopyImage,
  } = useScreenshotActions({
    viewerRef,
    paintName: selectedKit?.name,
    weaponKey: state.weaponKey,
    seed: state.seed,
    scale: state.screenshotScale,
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
  const paintIcons: Record<number, string> = { ...definitions.icons };
  for (const kit of data.manifest.paintkits) {
    const url = kit.icon ? data.getAssetUrl(kit.icon) : null;
    if (url) paintIcons[kit.id] = url;
  }

  // selectedKit is set well before boot finishes (it drives the first model
  // load), so the header also waits on the boot overlay itself; otherwise
  // it would flash in over the loading screen.
  const showStageHeader = boot.progress >= 100 && !!selectedKit;
  const weaponName = data.manifest.weapons.find((w) => w.key === state.weaponKey)?.name ?? state.weaponKey;

  const toggleMobilePanel = (panel: MobilePanel) => setMobilePanel((current) => (current === panel ? 'none' : panel));

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
          onPointerDown={() => setHintDismissed(true)}
          onWheel={() => setHintDismissed(true)}
        >
          <canvas ref={canvasRef} className="viewer-canvas" />
          <div className="stage-overlay-tl">
            {showStageHeader && selectedKit && (
              <div className="stage-header">
                <div
                  className="stage-header-name"
                  style={{ color: selectedKit?.grade ? `var(--grade-${selectedKit.grade})` : undefined }}
                >
                  {selectedKit.name}
                </div>
                <div className="stage-header-meta">
                  {selectedKit.collection ?? 'Uncategorized'} - {weaponName}{Object.keys(activeTextureOverrides).length ? ' - Custom files' : ''}
                </div>
              </div>
            )}
            {composing && (
              <div className="composing-badge">
                <span className="composing-badge-spinner" aria-hidden="true" />
                <span>Compositing…</span>
              </div>
            )}
            {cameraMode === 'advanced' && (
              <div className="advanced-camera-badge" role="status">
                <span>Advanced Camera</span>
                <span className="advanced-camera-badge-exit">
                  <kbd>Alt</kbd> to exit
                </span>
              </div>
            )}
          </div>
          <StageToolbar
            workbenchOpen={workbenchOpen}
            onToggleWorkbench={() => {
              setWorkbenchMounted(true);
              setWorkbenchOpen((open) => !open);
            }}
            onSavePng={onScreenshot}
            onCopyImage={onCopyImage}
            onResetView={() => viewerRef.current?.resetView()}
          />
          <div className={`canvas-hint${hintDismissed ? ' dismissed' : ''}`}>
            drag to rotate, scroll to zoom, right-drag to pan, double-click to reset
          </div>
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
          inert={!workbenchOpen}
          style={workbenchHeight ? ({ '--workbench-h': `${workbenchHeight}px` } as CSSProperties) : undefined}
        >
          {workbenchMounted && (
            <Suspense fallback={<div className="custom-workbench-loading">Loading custom files…</div>}>
              <CustomWarpaintWorkbench
                key={`${selectedKitId ?? 'empty'}|${state.weaponKey}`}
                recipes={editorRecipes}
                definitions={definitionsState}
                tab={workbenchTab}
                onTabChange={setWorkbenchTab}
                resolveTexture={data.resolveTexture}
                textureMetadata={data.manifest.textures}
                paintName={selectedKit?.name}
                weaponName={weaponName}
                gameBuild={data.manifest.gameBuild}
                snapshotDate={data.manifest.generatedAt}
                exportDefinitions={exportDefinitions}
                sourcePackage={sourcePackage}
                resolvePackageTexture={resolvePackageTexture}
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
                  setAssetOverrideCache({});
                }}
                // A height of 0 means "back to the default clamp", which is what
                // double-clicking the drawer's resize handle asks for.
                onResize={setWorkbenchHeight}
                onClose={() => setWorkbenchOpen(false)}
              />
            </Suspense>
          )}
        </div>
      </main>
      <aside className="inspector" id="viewer-controls-panel">
        <Inspector
          manifest={data.manifest}
          weaponOptions={weaponOptions}
          hasTeamTextures={selectedKit?.hasTeamTextures ?? false}
          state={state}
          onChange={patch}
          onRandomizeSeed={randomizeSeed}
          onUndoSeed={undoSeed}
          canUndoSeed={canUndoSeed}
          onViewAngle={onViewAngle}
        />
      </aside>
      <nav className="mobile-tabstrip" aria-label="Panels">
        <button
          type="button"
          className="mobile-tab-btn"
          aria-pressed={mobilePanel === 'catalog'}
          onClick={() => toggleMobilePanel('catalog')}
        >
          <Palette size={18} />
          <span>Warpaints</span>
        </button>
        <button
          type="button"
          className="mobile-tab-btn"
          aria-pressed={mobilePanel === 'none'}
          onClick={() => setMobilePanel('none')}
        >
          <Eye size={18} />
          <span>Viewer</span>
        </button>
        <button
          type="button"
          className="mobile-tab-btn"
          aria-pressed={mobilePanel === 'controls'}
          onClick={() => toggleMobilePanel('controls')}
        >
          <SlidersHorizontal size={18} />
          <span>Controls</span>
        </button>
      </nav>
      {boot.progress < 100 && <BootLoader boot={boot} />}
    </div>
  );
}
