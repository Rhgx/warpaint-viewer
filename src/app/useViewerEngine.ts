import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type { Viewer } from '../viewer/Viewer';
import type { Compositor } from '../compositor/compositor';
import type { ResolveRecipe } from '../hooks/useComposedPaint';
import type { DataSource } from '../data/loader';
import type { PaintkitEntry } from '../data/types';
import type { SourceTextureProvider } from '../source/provider';
import { stockMaterialCubemapUrls } from '../viewer/stockCubemapUrls';
import type { ControlsState } from '../viewer/controls';
import { TURNTABLE_SECONDS } from '../viewer/controls';
import { DEFAULT_VIEWER_FOV, TF2_ITEM_PANEL_FOV, VIEW_ANGLES, weaponIconView } from '../viewer/presets';
import { canUseWebGL2 } from '../viewer/webgl2';
import { readStageColor, useSettings } from '../settings';

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
  // engineReady, environmentReady and cameraMode are read before this hook runs, so their state stays in the caller.
  // The viewer travels with the ready flag so the caller can render with it without reading viewerRef.
  setEngineViewer: (viewer: Viewer | null) => void;
  setEnvironmentReady: (ready: boolean) => void;
  setCameraMode: (mode: 'inspect' | 'advanced') => void;
  setLoadedAssetKey: (key: string) => void;
  setError: (message: string) => void;
}

const WEBGL2_UNAVAILABLE_MESSAGE = 'This browser cannot use WebGL 2, which the 3D viewer needs. Turn on hardware acceleration in the browser settings, update the graphics driver, or try another browser.';

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
  setEngineViewer,
  setEnvironmentReady,
  setCameraMode,
  setLoadedAssetKey,
  setError,
}: UseViewerEngineOptions) {
  const [viewAngleId, setViewAngleId] = useState('default');
  const viewAngleIdRef = useRef(viewAngleId);

  // Fetch the renderer chunks on mount, alongside the manifest. The viewer is still built only once data is ready.
  // A failed prefetch is reported by the awaited import that builds the viewer, so these swallow it.
  useEffect(() => {
    import('../viewer/Viewer').catch(() => undefined);
    import('../compositor/compositor').catch(() => undefined);
  }, []);

  // Three.js loads dynamically so the UI shell paints before its chunk arrives.
  useEffect(() => {
    if (!canvasRef.current || !data) return;
    let disposed = false;
    let viewer: Viewer | null = null;
    let compositor: Compositor | null = null;
    let unsubscribeCameraMode: (() => void) | null = null;
    let unsubscribeTheme: (() => void) | null = null;
    (async () => {
      advanceBoot(22, 'Starting renderer…');
      // Check before the lazy import so a missing WebGL 2 reports at once instead of hanging the boot screen.
      if (!canUseWebGL2(() => document.createElement('canvas').getContext('webgl2'))) {
        if (!disposed) setError(WEBGL2_UNAVAILABLE_MESSAGE);
        return;
      }
      try {
        const [{ Viewer: ViewerCls }, { Compositor: CompositorCls }] = await Promise.all([
          import('../viewer/Viewer'),
          import('../compositor/compositor'),
        ]);
        if (disposed || !canvasRef.current) return;
        viewer = new ViewerCls(canvasRef.current);
        const liveViewer = viewer;
        liveViewer.setStageColor(readStageColor());
        unsubscribeTheme = useSettings.subscribe((state, previous) => {
          if (state.theme !== previous.theme) liveViewer.setStageColor(readStageColor());
        });
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
        setEngineViewer(viewer);
        advanceBoot(34, 'Loading TF2 environment…');
        await viewer.ready();
        if (!disposed) {
          setEnvironmentReady(true);
          advanceBoot(43, 'Environment ready');
        }
      } catch (e) {
        // Renderer creation errors would otherwise stop the boot silently.
        if (!disposed) setError(`The 3D viewer could not start: ${String(e)}`);
      }
    })();
    return () => {
      disposed = true;
      setEngineViewer(null);
      setEnvironmentReady(false);
      disposeCache();
      compositor?.dispose();
      unsubscribeCameraMode?.();
      unsubscribeTheme?.();
      viewer?.dispose();
      viewerRef.current = null;
      compositorRef.current = null;
    };
  }, [data, advanceBoot, disposeCache, sourceProvider, canvasRef, viewerRef, compositorRef, setEngineViewer, setEnvironmentReady, setCameraMode, setError]);

  // A blank selection has no model work, so the empty stage is ready once the environment is.
  useEffect(() => {
    if (environmentReady && !selectedKit) advanceBoot(100, 'Ready');
  }, [environmentReady, selectedKit, advanceBoot]);

  // Start the recipe request at once, in parallel with the lazy renderer import.
  useEffect(() => {
    if (!data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) return;
    void resolveRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex);
  }, [data, resolveRecipe, selectedKit, state.weaponKey, state.team, state.wearIndex]);

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
    // A mounted package's VMT replaces the baked-in material parameters wholesale,
    // as the game does for a Source material.
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

  // Archive and definition changes reuse paths and catalog ids, so release old uploads
  // and the compose cache first or an edited paint would render stale.
  useEffect(() => {
    compositorRef.current?.invalidateTextures();
    disposeCache();
    resetComposeKey();
  }, [packageGeneration, definitionsGeneration, disposeCache, resetComposeKey, compositorRef]);

  useEffect(() => {
    if (engineReady) viewerRef.current?.setSheen(state.sheen, state.team);
  }, [engineReady, state.sheen, state.team, viewerRef]);

  useEffect(() => {
    if (engineReady) viewerRef.current?.setUnusual(state.unusual, state.weaponKey);
  }, [engineReady, state.unusual, state.weaponKey, viewerRef]);

  useEffect(() => {
    if (engineReady) viewerRef.current?.setFov(state.fov);
  }, [engineReady, state.fov, viewerRef]);

  useEffect(() => {
    if (engineReady) viewerRef.current?.setProjection(state.projection);
  }, [engineReady, state.projection, viewerRef]);

  // Auto spin is off during First Person or editing.
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
