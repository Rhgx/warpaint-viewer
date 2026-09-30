import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Viewer } from '../viewer/Viewer';
import type { Compositor } from '../compositor/compositor';
import type { ResolveRecipe } from './useComposedPaint';
import type { DataSource } from '../data/loader';
import type { PaintkitEntry } from '../data/types';
import type { SourceTextureProvider } from '../source/provider';
import { stockMaterialCubemapUrls } from '../viewer/env';
import type { ControlsState } from '../viewer/controls';
import { TURNTABLE_SECONDS } from '../viewer/controls';
import { DEFAULT_VIEWER_FOV, TF2_ITEM_PANEL_FOV, VIEW_ANGLES, weaponIconView } from '../viewer/presets';

interface UseViewerEngineOptions {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  viewerRef: RefObject<Viewer | null>;
  compositorRef: RefObject<Compositor | null>;
  data: DataSource | null;
  sourceProvider: SourceTextureProvider;
  selectedKit: PaintkitEntry | null;
  selectedAssetKey: string;
  selectedMaterialOverrideId: string;
  packageGeneration: number;
  definitionsGeneration: number;
  state: ControlsState;
  patch: (p: Partial<ControlsState>) => void;
  autoSpin: boolean;
  firstPersonActive: boolean;
  editingMode: string | null;
  engineReady: boolean;
  environmentReady: boolean;
  advanceBoot: (progress: number, label: string) => void;
  disposeCache: () => void;
  resetComposeKey: () => void;
  resolveRecipe: ResolveRecipe;
  // engineReady, environmentReady and cameraMode are read earlier in MainApp
  // than this hook can run, so their state stays there.
  setEngineReady: (ready: boolean) => void;
  setEnvironmentReady: (ready: boolean) => void;
  setCameraMode: (mode: 'inspect' | 'advanced') => void;
  setLoadedAssetKey: (key: string) => void;
  setError: (message: string) => void;
}

/** The renderer lifecycle: viewer/compositor setup, model loading, and the viewer-facing state sync. */
export function useViewerEngine({
  canvasRef,
  viewerRef,
  compositorRef,
  data,
  sourceProvider,
  selectedKit,
  selectedAssetKey,
  selectedMaterialOverrideId,
  packageGeneration,
  definitionsGeneration,
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
}: UseViewerEngineOptions) {
  const [viewAngleId, setViewAngleId] = useState('default');
  const viewAngleIdRef = useRef(viewAngleId);
  viewAngleIdRef.current = viewAngleId;

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
        import('../viewer/Viewer'),
        import('../compositor/compositor'),
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
  }, [data, advanceBoot, disposeCache, sourceProvider, canvasRef, viewerRef, compositorRef, setEngineReady, setEnvironmentReady, setCameraMode]);

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

  // Load the model when the weapon changes.
  useEffect(() => {
    if (!engineReady || !data || !viewerRef.current || !state.weaponKey) return;
    let cancelled = false;
    const viewer = viewerRef.current;
    const weapon = data.manifest.weapons.find((w) => w.key === state.weaponKey);
    if (!weapon || !selectedAssetKey) return;
    setLoadedAssetKey('');
    advanceBoot(48, 'Loading initial weapon…');
    const overrideId = selectedMaterialOverrideId || undefined;
    const builtInMaterial = (overrideId && data.manifest.materials?.[overrideId]) || weapon.material;
    // A mounted package may ship its own VMT for this weapon, which the game
    // would load in place of the stock material. Its parameters replace the
    // baked-in ones wholesale, the way a Source material does.
    const applyMaterial = sourceProvider.resolveMaterial(state.weaponKey, overrideId)
      .then((packaged) => cancelled ? undefined : viewer.applyMaterialParams(
        packaged?.material ?? builtInMaterial,
        (ref) => sourceProvider.resolve(ref),
        async (ref) => await sourceProvider.resolveCubemap(ref) ?? stockMaterialCubemapUrls(ref),
        () => cancelled,
      ));
    void Promise.all([
      viewer.ready(),
      viewer.loadModel(
        data.getModelUrl(state.weaponKey),
        viewAngleIdRef.current === 'inventory-icon'
          ? weaponIconView(weapon, true)
          : state.weaponKey === 'paintkit_tool'
            ? weaponIconView(weapon)
            : VIEW_ANGLES.find((preset) => preset.id === viewAngleIdRef.current) ?? VIEW_ANGLES[0],
        weapon.attachments,
      ),
      applyMaterial,
    ]).then(() => {
      if (cancelled) return;
      setLoadedAssetKey(selectedAssetKey);
      advanceBoot(62, 'Weapon and material maps ready');
    }).catch((e) => {
      if (!cancelled) setError(`Failed to load weapon assets: ${String(e)}`);
    });
    return () => { cancelled = true; };
  }, [engineReady, data, selectedAssetKey, state.weaponKey, packageGeneration, advanceBoot, sourceProvider, selectedMaterialOverrideId, viewerRef, setLoadedAssetKey, setError]);

  // Archive replacement changes the answer for existing Source paths, so
  // release old source uploads and composite targets before the generation-keyed
  // compose starts. The provider ignores stale reads from the removed package.
  // A re-imported definitions file reuses the same catalog ids, so the compose
  // cache has to be dropped for it too or an edited paint would render stale.
  useEffect(() => {
    compositorRef.current?.invalidateTextures();
    disposeCache();
    resetComposeKey();
  }, [packageGeneration, definitionsGeneration, disposeCache, resetComposeKey, compositorRef]);

  // Killstreak sheen.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setSheen(state.sheen, state.team);
  }, [engineReady, state.sheen, state.team, viewerRef]);

  // Unusual particle effect.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setUnusual(state.unusual, state.weaponKey);
  }, [engineReady, state.unusual, state.weaponKey, viewerRef]);

  // Field of view.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setFov(state.fov);
  }, [engineReady, state.fov, viewerRef]);

  // Projection mode.
  useEffect(() => {
    if (engineReady) viewerRef.current?.setProjection(state.projection);
  }, [engineReady, state.projection, viewerRef]);

  // Auto spin: TF2-style inspect rotation, off during First Person or editing.
  useEffect(() => {
    const active = autoSpin && !firstPersonActive && editingMode === null;
    if (engineReady) viewerRef.current?.setAutoSpin(active ? TURNTABLE_SECONDS : null);
  }, [engineReady, autoSpin, firstPersonActive, editingMode, viewerRef]);

  const onViewAngle = useCallback((id: string) => {
    const preset = VIEW_ANGLES.find((p) => p.id === id) ?? VIEW_ANGLES[0];
    const weapon = data?.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    const authoredView = id === 'inventory-icon'
      ? weaponIconView(weapon, true)
      : id === 'default' && state.weaponKey === 'paintkit_tool'
        ? weaponIconView(weapon)
        : undefined;
    viewerRef.current?.setViewAngle(authoredView ?? preset);
    setViewAngleId(id);
    viewAngleIdRef.current = id;
    if (id === 'inventory-icon') patch({ fov: TF2_ITEM_PANEL_FOV, projection: 'perspective' });
    else patch({ fov: DEFAULT_VIEWER_FOV });
  }, [data, patch, state.weaponKey, viewerRef]);

  return { viewAngleId, onViewAngle };
}
