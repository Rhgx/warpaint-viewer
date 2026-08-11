import { useEffect, useState, type RefObject } from 'react';
import type { Compositor } from '../compositor/compositor';
import type { RecipeNode } from '../compositor/types';
import type { PaintkitEntry, Team, WeaponEntry } from '../data/types';
import { PAINTKIT_TOOL_FOV, PAINTKIT_TOOL_VIEW, weaponIconView } from '../viewer/presets';
import { PAINTKIT_ICON_LIGHTING_ID } from '../viewer/lighting';

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
}

/**
 * Renders imported paints on TF2's paint-tool model instead of presenting a
 * raw pattern swatch. The one hidden Viewer is reused for the whole import and
 * every generated object URL is revoked when that import is replaced.
 */
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
}: Options): Record<number, string> {
  const [icons, setIcons] = useState<Record<number, string>>({});

  useEffect(() => {
    setIcons((current) => {
      for (const url of Object.values(current)) URL.revokeObjectURL(url);
      return {};
    });
    if (!enabled || !paintTool || !modelUrl) return;
    const renderable = kits.filter((kit) => kit.weapons.includes('paintkit_tool'));
    if (renderable.length === 0) return;

    let cancelled = false;
    let viewer: import('../viewer/Viewer').Viewer | null = null;
    let host: HTMLDivElement | null = null;
    const createdUrls: string[] = [];

    void (async () => {
      const compositor = compositorRef.current;
      if (!compositor) return;
      const [{ Viewer }] = await Promise.all([import('../viewer/Viewer')]);
      if (cancelled) return;

      host = document.createElement('div');
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

      viewer = new Viewer(canvas);
      viewer.setFov(PAINTKIT_TOOL_FOV);
      await Promise.all([
        viewer.ready(),
        viewer.loadModel(modelUrl, weaponIconView(paintTool, true) ?? PAINTKIT_TOOL_VIEW),
        viewer.applyMaterialParams(paintTool.material, resolveTexture),
      ]);
      viewer.setLighting(PAINTKIT_ICON_LIGHTING_ID);
      for (const kit of renderable) {
        if (cancelled) return;
        const recipe = await getRecipe(kit.id, 'paintkit_tool', 'red', 0);
        if (!recipe || cancelled) continue;
        const result = await compositor.compose(recipe, '1', { width: 512, height: 512 });
        let iconTexture: ReturnType<Compositor['toTransferTexture']> | null = null;
        try {
          if (cancelled) return;
          // The hidden icon Viewer owns a separate WebGL context, so copy the
          // composed bytes into a transferable texture. Alpha must remain
          // untouched: TF2 uses it as the phong/environment mask.
          iconTexture = compositor.toTransferTexture(result.target);
          viewer.setMap(iconTexture);
          const blob = await viewer.captureScreenshot(1);
          if (cancelled) return;
          const url = URL.createObjectURL(blob);
          createdUrls.push(url);
          setIcons((current) => ({ ...current, [kit.id]: url }));
        } finally {
          viewer.setMap(null);
          iconTexture?.dispose();
          compositor.releaseResult(result);
        }
      }
    })().catch((error) => {
      // A thumbnail must never make an otherwise valid import fail.
      console.warn('[warpaint-viewer] could not render imported war paint icon', error);
    }).finally(() => {
      viewer?.dispose();
      viewer = null;
      host?.remove();
      host = null;
    });

    return () => {
      cancelled = true;
      viewer?.dispose();
      viewer = null;
      host?.remove();
      host = null;
      for (const url of createdUrls) URL.revokeObjectURL(url);
    };
  }, [
    compositorRef,
    enabled,
    generation,
    getRecipe,
    kits,
    modelUrl,
    packageGeneration,
    paintTool,
    resolveTexture,
  ]);

  return icons;
}
