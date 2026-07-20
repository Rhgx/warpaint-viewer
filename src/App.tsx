import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Palette, SlidersHorizontal } from 'lucide-react';
import './App.css';
import type { Viewer } from './viewer/Viewer';
import type { Compositor, ComposeResult } from './compositor/compositor';
import type { RecipeNode } from './compositor/types';
import { loadDataSource } from './data/loader';
import type { DataSource } from './data/loader';
import type { PaintkitEntry } from './data/types';
import { WarpaintList } from './ui/WarpaintList';
import { Inspector } from './ui/Inspector';
import type { ControlsState } from './ui/Inspector';
import { StageToolbar } from './ui/StageToolbar';
import { CustomWarpaintWorkbench } from './ui/CustomWarpaintImport';
import type { WarpaintAssetOverrides } from './ui/CustomWarpaintImport';
import { VIEW_ANGLES } from './viewer/presets';
import { parseUrlState, serializeUrlState } from './urlState';

// Selftest page is code-split: it never loads in normal use.
const SelfTestPage = lazy(() => import('./dev/selftest').then((m) => ({ default: m.SelfTestPage })));

const COMPOSE_BADGE_DELAY_MS = 250;
const COMPOSE_CACHE_SIZE = 8;
const DEFAULT_WEAPON_KEY = 'c_rocketlauncher';
const URL_SYNC_DEBOUNCE_MS = 300;
const SEED_HISTORY_CAP = 20;

const EMPTY_OVERRIDES: WarpaintAssetOverrides = { revision: 0, assets: {} };

function applyTextureOverrides(node: RecipeNode, textures: Record<string, string>): RecipeNode {
  switch (node.type) {
    case 'texture_lookup':
      return textures[node.texture] ? { ...node, texture: textures[node.texture] } : node;
    case 'select':
      return textures[node.groups] ? { ...node, groups: textures[node.groups] } : node;
    case 'apply_sticker':
      return {
        ...node,
        stickers: node.stickers.map((sticker) => ({
          ...sticker,
          base: textures[sticker.base] ?? sticker.base,
          spec: sticker.spec ? textures[sticker.spec] ?? sticker.spec : undefined,
        })),
        nodes: node.nodes.map((child) => applyTextureOverrides(child, textures)),
      };
    default:
      return { ...node, nodes: node.nodes.map((child) => applyTextureOverrides(child, textures)) };
  }
}

type MobilePanel = 'none' | 'catalog' | 'controls';

interface BootState {
  progress: number;
  label: string;
}

function BootLoader({ boot }: { boot: BootState }) {
  return (
    <div className="boot-loader" role="status" aria-live="polite">
      <div className="boot-loader-card">
        <div className="boot-loader-title">Loading TF2 Warpaints</div>
        <div className="boot-loader-track" aria-label={boot.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={boot.progress} role="progressbar">
          <div className="boot-loader-fill" style={{ width: `${boot.progress}%` }} />
        </div>
        <div className="boot-loader-meta">
          <span>{boot.label}</span>
          <span>{Math.round(boot.progress)}%</span>
        </div>
      </div>
    </div>
  );
}

function randomSeed(): string {
  if (globalThis.crypto?.getRandomValues) {
    const words = globalThis.crypto.getRandomValues(new Uint32Array(2));
    return ((BigInt(words[0]) << 32n) | BigInt(words[1])).toString();
  }
  const hi = BigInt(Math.floor(Math.random() * 0x100000000));
  const lo = BigInt(Math.floor(Math.random() * 0x100000000));
  return ((hi << 32n) | lo).toString();
}

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
  const lastResultRef = useRef<ComposeResult | null>(null);
  const composeCacheRef = useRef(new Map<string, ComposeResult>());
  const lastComposeKeyRef = useRef<string>('');
  const firstPaintLoggedRef = useRef(false);
  // Guards the URL-sync effect: it must not fire until the boot effect below
  // has applied any URL-provided selection to state, or it would immediately
  // clobber the incoming URL with the pre-boot placeholder defaults.
  const bootSelectionAppliedRef = useRef(false);
  const seedHistoryRef = useRef<string[]>([]);

  const [data, setData] = useState<DataSource | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [environmentReady, setEnvironmentReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [workbenchMounted, setWorkbenchMounted] = useState(false);
  const [editorRecipe, setEditorRecipe] = useState<RecipeNode | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [assetOverrideCache, setAssetOverrideCache] = useState<Record<string, WarpaintAssetOverrides>>({});
  const [catalogVisible, setCatalogVisible] = useState(true);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [composing, setComposing] = useState(false);
  const [hintDismissed, setHintDismissed] = useState(false);
  const [loadedAssetKey, setLoadedAssetKey] = useState('');
  const [boot, setBoot] = useState<BootState>({ progress: 4, label: 'Loading catalog…' });
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

  const advanceBoot = useCallback((progress: number, label: string) => {
    setBoot((current) => progress > current.progress ? { progress, label } : current);
  }, []);

  // Load data source once (manifest only; recipes/textures load on demand).
  useEffect(() => {
    let cancelled = false;
    loadDataSource()
      .then((ds) => {
        if (cancelled) return;
        setData(ds);
        advanceBoot(16, 'Catalog ready');

        // The URL is parsed exactly once, right here, and only ever applied
        // on top of the catalog's own defaults below; every param is
        // optional and independently falls back if missing or invalid.
        const url = parseUrlState(window.location.search, window.location.hash);

        // Start empty unless a valid shared-link selection was requested.
        // Unknown kit ids also remain empty instead of silently selecting a
        // different item from the catalog.
        const urlKit = url.kitId != null ? ds.manifest.paintkits.find((p) => p.id === url.kitId) ?? null : null;
        const kit = urlKit;

        let weaponKey = kit?.weapons.includes(DEFAULT_WEAPON_KEY)
          ? DEFAULT_WEAPON_KEY
          : kit?.weapons[0] ?? '';
        if (url.weaponKey && kit?.weapons.includes(url.weaponKey)) weaponKey = url.weaponKey;

        setSelectedKitId(kit?.id ?? null);
        setState((s) => ({
          ...s,
          weaponKey,
          seed: url.seed ?? s.seed,
          wearIndex: url.wearIndex ?? s.wearIndex,
          team: url.team ?? s.team,
          sheen: url.sheen ?? s.sheen,
          unusual: url.unusual ?? s.unusual,
          preset: url.preset ?? s.preset,
          projection: url.projection ?? s.projection,
          fov: url.fov ?? s.fov,
        }));
        // From here on the URL-sync effect is free to start writing back.
        bootSelectionAppliedRef.current = true;
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [advanceBoot]);

  // Set up viewer + compositor on the canvas. The three.js stack is dynamically
  // imported so it lands in its own chunk and the UI shell paints first.
  useEffect(() => {
    if (!canvasRef.current || !data) return;
    const composeCache = composeCacheRef.current;
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
      compositor = new CompositorCls(data.resolveTexture, {
        renderer: viewer.renderer,
        size: 1024,
        textureMetadata: data.manifest.textures,
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
      lastComposeKeyRef.current = '';
      for (const result of new Set(composeCache.values())) result.target.dispose();
      composeCache.clear();
      lastResultRef.current = null;
      compositor?.dispose();
      viewer?.dispose();
      viewerRef.current = null;
      compositorRef.current = null;
    };
  }, [data, advanceBoot]);

  const selectedKit: PaintkitEntry | null =
    data && selectedKitId != null ? data.manifest.paintkits.find((p) => p.id === selectedKitId) ?? null : null;
  const selectedAssetKey = selectedKit && state.weaponKey ? `${selectedKit.id}|${state.weaponKey}` : '';
  const assetOverrideScope = selectedAssetKey;
  const assetOverrides = assetOverrideCache[assetOverrideScope] ?? EMPTY_OVERRIDES;
  const activeTextureOverrides = useMemo(
    () => Object.fromEntries(
      Object.entries(assetOverrides.assets).flatMap(([ref, asset]) => asset.output ? [[ref, asset.output]] : []),
    ),
    [assetOverrides],
  );

  // Custom files only live in memory. Let the browser warn before a refresh,
  // tab close, or navigation would discard any cached edit set.
  useEffect(() => {
    const hasCachedEdits = Object.values(assetOverrideCache).some((entry) => Object.keys(entry.assets).length > 0);
    if (!hasCachedEdits) return;
    const confirmLoss = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', confirmLoss);
    return () => window.removeEventListener('beforeunload', confirmLoss);
  }, [assetOverrideCache]);

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

  useEffect(() => {
    if (!data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) {
      setEditorRecipe(null);
      setEditorLoading(false);
      return;
    }
    let cancelled = false;
    setEditorLoading(true);
    void data.getRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex).then((recipe) => {
      if (!cancelled) setEditorRecipe(recipe);
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
      viewer.applyMaterialParams(material, data.resolveTexture),
    ]).then(() => {
      if (cancelled) return;
      setLoadedAssetKey(selectedAssetKey);
      advanceBoot(62, 'Weapon and material maps ready');
    }).catch((e) => {
      if (!cancelled) setError(`Failed to load weapon assets: ${String(e)}`);
    });
    return () => { cancelled = true; };
  }, [engineReady, data, selectedKit, selectedAssetKey, state.weaponKey, advanceBoot]);

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

  // Mirror the shareable bits of state into the URL (debounced, no
  // navigation) so the current view can be copied and reopened. Skipped
  // entirely until the boot effect above has applied any incoming URL
  // params, or this would immediately overwrite them with pre-boot defaults.
  useEffect(() => {
    if (!bootSelectionAppliedRef.current) return;
    const handle = window.setTimeout(() => {
      const urlState = serializeUrlState(window.location.search, {
        kitId: selectedKitId,
        weaponKey: state.weaponKey,
        seed: state.seed,
        wearIndex: state.wearIndex,
        team: state.team,
        sheen: state.sheen,
        unusual: state.unusual,
        preset: state.preset,
        projection: state.projection,
        fov: state.fov,
      });
      const url = `${window.location.pathname}${urlState.search}${urlState.hash}`;
      window.history.replaceState(null, '', url);
    }, URL_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    selectedKitId, state.weaponKey, state.seed, state.wearIndex, state.team,
    state.sheen, state.unusual, state.preset, state.projection, state.fov,
  ]);

  // Recompose when recipe inputs change: debounced, deduped, and the previous
  // texture stays on the mesh until the new one is ready (no untextured flash).
  useEffect(() => {
    const ds = data;
    if (!engineReady || !ds || !selectedKit || !state.weaponKey || loadedAssetKey !== selectedAssetKey) return;
    if (!selectedKit.weapons.includes(state.weaponKey)) return;
    const weapon = ds.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    const dimensions = {
      width: weapon?.compositeWidth ?? 1024,
      height: weapon?.compositeHeight ?? 1024,
    };

    const composeKey = `${ds.kind}|${selectedKit.id}|${state.weaponKey}|${state.team}|${state.wearIndex}|${state.seed}|files:${assetOverrides.revision}`;
    if (composeKey === lastComposeKeyRef.current) return;

    let cancelled = false;
    let badgeTimer = 0;
    let prewarmTimer = 0;

    const cacheResult = (key: string, result: ComposeResult, comp: Compositor) => {
      const cache = composeCacheRef.current;
      const old = cache.get(key);
      if (old && old !== result) comp.releaseResult(old);
      cache.delete(key);
      cache.set(key, result);
      while (cache.size > COMPOSE_CACHE_SIZE) {
        const victim = [...cache.keys()].find((candidate) => candidate !== lastComposeKeyRef.current && candidate !== key);
        if (!victim) break;
        const evicted = cache.get(victim);
        cache.delete(victim);
        if (evicted) comp.releaseResult(evicted);
      }
    };

    const likelyVariants = () => {
      const variants: Array<{ team: ControlsState['team']; wear: number }> = [];
      if (Object.keys(activeTextureOverrides).length) return variants;
      if (selectedKit.perWear) {
        for (let wear = 0; wear < 5; wear++) if (wear !== state.wearIndex) variants.push({ team: state.team, wear });
      }
      if (selectedKit.hasTeamTextures) variants.push({ team: state.team === 'red' ? 'blu' : 'red', wear: state.wearIndex });
      return variants;
    };

    const timer = window.setTimeout(async () => {
      const comp = compositorRef.current;
      const viewer = viewerRef.current;
      if (cancelled || !comp || !viewer) return;

      const cached = composeCacheRef.current.get(composeKey);
      if (cached) {
        composeCacheRef.current.delete(composeKey);
        composeCacheRef.current.set(composeKey, cached);
        viewer.setMap(cached.texture);
        lastResultRef.current = cached;
        lastComposeKeyRef.current = composeKey;
        setComposing(false);
        return;
      }

      // Warm compositions normally finish without showing any loading UI.
      // Preserve feedback for genuinely cold/network-bound requests only.
      badgeTimer = window.setTimeout(() => {
        if (!cancelled) setComposing(true);
      }, COMPOSE_BADGE_DELAY_MS);
      const t0 = performance.now();
      try {
        const sourceRecipe = await ds.getRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex);
        if (cancelled) return;
        if (!sourceRecipe) {
          console.warn(`[warpaint-viewer] no recipe for ${composeKey}`);
          if (!firstPaintLoggedRef.current) setError('The initial warpaint recipe is missing.');
          return;
        }
        const recipe = applyTextureOverrides(sourceRecipe, activeTextureOverrides);
        if (!firstPaintLoggedRef.current) {
          advanceBoot(70, 'Decoding paint textures…');
          await comp.preload(recipe);
          if (cancelled) return;
          advanceBoot(86, 'Composing initial warpaint…');
        }
        // TF2 selects the complete paint-kit recipe for the wear category; it
        // does not crossfade that result with Factory New.
        const result = await comp.compose(recipe, state.seed, dimensions);
        if (cancelled) {
          comp.releaseResult(result);
          return;
        }
        viewer.setMap(result.texture);
        cacheResult(composeKey, result, comp);
        lastResultRef.current = result;
        lastComposeKeyRef.current = composeKey;
        const dt = performance.now() - t0;
        if (import.meta.env.DEV) console.log(`[perf] compose ${composeKey} in ${dt.toFixed(1)}ms`);
        if (!firstPaintLoggedRef.current) {
          const variants = likelyVariants();
          for (let i = 0; i < variants.length; i++) {
            const variant = variants[i];
            const key = `${ds.kind}|${selectedKit.id}|${state.weaponKey}|${variant.team}|${variant.wear}|${state.seed}`;
            const variantRecipe = await ds.getRecipe(selectedKit, state.weaponKey, variant.team, variant.wear);
            if (cancelled) return;
            if (!variantRecipe) continue;
            advanceBoot(88 + ((i + 1) / Math.max(1, variants.length)) * 10, 'Preparing wear and team variants…');
            await comp.preload(variantRecipe);
            if (cancelled) return;
            const warmed = await comp.compose(variantRecipe, state.seed, dimensions);
            if (cancelled) { comp.releaseResult(warmed); return; }
            cacheResult(key, warmed, comp);
          }
          firstPaintLoggedRef.current = true;
          advanceBoot(100, 'Ready');
          if (import.meta.env.DEV) console.log(`[perf] first painted weapon at ${performance.now().toFixed(0)}ms since navigation`);
          // ?perftest=1: exercise warm recomposites (seed changes) automatically
          // so headless runs can measure them without interaction.
          if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('perftest') === '1') {
            let n = 0;
            const iv = window.setInterval(() => {
              n += 1;
              if (n > 3) {
                window.clearInterval(iv);
                return;
              }
              setState((s) => ({ ...s, seed: BigInt.asUintN(64, BigInt(s.seed) + 1n).toString() }));
            }, 800);
          }
        }

        // Once the requested paint is visible, use otherwise-idle time to
        // decode/upload and compose the variants users are most likely to pick
        // next. They remain as GPU textures in a small LRU, making wear/team
        // toggles a setMap() call rather than another visible composition.
        prewarmTimer = window.setTimeout(() => {
          void (async () => {
            for (const variant of likelyVariants()) {
              if (cancelled || compositorRef.current !== comp) return;
              const key = `${ds.kind}|${selectedKit.id}|${state.weaponKey}|${variant.team}|${variant.wear}|${state.seed}`;
              if (composeCacheRef.current.has(key)) continue;
              const variantRecipe = await ds.getRecipe(selectedKit, state.weaponKey, variant.team, variant.wear);
              if (!variantRecipe || cancelled) return;
              await comp.preload(variantRecipe);
              if (cancelled) return;
              // One warmed composite per frame keeps camera interaction smooth.
              await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
              if (cancelled) return;
              const warmed = await comp.compose(variantRecipe, state.seed, dimensions);
              if (cancelled || compositorRef.current !== comp) {
                comp.releaseResult(warmed);
                return;
              }
              cacheResult(key, warmed, comp);
            }
          })();
        }, 50);
      } catch (e) {
        console.error('[warpaint-viewer] compose failed:', e);
        if (!firstPaintLoggedRef.current) setError(`Failed to prepare initial warpaint: ${String(e)}`);
      } finally {
        window.clearTimeout(badgeTimer);
        if (!cancelled) setComposing(false);
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.clearTimeout(badgeTimer);
      window.clearTimeout(prewarmTimer);
    };
  }, [engineReady, data, selectedKit, selectedAssetKey, loadedAssetKey, state.weaponKey, state.team, state.wearIndex, state.seed, assetOverrides, activeTextureOverrides, advanceBoot]);

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
        <div className="custom-workbench-slot" data-open={workbenchOpen ? '' : undefined} aria-hidden={!workbenchOpen}>
          {workbenchMounted && (
            <CustomWarpaintWorkbench
              key={`${selectedKitId ?? 'empty'}|${state.weaponKey}`}
              recipe={editorRecipe}
              resolveTexture={data.resolveTexture}
              loading={editorLoading}
              initialOverrides={assetOverrides}
              onChange={(overrides) => {
                lastComposeKeyRef.current = '';
                setAssetOverrideCache((cache) => ({ ...cache, [assetOverrideScope]: overrides }));
              }}
              onClose={() => setWorkbenchOpen(false)}
            />
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
