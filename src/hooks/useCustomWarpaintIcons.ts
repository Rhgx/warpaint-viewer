import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Compositor } from '../compositor/compositor';
import type { RecipeNode } from '../compositor/types';
import type { PaintkitEntry, Team, WeaponEntry } from '../data/types';
import { PAINTKIT_TOOL_VIEW, TF2_ITEM_PANEL_FOV, weaponIconView } from '../viewer/presets';
import { PAINTKIT_ICON_LIGHTING_ID } from '../viewer/lighting/lightingPresetIds';
import { requestIdle } from './idle';

interface IconRenderSession {
  cancelled: boolean;
  viewer: import('../viewer/Viewer').Viewer | null;
  host: HTMLDivElement | null;
  createdUrls: Map<number, string>;
  attemptedIds: Set<number>;
  processing: boolean;
  /** Cancels the queued idle render, or null while none is queued. */
  cancelIdle: (() => void) | null;
  schedule: () => void;
}

const ICON_RENDER_IDLE_TIMEOUT_MS = 750;
const ICON_RENDER_IDLE_BUDGET_MS = 12;
const ICON_RENDER_FALLBACK_DELAY_MS = 50;

interface Options {
  enabled: boolean;
  generation: number;
  packageGeneration: number;
  kits: readonly PaintkitEntry[];
  paintTool: WeaponEntry | undefined;
  modelUrl: string | null;
  compositorRef: RefObject<Compositor | null>;
  getRecipe: (kitId: number, weaponKey: string, team: Team, wearIndex: number) => Promise<RecipeNode | null>;
  resolveTexture: (ref: string) => string | Promise<string>;
  visibleKitIds: readonly number[];
}

/** Renders imported paints on TF2's paint-tool model; the definition thumbnail shows until it lands. */
export function useCustomWarpaintIcons({
  enabled,
  generation,
  packageGeneration,
  kits,
  paintTool,
  modelUrl,
  compositorRef,
  getRecipe,
  resolveTexture,
  visibleKitIds,
}: Options): Record<number, string> {
  const [icons, setIcons] = useState<Record<number, string>>({});
  const visibleKitIdsRef = useRef(new Set<number>());
  const sessionRef = useRef<IconRenderSession | null>(null);

  visibleKitIdsRef.current = new Set(visibleKitIds);

  useEffect(() => {
    sessionRef.current = null;
    setIcons({});

    if (!enabled || !paintTool || !modelUrl) return;
    const renderable = kits.filter((kit) => kit.weapons.includes('paintkit_tool'));
    if (renderable.length === 0) return;

    const session: IconRenderSession = {
      cancelled: false,
      viewer: null,
      host: null,
      createdUrls: new Map(),
      attemptedIds: new Set(),
      processing: false,
      cancelIdle: null,
      schedule: () => undefined,
    };
    sessionRef.current = session;

    const cancelIdle = () => {
      session.cancelIdle?.();
      session.cancelIdle = null;
    };

    const ensureViewer = async (): Promise<import('../viewer/Viewer').Viewer | null> => {
      if (session.viewer) return session.viewer;
      const compositor = compositorRef.current;
      if (!compositor || session.cancelled) return null;
      const { Viewer } = await import('../viewer/Viewer');
      if (session.cancelled) return null;

      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      Object.assign(host.style, {
        position: 'fixed',
        left: '-10000px',
        top: '0',
        width: '128px',
        height: '128px',
        pointerEvents: 'none',
      });
      const canvas = document.createElement('canvas');
      canvas.style.width = '128px';
      canvas.style.height = '128px';
      host.append(canvas);
      document.body.append(host);

      const viewer = new Viewer(canvas);
      session.host = host;
      session.viewer = viewer;
      viewer.setFov(TF2_ITEM_PANEL_FOV);
      await Promise.all([
        viewer.ready(),
        viewer.loadModel(modelUrl, weaponIconView(paintTool, true) ?? PAINTKIT_TOOL_VIEW),
        viewer.applyMaterialParams(paintTool.material, resolveTexture),
      ]);
      if (session.cancelled) {
        viewer.dispose();
        session.viewer = null;
        host.remove();
        session.host = null;
        return null;
      }
      viewer.setLighting(PAINTKIT_ICON_LIGHTING_ID);
      return viewer;
    };

    const renderVisible = async () => {
      if (session.cancelled || session.processing) return;
      const visible = visibleKitIdsRef.current;
      const pending = renderable.filter((kit) => visible.has(kit.id) && !session.attemptedIds.has(kit.id));
      if (pending.length === 0) return;

      session.processing = true;
      try {
        const compositor = compositorRef.current;
        const viewer = await ensureViewer();
        if (!compositor || !viewer || session.cancelled) return;
        for (const kit of pending) {
          if (session.cancelled || !visibleKitIdsRef.current.has(kit.id)) continue;
          session.attemptedIds.add(kit.id);
          const recipe = await getRecipe(kit.id, 'paintkit_tool', 'red', 0);
          if (!recipe || session.cancelled) continue;
          if (!visibleKitIdsRef.current.has(kit.id)) {
            session.attemptedIds.delete(kit.id);
            continue;
          }
          const result = await compositor.compose(recipe, '1', { width: 512, height: 512 });
          let iconTexture: ReturnType<Compositor['toTransferTexture']> | null = null;
          try {
            if (session.cancelled || !visibleKitIdsRef.current.has(kit.id)) {
              session.attemptedIds.delete(kit.id);
              continue;
            }
            // The icon Viewer has its own WebGL context, so copy the bytes into a transferable texture.
            // Alpha must stay untouched: TF2 reads it as the phong mask.
            iconTexture = compositor.toTransferTexture(result.target);
            viewer.setMap(iconTexture);
            const blob = await viewer.captureScreenshot(1);
            if (session.cancelled || !visibleKitIdsRef.current.has(kit.id)) {
              session.attemptedIds.delete(kit.id);
              continue;
            }
            const url = URL.createObjectURL(blob);
            session.createdUrls.set(kit.id, url);
            setIcons((current) => ({ ...current, [kit.id]: url }));
          } finally {
            viewer.setMap(null);
            iconTexture?.dispose();
            compositor.releaseResult(result);
          }
        }
      } catch (error) {
        // A thumbnail must never fail a valid import; abort quietly if it was replaced mid-render.
        if (!session.cancelled) console.warn('[warpaint-viewer] could not render imported war paint icon', error);
      } finally {
        session.processing = false;
        if (!session.cancelled) session.schedule();
      }
    };

    session.schedule = () => {
      if (session.cancelled || session.processing || session.cancelIdle) return;
      session.cancelIdle = requestIdle(() => {
        session.cancelIdle = null;
        void renderVisible();
      }, {
        timeoutMs: ICON_RENDER_IDLE_TIMEOUT_MS,
        fallbackDelayMs: ICON_RENDER_FALLBACK_DELAY_MS,
        minRemainingMs: ICON_RENDER_IDLE_BUDGET_MS,
      });
    };

    session.schedule();
    return () => {
      session.cancelled = true;
      cancelIdle();
      session.viewer?.dispose();
      session.viewer = null;
      session.host?.remove();
      session.host = null;
      for (const url of session.createdUrls.values()) URL.revokeObjectURL(url);
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [compositorRef, enabled, generation, getRecipe, kits, modelUrl, packageGeneration, paintTool, resolveTexture]);

  useEffect(() => {
    const session = sessionRef.current;
    if (session) session.schedule();
  }, [visibleKitIds]);

  return icons;
}
