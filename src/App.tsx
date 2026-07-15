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

// Coalesce rapid seed/wear scrubs into one composite.
const COMPOSE_DEBOUNCE_MS = 120;

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
  const lastComposeKeyRef = useRef<string>('');
  const firstPaintLoggedRef = useRef(false);

  const [data, setData] = useState<DataSource | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedKitId, setSelectedKitId] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const [state, setState] = useState<ControlsState>({
    weaponKey: '',
    wearIndex: 0,
    team: 'red',
    seed: 1234567,
    preset: 'inspect',
    exposure: 1,
  });

  // Load data source once (manifest only; recipes/textures load on demand).
  useEffect(() => {
    let cancelled = false;
    loadDataSource()
      .then((ds) => {
        if (cancelled) return;
        setData(ds);
        // Auto-select the first paintkit so the canvas is never empty.
        const firstKit = ds.manifest.paintkits[0] ?? null;
        setSelectedKitId(firstKit ? firstKit.id : null);
        setState((s) => ({ ...s, weaponKey: firstKit?.weapons[0] ?? ds.manifest.weapons[0]?.key ?? '' }));
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, []);

  // Set up viewer + compositor on the canvas. The three.js stack is dynamically
  // imported so it lands in its own chunk and the UI shell paints first.
  useEffect(() => {
    if (!canvasRef.current || !data) return;
    let disposed = false;
    let viewer: Viewer | null = null;
    let compositor: Compositor | null = null;
    (async () => {
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
    })();
    return () => {
      disposed = true;
      setEngineReady(false);
      lastComposeKeyRef.current = '';
      if (lastResultRef.current) {
        lastResultRef.current.target.dispose();
        lastResultRef.current = null;
      }
      compositor?.dispose();
      viewer?.dispose();
      viewerRef.current = null;
      compositorRef.current = null;
    };
  }, [data]);

  const selectedKit: PaintkitEntry | null =
    data && selectedKitId != null ? data.manifest.paintkits.find((p) => p.id === selectedKitId) ?? null : null;

  // Load the model when the weapon changes.
  useEffect(() => {
    if (!engineReady || !data || !viewerRef.current || !state.weaponKey) return;
    const weapon = data.manifest.weapons.find((w) => w.key === state.weaponKey);
    viewerRef.current.loadModel(data.getModelUrl(state.weaponKey));
    if (weapon) viewerRef.current.applyMaterialParams(weapon.material);
  }, [engineReady, data, state.weaponKey]);

  // Lighting + exposure.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setLighting(state.preset);
  }, [engineReady, state.preset]);
  useEffect(() => {
    if (engineReady) viewerRef.current?.setExposure(state.exposure);
  }, [engineReady, state.exposure]);

  // Recompose when recipe inputs change: debounced, deduped, and the previous
  // texture stays on the mesh until the new one is ready (no untextured flash).
  useEffect(() => {
    const ds = data;
    if (!engineReady || !ds || !selectedKit || !state.weaponKey) return;
    if (!selectedKit.weapons.includes(state.weaponKey)) return;

    const composeKey = `${ds.kind}|${selectedKit.id}|${state.weaponKey}|${state.team}|${state.wearIndex}|${state.seed}`;
    if (composeKey === lastComposeKeyRef.current) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const comp = compositorRef.current;
      const viewer = viewerRef.current;
      if (cancelled || !comp || !viewer) return;
      setComposing(true);
      const t0 = performance.now();
      try {
        const recipe = await ds.getRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex);
        if (cancelled) return;
        if (!recipe) {
          console.warn(`[warpaint-viewer] no recipe for ${composeKey}`);
          return;
        }
        const result = await comp.compose(recipe, state.seed);
        if (cancelled) {
          comp.releaseResult(result);
          return;
        }
        viewer.setMap(result.texture);
        if (lastResultRef.current) comp.releaseResult(lastResultRef.current);
        lastResultRef.current = result;
        lastComposeKeyRef.current = composeKey;
        const dt = performance.now() - t0;
        console.log(`[perf] compose ${composeKey} in ${dt.toFixed(1)}ms`);
        if (!firstPaintLoggedRef.current) {
          firstPaintLoggedRef.current = true;
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
      } catch (e) {
        console.error('[warpaint-viewer] compose failed:', e);
      } finally {
        if (!cancelled) setComposing(false);
      }
    }, COMPOSE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [engineReady, data, selectedKit, state.weaponKey, state.team, state.wearIndex, state.seed]);

  const patch = useCallback((p: Partial<ControlsState>) => setState((s) => ({ ...s, ...p })), []);

  const onSelectKit = useCallback(
    (id: number) => {
      setSelectedKitId(id);
      const kit = data?.manifest.paintkits.find((p) => p.id === id);
      if (kit && !kit.weapons.includes(state.weaponKey)) {
        patch({ weaponKey: kit.weapons[0] ?? state.weaponKey });
      }
    },
    [data, state.weaponKey, patch],
  );

  const randomizeSeed = useCallback(() => patch({ seed: Math.floor(Math.random() * 0xffffffff) }), [patch]);

  if (error) return <div className="fatal">Failed to start: {error}</div>;
  if (!data) return <div className="loading">Loading warpaints...</div>;

  const weaponOptions = (selectedKit?.weapons ?? data.manifest.weapons.map((w) => w.key)).map((key) => ({
    value: key,
    label: data.manifest.weapons.find((w) => w.key === key)?.name ?? key,
  }));

  return (
    <div className="app">
      <aside className="sidebar">
        <WarpaintList
          paintkits={data.manifest.paintkits}
          selectedId={selectedKitId}
          onSelect={onSelectKit}
        />
      </aside>
      <main className="stage">
        <div className="canvas-wrap">
          <canvas ref={canvasRef} className="viewer-canvas" />
          {composing && <div className="composing-badge">compositing...</div>}
          <div className="source-badge">{data.kind === 'mock' ? 'MOCK DATA' : 'live data'}</div>
        </div>
        <div className="canvas-hint">drag to rotate, scroll to zoom, right-drag to pan, double-click to reset</div>
        <ControlsBar
          manifest={data.manifest}
          weaponOptions={weaponOptions}
          state={state}
          onChange={patch}
          onRandomizeSeed={randomizeSeed}
          onResetView={() => viewerRef.current?.resetView()}
        />
      </main>
    </div>
  );
}
