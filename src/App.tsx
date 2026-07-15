import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import './App.css';
import type { Viewer } from './viewer/Viewer';
import type { Compositor, ComposeResult } from './compositor/compositor';
import { loadDataSource } from './data/loader';
import type { DataSource } from './data/loader';
import type { PaintkitEntry } from './data/types';
import { WarpaintList } from './ui/WarpaintList';
import { ControlsBar } from './ui/ControlsBar';
import type { ControlsState } from './ui/ControlsBar';

// Selftest page is code-split: it never loads in normal use.
const SelfTestPage = lazy(() => import('./selftest').then((m) => ({ default: m.SelfTestPage })));

const COMPOSE_BADGE_DELAY_MS = 250;
const COMPOSE_CACHE_SIZE = 8;

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

function randomSeed(): number {
  if (globalThis.crypto?.getRandomValues) {
    return globalThis.crypto.getRandomValues(new Uint32Array(1))[0];
  }
  return Math.floor(Math.random() * 0x100000000);
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

  const [data, setData] = useState<DataSource | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const [loadedAssetKey, setLoadedAssetKey] = useState('');
  const [boot, setBoot] = useState<BootState>({ progress: 4, label: 'Loading catalog…' });
  const [state, setState] = useState<ControlsState>(() => ({
    weaponKey: '',
    wearIndex: 0,
    team: 'red',
    seed: randomSeed(),
    preset: 'inspect',
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
        // Auto-select the first paintkit so the canvas is never empty.
        const firstKit = ds.manifest.paintkits[0] ?? null;
        setSelectedKitId(firstKit ? firstKit.id : null);
        setState((s) => ({ ...s, weaponKey: firstKit?.weapons[0] ?? ds.manifest.weapons[0]?.key ?? '' }));
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
      compositor = new CompositorCls(data.resolveTexture, { renderer: viewer.renderer, size: 1024 });
      viewerRef.current = viewer;
      compositorRef.current = compositor;
      setEngineReady(true);
      advanceBoot(34, 'Loading TF2 environment…');
      await viewer.ready();
      if (!disposed) advanceBoot(43, 'Environment ready');
    })();
    return () => {
      disposed = true;
      setEngineReady(false);
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

  // Start the tiny recipe request as soon as selection state changes, in
  // parallel with the lazily imported renderer/model setup.
  useEffect(() => {
    if (!data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) return;
    void data.getRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex);
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

  // Recompose when recipe inputs change: debounced, deduped, and the previous
  // texture stays on the mesh until the new one is ready (no untextured flash).
  useEffect(() => {
    const ds = data;
    if (!engineReady || !ds || !selectedKit || !state.weaponKey || loadedAssetKey !== selectedAssetKey) return;
    if (!selectedKit.weapons.includes(state.weaponKey)) return;

    const composeKey = `${ds.kind}|${selectedKit.id}|${state.weaponKey}|${state.team}|${state.wearIndex}|${state.seed}`;
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
        const recipe = await ds.getRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex);
        if (cancelled) return;
        if (!recipe) {
          console.warn(`[warpaint-viewer] no recipe for ${composeKey}`);
          if (!firstPaintLoggedRef.current) setError('The initial warpaint recipe is missing.');
          return;
        }
        if (!firstPaintLoggedRef.current) {
          advanceBoot(70, 'Decoding paint textures…');
          await comp.preload(recipe);
          if (cancelled) return;
          advanceBoot(86, 'Composing initial warpaint…');
        }
        // TF2 selects the complete paint-kit recipe for the wear category; it
        // does not crossfade that result with Factory New.
        const result = await comp.compose(recipe, state.seed);
        if (cancelled) {
          comp.releaseResult(result);
          return;
        }
        viewer.setMap(result.texture);
        cacheResult(composeKey, result, comp);
        lastResultRef.current = result;
        lastComposeKeyRef.current = composeKey;
        const dt = performance.now() - t0;
        console.log(`[perf] compose ${composeKey} in ${dt.toFixed(1)}ms`);
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
            const warmed = await comp.compose(variantRecipe, state.seed);
            if (cancelled) { comp.releaseResult(warmed); return; }
            cacheResult(key, warmed, comp);
          }
          firstPaintLoggedRef.current = true;
          advanceBoot(100, 'Ready');
          console.log(`[perf] first painted weapon at ${performance.now().toFixed(0)}ms since navigation`);
          // ?perftest=1: exercise warm recomposites (seed changes) automatically
          // so headless runs can measure them without interaction.
          if (new URLSearchParams(window.location.search).get('perftest') === '1') {
            let n = 0;
            const iv = window.setInterval(() => {
              n += 1;
              if (n > 3) {
                window.clearInterval(iv);
                return;
              }
              setState((s) => ({ ...s, seed: s.seed + 1 }));
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
              const warmed = await comp.compose(variantRecipe, state.seed);
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
  }, [engineReady, data, selectedKit, selectedAssetKey, loadedAssetKey, state.weaponKey, state.team, state.wearIndex, state.seed, advanceBoot]);

  const patch = useCallback((p: Partial<ControlsState>) => setState((s) => ({ ...s, ...p })), []);

  const onSelectKit = useCallback(
    (id: number) => {
      setSelectedKitId(id);
      const kit = data?.manifest.paintkits.find((p) => p.id === id);
      const next: Partial<ControlsState> = {};
      if (kit && !kit.weapons.includes(state.weaponKey)) {
        next.weaponKey = kit.weapons[0] ?? state.weaponKey;
      }
      if (kit && !kit.hasTeamTextures) next.team = 'red';
      patch(next);
    },
    [data, state.weaponKey, patch],
  );

  const randomizeSeed = useCallback(() => patch({ seed: randomSeed() }), [patch]);

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

  return (
    <div className="app">
      <aside className="sidebar">
        <WarpaintList
          paintkits={data.manifest.paintkits}
          selectedId={selectedKitId}
          onSelect={onSelectKit}
          collectionIcons={collectionIcons}
        />
      </aside>
      <main className="stage">
        <div className="canvas-wrap">
          <canvas ref={canvasRef} className="viewer-canvas" />
          {composing && <div className="composing-badge">compositing...</div>}
        </div>
        <div className="canvas-hint">drag to rotate, scroll to zoom, right-drag to pan, double-click to reset</div>
        <ControlsBar
          manifest={data.manifest}
          weaponOptions={weaponOptions}
          hasTeamTextures={selectedKit?.hasTeamTextures ?? false}
          state={state}
          onChange={patch}
          onRandomizeSeed={randomizeSeed}
          onResetView={() => viewerRef.current?.resetView()}
        />
      </main>
      {boot.progress < 100 && <BootLoader boot={boot} />}
    </div>
  );
}
