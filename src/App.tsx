import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Eye, Palette, SlidersHorizontal } from 'lucide-react';
import './ui/WarpaintList.css';
import './ui/StageToolbar.css';
import './ui/Inspector.css';
import './styles/stage.css';
import './styles/layout.css';
import type { Viewer } from './viewer/Viewer';
import type { Compositor } from './compositor/compositor';
import type { PaintkitEntry } from './data/types';
import { WarpaintList } from './ui/WarpaintList';
import { Inspector } from './ui/Inspector';
import type { ControlsState } from './ui/Inspector';
import { StageToolbar } from './ui/StageToolbar';
import type { WarpaintAssetOverrides, WearRecipe } from './ui/CustomWarpaintImport';
import { BootLoader } from './ui/BootLoader';
import { VIEW_ANGLES } from './viewer/presets';
import { useBootData, randomSeed } from './hooks/useBootData';
import { useComposedPaint } from './hooks/useComposedPaint';
import { useSourcePackage } from './hooks/useSourcePackage';

// Selftest page is code-split: it never loads in normal use.
const SelfTestPage = lazy(() => import('./dev/selftest').then((m) => ({ default: m.SelfTestPage })));
// The custom-file UI includes texture decoders and a large interactive editor.
// It is not needed to view a paint, so mount it only after the drawer opens.
const CustomWarpaintWorkbench = lazy(() => import('./ui/CustomWarpaintImport').then((m) => ({ default: m.CustomWarpaintWorkbench })));

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
  const [editorRecipes, setEditorRecipes] = useState<WearRecipe[]>([]);
  const [editorLoading, setEditorLoading] = useState(false);
  const [assetOverrideCache, setAssetOverrideCache] = useState<Record<string, WarpaintAssetOverrides>>({});
  const [catalogVisible, setCatalogVisible] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [hintDismissed, setHintDismissed] = useState(false);
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

  const selectedKit: PaintkitEntry | null =
    data && selectedKitId != null ? data.manifest.paintkits.find((p) => p.id === selectedKitId) ?? null : null;
  const selectedAssetKey = selectedKit && state.weaponKey ? `${selectedKit.id}|${state.weaponKey}` : '';
  // Artwork refs are shared by a paintkit even when its weapon recipe changes.
  // Keep one edit set per paintkit so imported textures follow weapon changes;
  // recipe-specific refs that do not exist on the next weapon are simply unused.
  const assetOverrideScope = selectedKit ? String(selectedKit.id) : '';
  const assetOverrides = assetOverrideCache[assetOverrideScope] ?? EMPTY_OVERRIDES;
  const { provider: sourceProvider, sourcePackage, packageGeneration, suggestedPaintkitId, removePackage } = useSourcePackage(
    data?.resolveTexture ?? ((ref) => ref),
    () => setAssetOverrideCache({}),
  );

  // A numeric ZIP wrapper is a conventional paintkit index. Switch only when
  // it resolves to a real catalog entry; unknown numbers leave selection alone.
  useEffect(() => {
    if (!data || suggestedPaintkitId === undefined) return;
    const kit = data.manifest.paintkits.find((entry) => entry.id === suggestedPaintkitId);
    if (!kit) return;
    setSelectedKitId(kit.id);
    setState((current) => ({
      ...current,
      weaponKey: kit.weapons.includes(current.weaponKey) ? current.weaponKey : (kit.weapons[0] ?? current.weaponKey),
      team: kit.hasTeamTextures || current.sheen === 'team_shine' ? current.team : 'red',
    }));
  }, [data, packageGeneration, suggestedPaintkitId]);
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
      viewer?.dispose();
      viewerRef.current = null;
      compositorRef.current = null;
    };
  }, [data, advanceBoot, disposeCache, sourceProvider]);

  // Custom files only live in memory. Let the browser warn before a refresh,
  // tab close, or navigation would discard any cached edit set.
  useEffect(() => {
    const hasCachedEdits = Object.values(assetOverrideCache).some((entry) => Object.keys(entry.assets).length > 0);
    if (!hasCachedEdits && sourcePackage.status !== 'mounted') return;
    const confirmLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', confirmLoss);
    return () => window.removeEventListener('beforeunload', confirmLoss);
  }, [assetOverrideCache, sourcePackage.status]);

  // A blank catalog selection has no model/paint work to wait for. Once the
  // renderer environment is ready, the intentionally empty stage is ready too.
  useEffect(() => {
    if (environmentReady && !selectedKit) advanceBoot(100, 'Ready');
  }, [environmentReady, selectedKit, advanceBoot]);

  // Start the tiny recipe request as soon as selection state changes, in
  // parallel with the lazily imported renderer/model setup.
  useEffect(() => {
    if (!data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) return;
    void data.getRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex);
  }, [data, selectedKit, state.weaponKey, state.team, state.wearIndex]);

  // The editor lists every input the paint can use, not just the ones the
  // current wear happens to reach: per-wear recipes swap in dirt/blood/
  // scratch/burnt-albedo textures at some levels only, and those inputs must
  // stay editable whatever the wear slider says. Bundles are cached, so the
  // extra wear levels cost no extra requests.
  useEffect(() => {
    if (!data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) {
      setEditorRecipes([]);
      setEditorLoading(false);
      return;
    }
    let cancelled = false;
    setEditorLoading(true);
    const wearIndexes = selectedKit.perWear
      ? data.manifest.wearLevels.map((_, index) => index)
      : [state.wearIndex];
    void Promise.all(
      wearIndexes.map((wearIndex) => data
        .getRecipe(selectedKit, state.weaponKey, state.team, wearIndex)
        .then((recipe) => ({ wearIndex, recipe }))),
    ).then((loaded) => {
      if (cancelled) return;
      setEditorRecipes(loaded.flatMap(({ wearIndex, recipe }) => recipe ? [{ wearIndex, recipe }] : []));
    }).finally(() => {
      if (!cancelled) setEditorLoading(false);
    });
    return () => { cancelled = true; };
  }, [data, selectedKit, state.weaponKey, state.team, state.wearIndex]);

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
    const material = (overrideId && data.manifest.materials?.[overrideId]) || weapon.material;
    void Promise.all([
      viewer.ready(),
      viewer.loadModel(data.getModelUrl(state.weaponKey)),
      viewer.applyMaterialParams(material, (ref) => sourceProvider.resolve(ref)),
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
  useEffect(() => {
    compositorRef.current?.invalidateTextures();
    disposeCache();
    resetComposeKey();
  }, [packageGeneration, disposeCache, resetComposeKey]);

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
      const kit = data?.manifest.paintkits.find((p) => p.id === id);
      const next: Partial<ControlsState> = {};
      if (kit && !kit.weapons.includes(state.weaponKey)) {
        next.weaponKey = kit.weapons[0] ?? state.weaponKey;
      }
      // Team Shine is the one sheen with a per-team color, so the team choice
      // stays meaningful (and selectable) even on single-team warpaints.
      if (kit && !kit.hasTeamTextures && state.sheen !== 'team_shine') next.team = 'red';
      patch(next);
    },
    [data, state.weaponKey, state.sheen, patch],
  );

  const randomizeSeed = useCallback(() => patch({ seed: randomSeed() }), [patch]);

  const onViewAngle = useCallback((id: string) => {
    const preset = VIEW_ANGLES.find((p) => p.id === id) ?? VIEW_ANGLES[0];
    viewerRef.current?.setViewAngle(preset);
  }, []);

  // Save/Copy image/Copy link are called from StageToolbar, which wraps each
  // in its own try/catch (console.error + a brief X on failure) and drives a
  // shared "capturing" state for the two that hit the viewer's capture path;
  // these just do the work and let failures propagate.
  const onScreenshot = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Viewer not ready');
    const blob = await viewer.captureScreenshot(state.screenshotScale);
    const kitName = selectedKit?.name
      ? selectedKit.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      : '';
    const filename = `${kitName || 'warpaint'}_${state.weaponKey}_seed${state.seed}.png`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [selectedKit, state.weaponKey, state.seed, state.screenshotScale]);

  const onCopyImage = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Viewer not ready');
    const blob = await viewer.captureScreenshot(state.screenshotScale);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, [state.screenshotScale]);

  const onCopyLink = useCallback(async () => {
    await navigator.clipboard.writeText(location.href);
  }, []);

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

  const paintIcons: Record<number, string> = {};
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
      <aside className="sidebar">
        <WarpaintList
          paintkits={data.manifest.paintkits}
          selectedId={selectedKitId}
          onSelect={onSelectKit}
          collectionIcons={collectionIcons}
          paintIcons={paintIcons}
        />
      </aside>
      <main className="stage">
        <div
          className="canvas-wrap"
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
          </div>
          <StageToolbar
            catalogVisible={catalogVisible}
            controlsVisible={controlsVisible}
            workbenchOpen={workbenchOpen}
            onToggleWorkbench={() => {
              setWorkbenchMounted(true);
              setWorkbenchOpen((open) => !open);
            }}
            onToggleCatalog={() => setCatalogVisible((visible) => !visible)}
            onToggleControls={() => setControlsVisible((visible) => !visible)}
            onSavePng={onScreenshot}
            onCopyImage={onCopyImage}
            onCopyLink={onCopyLink}
            onResetView={() => viewerRef.current?.resetView()}
          />
          <div className={`canvas-hint${hintDismissed ? ' dismissed' : ''}`}>
            drag to rotate, scroll to zoom, right-drag to pan, double-click to reset
          </div>
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
                resolveTexture={data.resolveTexture}
                textureMetadata={data.manifest.textures}
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
      <aside className="inspector">
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
