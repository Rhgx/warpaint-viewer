import { useCallback, useEffect, useRef, useState } from 'react';
import type { Viewer } from '../viewer/Viewer';
import type { Compositor, ComposeResult } from '../compositor/compositor';
import type { RecipeNode } from '../compositor/types';
import type { DataSource } from '../data/loader';
import type { PaintkitEntry } from '../data/types';
import type { ControlsState } from '../ui/Inspector';
import type { WarpaintAssetOverrides } from '../ui/CustomWarpaintImport';

const COMPOSE_BADGE_DELAY_MS = 250;
const IDLE_TIMEOUT_MS = 2_000;
const IDLE_FALLBACK_DELAY_MS = 250;

interface IdleDeadlineLike {
  didTimeout: boolean;
  timeRemaining(): number;
}

type IdleCallbackWindow = Window & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

// A composite can occupy several MB of GPU memory. Retain the fast-path LRU on
// desktop machines, but do not reserve eight render targets on constrained
// devices simply to make infrequently-used wear variants instantaneous.
function composeCacheLimit(): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  if ((nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || nav.hardwareConcurrency <= 4) return 4;
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 8) return 6;
  return 8;
}

export function applyTextureOverrides(node: RecipeNode, textures: Record<string, string>): RecipeNode {
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

interface UseComposedPaintOptions {
  engineReady: boolean;
  data: DataSource | null;
  selectedKit: PaintkitEntry | null;
  selectedAssetKey: string;
  loadedAssetKey: string;
  state: ControlsState;
  assetOverrides: WarpaintAssetOverrides;
  packageGeneration: number;
  activeTextureOverrides: Record<string, string>;
  viewerRef: React.RefObject<Viewer | null>;
  compositorRef: React.RefObject<Compositor | null>;
  advanceBoot: (progress: number, label: string) => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setState: React.Dispatch<React.SetStateAction<ControlsState>>;
}

export function useComposedPaint({
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
}: UseComposedPaintOptions) {
  const lastResultRef = useRef<ComposeResult | null>(null);
  const composeCacheRef = useRef(new Map<string, ComposeResult>());
  const lastComposeKeyRef = useRef<string>('');
  const firstPaintLoggedRef = useRef(false);

  const [composing, setComposing] = useState(false);

  const resetComposeKey = useCallback(() => {
    lastComposeKeyRef.current = '';
  }, []);

  const disposeCache = useCallback(() => {
    const composeCache = composeCacheRef.current;
    lastComposeKeyRef.current = '';
    for (const result of new Set(composeCache.values())) result.target.dispose();
    composeCache.clear();
    lastResultRef.current = null;
  }, []);

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

    const composeKey = `${ds.kind}|${selectedKit.id}|${state.weaponKey}|${state.team}|${state.wearIndex}|${state.seed}|files:${assetOverrides.revision}|package:${packageGeneration}`;
    if (composeKey === lastComposeKeyRef.current) return;

    let cancelled = false;
    let badgeTimer = 0;
    let cancelPendingIdle: (() => void) | null = null;

    const cacheResult = (key: string, result: ComposeResult, comp: Compositor) => {
      const cache = composeCacheRef.current;
      const old = cache.get(key);
      if (old && old !== result) comp.releaseResult(old);
      cache.delete(key);
      cache.set(key, result);
      while (cache.size > composeCacheLimit()) {
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

    // Keep speculative decoding and rendering off the first-paint path. The
    // timeout lets browsers without requestIdleCallback make progress, while
    // requestIdleCallback itself prevents a sequence of warmups from competing
    // with input and animation work on supported browsers.
    const waitForIdle = () => new Promise<void>((resolve) => {
      const idleWindow = window as IdleCallbackWindow;
      let idleHandle = 0;
      let fallbackTimer = 0;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (idleHandle) idleWindow.cancelIdleCallback?.(idleHandle);
        if (fallbackTimer) window.clearTimeout(fallbackTimer);
        cancelPendingIdle = null;
        resolve();
      };
      const request = () => {
        if (idleWindow.requestIdleCallback) {
          idleHandle = idleWindow.requestIdleCallback((deadline) => {
            idleHandle = 0;
            // Leave a small budget for the browser's own bookkeeping; retry on
            // a later idle period instead of starting GPU work at the deadline.
            if (!cancelled && !deadline.didTimeout && deadline.timeRemaining() < 12) {
              request();
              return;
            }
            finish();
          }, { timeout: IDLE_TIMEOUT_MS });
        } else {
          fallbackTimer = window.setTimeout(finish, IDLE_FALLBACK_DELAY_MS);
        }
      };
      cancelPendingIdle = finish;
      request();
    });

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
        // compose() loads precisely the textures selected by this seed. Do not
        // block the first visible paint on every possible sticker alternative.
        if (!firstPaintLoggedRef.current) advanceBoot(70, 'Composing initial warpaint…');
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

        // Once the requested paint is visible, warm sticker alternatives and
        // likely wear/team variants only during browser idle periods. Both the
        // broad preload and the composite render are gated separately because
        // either can become expensive with a custom package.
        void (async () => {
          for (const variant of likelyVariants()) {
            if (cancelled || compositorRef.current !== comp) return;
            const key = `${ds.kind}|${selectedKit.id}|${state.weaponKey}|${variant.team}|${variant.wear}|${state.seed}|files:${assetOverrides.revision}|package:${packageGeneration}`;
            if (composeCacheRef.current.has(key)) continue;
            await waitForIdle();
            if (cancelled || compositorRef.current !== comp) return;
            const variantRecipe = await ds.getRecipe(selectedKit, state.weaponKey, variant.team, variant.wear);
            if (!variantRecipe || cancelled) return;
            await comp.preload(variantRecipe);
            if (cancelled || compositorRef.current !== comp) return;
            await waitForIdle();
            if (cancelled || compositorRef.current !== comp) return;
            const warmed = await comp.compose(variantRecipe, state.seed, dimensions);
            if (cancelled || compositorRef.current !== comp) {
              comp.releaseResult(warmed);
              return;
            }
            cacheResult(key, warmed, comp);
          }
        })();
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
      cancelPendingIdle?.();
    };
  }, [engineReady, data, selectedKit, selectedAssetKey, loadedAssetKey, state.weaponKey, state.team, state.wearIndex, state.seed, assetOverrides, packageGeneration, activeTextureOverrides, advanceBoot, compositorRef, viewerRef, setError, setState]);

  return { composing, resetComposeKey, disposeCache };
}
