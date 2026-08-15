import { useCallback, useEffect, useRef, useState } from 'react';
import type { Viewer } from '../viewer/Viewer';
import type { Compositor, ComposeResult } from '../compositor/compositor';
import type { RecipeNode } from '../compositor/types';
import type { DataSource } from '../data/loader';
import type { PaintkitEntry } from '../data/types';
import type { ControlsState } from '../viewer/controls';
import type { WarpaintAssetOverrides } from '../workbench/types';
import { isCustomKitId } from '../protodefs/types';

const COMPOSE_BADGE_DELAY_MS = 250;
const IDLE_TIMEOUT_MS = 2_000;
const IDLE_FALLBACK_DELAY_MS = 250;
const INTERACTIVE_COMPOSE_MAX_DIMENSION = 256;

interface IdleDeadlineLike {
  didTimeout: boolean;
  timeRemaining(): number;
}

type IdleCallbackWindow = Window & {
  requestIdleCallback?: (callback: (deadline: IdleDeadlineLike) => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

type ResourceAwareNavigator = Navigator & {
  deviceMemory?: number;
  connection?: {
    saveData?: boolean;
  };
};

// A composite can occupy several MB of GPU memory. Retain the fast-path LRU on
// desktop machines, but do not reserve eight render targets on constrained
// devices simply to make infrequently-used wear variants instantaneous.
function composeCacheLimit(): number {
  const nav = navigator as ResourceAwareNavigator;
  if ((nav.deviceMemory !== undefined && nav.deviceMemory <= 4) || nav.hardwareConcurrency <= 4) return 4;
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 8) return 6;
  return 8;
}

function allowSpeculativeCompose(): boolean {
  const nav = navigator as ResourceAwareNavigator;
  return document.visibilityState === 'visible'
    && !nav.connection?.saveData
    && (nav.deviceMemory === undefined || nav.deviceMemory > 4)
    && nav.hardwareConcurrency > 4;
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
  /** Another editor-owned composition is currently supplying the visible map. */
  suspended?: boolean;
  /** Prefer a fast, lower-resolution map while a continuous edit is active. */
  interactive?: boolean;
  /** Detached recipe used only while a continuous editor gesture is active. */
  interactiveRecipe?: RecipeNode | null;
  /** Stable value key for the detached interactive recipe. */
  interactiveKey?: string;
  /** Receives the exact accepted target already installed on the 3D weapon. */
  onVisibleResult?: (result: ComposeResult, context: { interactive: boolean }) => void;
  engineReady: boolean;
  data: DataSource | null;
  selectedKit: PaintkitEntry | null;
  /**
   * Recipe lookup for the selected kit. Built-in kits fetch a shipped bundle
   * and imported definitions resolve out of memory, so the caller decides.
   */
  resolveRecipe: (
    kit: PaintkitEntry,
    weaponKey: string,
    team: ControlsState['team'],
    wearIndex: number,
  ) => Promise<RecipeNode | null>;
  selectedAssetKey: string;
  loadedAssetKey: string;
  state: ControlsState;
  assetOverrides: WarpaintAssetOverrides;
  packageGeneration: number;
  definitionGeneration: number;
  activeTextureOverrides: Record<string, string>;
  viewerRef: React.RefObject<Viewer | null>;
  compositorRef: React.RefObject<Compositor | null>;
  advanceBoot: (progress: number, label: string) => void;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setState: React.Dispatch<React.SetStateAction<ControlsState>>;
}

export function useComposedPaint({
  suspended = false,
  interactive = false,
  interactiveRecipe = null,
  interactiveKey = '',
  onVisibleResult,
  engineReady,
  data,
  selectedKit,
  resolveRecipe,
  selectedAssetKey,
  loadedAssetKey,
  state,
  assetOverrides,
  packageGeneration,
  definitionGeneration,
  activeTextureOverrides,
  viewerRef,
  compositorRef,
  advanceBoot,
  setError,
  setState,
}: UseComposedPaintOptions) {
  const lastResultRef = useRef<ComposeResult | null>(null);
  const interactiveResultRef = useRef<ComposeResult | null>(null);
  const composeCacheRef = useRef(new Map<string, ComposeResult>());
  const lastComposeKeyRef = useRef<string>('');
  const firstPaintLoggedRef = useRef(false);

  const [composing, setComposing] = useState(false);
  const [visibleDefinitionGeneration, setVisibleDefinitionGeneration] = useState(-1);

  const resetComposeKey = useCallback(() => {
    lastComposeKeyRef.current = '';
  }, []);

  const disposeCache = useCallback(() => {
    const composeCache = composeCacheRef.current;
    lastComposeKeyRef.current = '';
    for (const result of new Set(composeCache.values())) result.target.dispose();
    composeCache.clear();
    if (interactiveResultRef.current) {
      compositorRef.current?.releaseResult(interactiveResultRef.current);
      interactiveResultRef.current = null;
    }
    lastResultRef.current = null;
  }, [compositorRef]);

  // Recompose when recipe inputs change: debounced, deduped, and the previous
  // texture stays on the mesh until the new one is ready (no untextured flash).
  useEffect(() => {
    if (suspended) {
      setComposing(false);
      return;
    }
    const ds = data;
    if (!engineReady || !ds || !selectedKit || !state.weaponKey || loadedAssetKey !== selectedAssetKey) return;
    if (!selectedKit.weapons.includes(state.weaponKey)) return;
    const weapon = ds.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    const fullDimensions = {
      width: weapon?.compositeWidth ?? 1024,
      height: weapon?.compositeHeight ?? 1024,
    };
    const interactiveScale = interactive
      ? Math.min(1, INTERACTIVE_COMPOSE_MAX_DIMENSION / Math.max(fullDimensions.width, fullDimensions.height))
      : 1;
    const dimensions = {
      width: Math.max(1, Math.round(fullDimensions.width * interactiveScale)),
      height: Math.max(1, Math.round(fullDimensions.height * interactiveScale)),
    };

    const composeKey = `${ds.kind}|${selectedKit.id}|${state.weaponKey}|${state.team}|${state.wearIndex}|${state.seed}|files:${assetOverrides.revision}|package:${packageGeneration}|definition:${definitionGeneration}|interactive:${interactive ? interactiveKey : '0'}`;
    if (composeKey === lastComposeKeyRef.current) {
      // The consumer can become active after the texture was already accepted
      // (for example, opening Transform from Parts). Replay the retained GPU
      // result instead of forcing an identical composition just to populate a
      // secondary preview surface.
      const retained = lastResultRef.current;
      if (retained) {
        try {
          onVisibleResult?.(retained, { interactive });
        } catch (cause) {
          console.warn('[warpaint-viewer] composed preview consumer failed:', cause);
        }
      }
      return;
    }

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

    const likelyVariant = (): { team: ControlsState['team']; wear: number } | null => {
      if (interactive || Object.keys(activeTextureOverrides).length || !allowSpeculativeCompose()) return null;
      // A team toggle preserves every other control and is the strongest next
      // interaction. Otherwise warm only the closest wear category.
      if (selectedKit.hasTeamTextures) {
        return { team: state.team === 'red' ? 'blu' : 'red', wear: state.wearIndex };
      }
      if (!selectedKit.perWear) return null;
      const wearCount = ds.manifest.wearLevels.length;
      const adjacentWear = state.wearIndex + 1 < wearCount ? state.wearIndex + 1 : state.wearIndex - 1;
      return adjacentWear >= 0 ? { team: state.team, wear: adjacentWear } : null;
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
        try {
          onVisibleResult?.(cached, { interactive: false });
        } catch (cause) {
          console.warn('[warpaint-viewer] composed preview consumer failed:', cause);
        }
        if (interactiveResultRef.current) {
          comp.releaseResult(interactiveResultRef.current);
          interactiveResultRef.current = null;
        }
        setVisibleDefinitionGeneration(definitionGeneration);
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
        const sourceRecipe = interactiveRecipe
          ?? await resolveRecipe(selectedKit, state.weaponKey, state.team, state.wearIndex);
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
        const result = interactive
          ? await comp.composeLatest('transform-paint', recipe, state.seed, dimensions)
          : await comp.compose(recipe, state.seed, dimensions);
        if (!result) return;
        if (cancelled) {
          comp.releaseResult(result);
          return;
        }
        viewer.setMap(result.texture);
        try {
          onVisibleResult?.(result, { interactive });
        } catch (cause) {
          console.warn('[warpaint-viewer] composed preview consumer failed:', cause);
        }
        const priorInteractive = interactiveResultRef.current;
        interactiveResultRef.current = interactive ? result : null;
        if (priorInteractive && priorInteractive !== result) comp.releaseResult(priorInteractive);
        setVisibleDefinitionGeneration(definitionGeneration);
        // Pointer previews are transient. Retaining every sampled slider value
        // in the normal LRU wastes render targets and forces later frames to
        // allocate instead of immediately recycling the previous preview.
        if (!interactive) cacheResult(composeKey, result, comp);
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

        // Once the requested paint is visible, warm at most one likely variant
        // during browser idle periods. Avoid speculative downloads and GPU
        // targets on hidden tabs, data-saver connections, and low-end devices.
        void (async () => {
          const variant = likelyVariant();
          if (!variant || cancelled || compositorRef.current !== comp) return;
          const key = `${ds.kind}|${selectedKit.id}|${state.weaponKey}|${variant.team}|${variant.wear}|${state.seed}|files:${assetOverrides.revision}|package:${packageGeneration}|definition:${definitionGeneration}`;
          if (composeCacheRef.current.has(key)) return;
          await waitForIdle();
          if (cancelled || compositorRef.current !== comp || !allowSpeculativeCompose()) return;
          const variantRecipe = await resolveRecipe(selectedKit, state.weaponKey, variant.team, variant.wear);
          if (!variantRecipe || cancelled) return;
          await comp.preload(variantRecipe);
          if (cancelled || compositorRef.current !== comp || !allowSpeculativeCompose()) return;
          await waitForIdle();
          if (cancelled || compositorRef.current !== comp || !allowSpeculativeCompose()) return;
          const warmed = await comp.compose(variantRecipe, state.seed, dimensions);
          if (cancelled || compositorRef.current !== comp || !allowSpeculativeCompose()) {
            comp.releaseResult(warmed);
            return;
          }
          cacheResult(key, warmed, comp);
        })();
      } catch (e) {
        console.error('[warpaint-viewer] compose failed:', e);
        // A failure on the built-in catalogue means the shipped data is broken,
        // which is worth the fatal screen. An imported paint is user input and
        // must never be able to take the app down: leave the previous paint on
        // the mesh and let the drawer report what went wrong.
        if (!firstPaintLoggedRef.current && !isCustomKitId(selectedKit.id)) {
          setError(`Failed to prepare initial warpaint: ${String(e)}`);
        }
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
  }, [suspended, interactive, interactiveRecipe, interactiveKey, onVisibleResult, engineReady, data, selectedKit, resolveRecipe, selectedAssetKey, loadedAssetKey, state.weaponKey, state.team, state.wearIndex, state.seed, assetOverrides, packageGeneration, definitionGeneration, activeTextureOverrides, advanceBoot, compositorRef, viewerRef, setError, setState]);

  return { composing, visibleDefinitionGeneration, resetComposeKey, disposeCache };
}
