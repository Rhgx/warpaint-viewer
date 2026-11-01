import { useCallback } from 'react';
import type { RefObject } from 'react';

import type { Compositor } from '../compositor/compositor';
import type { PaintkitEntry } from '../data/types';
import type { ControlsState } from '../viewer/controls';
import type { Viewer } from '../viewer/Viewer';
import { requestIdle } from '../hooks/idle';
import { allowSpeculativeCompose } from '../hooks/useComposedPaint';
import { useIntentPreload } from '../hooks/useIntentPreload';
import type { useBootData } from '../hooks/useBootData';
import type { useSourcePackage } from '../hooks/useSourcePackage';
import type { useWorkbenchRecipes } from '../hooks/useWorkbenchRecipes';

interface UseAssetPreloadOptions {
  data: ReturnType<typeof useBootData>['data'];
  engineReady: boolean;
  paintkits: PaintkitEntry[];
  selectedKit: PaintkitEntry | null;
  state: ControlsState;
  firstPersonActive: boolean;
  resolveRecipe: Parameters<typeof useWorkbenchRecipes>[0]['resolveRecipe'];
  packageGeneration: number;
  sourceProvider: ReturnType<typeof useSourcePackage>['provider'];
  viewerRef: RefObject<Viewer | null>;
  compositorRef: RefObject<Compositor | null>;
}

export function useAssetPreload({
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
}: UseAssetPreloadOptions) {
  return useIntentPreload(useCallback(async (target: string, cancelled: () => boolean) => {
    if (!data || !engineReady) return;
    const kit = target.startsWith('kit:')
      ? paintkits.find((entry) => entry.id === Number(target.slice(4)))
      : selectedKit;
    if (!kit) return;
    const weaponKey = target.startsWith('weapon:') ? target.slice(7)
      : kit.weapons.includes(state.weaponKey) ? state.weaponKey : kit.weapons[0];
    if (!weaponKey || !kit.weapons.includes(weaponKey)
      || (kit.id === selectedKit?.id && weaponKey === state.weaponKey)) return;
    const team = target.startsWith('kit:') && !kit.hasTeamTextures
      && state.sheen !== 'team_shine' && !firstPersonActive ? 'red' : state.team;
    const viewer = viewerRef.current;
    const comp = compositorRef.current;
    const stale = () => cancelled() || comp !== compositorRef.current
      || sourceProvider.generation !== packageGeneration || !allowSpeculativeCompose();
    const model = viewer?.preloadModel(data.getModelUrl(weaponKey));
    const textures = (async () => {
      const recipe = await resolveRecipe(kit, weaponKey, team, state.wearIndex);
      if (!recipe || !comp || stale()) return;
      // Let input and visible rendering run between texture decodes/uploads.
      await comp.preload(recipe, () => new Promise<void>((resolve) => {
        requestIdle(() => resolve(), { timeoutMs: 1000, fallbackDelayMs: 50 });
      }),
        stale, state.seed);
    })();
    const results = await Promise.allSettled([model, textures]);
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
  }, [data, engineReady, paintkits, selectedKit, state.weaponKey, state.team, state.sheen,
    state.wearIndex, state.seed, firstPersonActive, resolveRecipe, packageGeneration, sourceProvider, viewerRef, compositorRef]));
}
