import { useEffect, useMemo } from 'react';
import type { FocusEvent, PointerEvent } from 'react';

export type PreloadIntent = (target: string | null) => void;
type Preload = (target: string, cancelled: () => boolean) => Promise<unknown>;

/** Keep one running warmup and only the newest target that survived the dwell. */
export function createIntentPreloader(preload: Preload) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  let target: string | null = null;
  let pending: { target: string; revision: number } | undefined;
  let running = false;

  const run = async () => {
    if (running || !pending) return;
    const request = pending;
    pending = undefined;
    running = true;
    try {
      await preload(request.target, () => revision !== request.revision);
    } catch (cause) {
      console.warn('[warpaint-viewer] intent preload failed:', cause);
    } finally {
      running = false;
      void run();
    }
  };

  const request: PreloadIntent = (next) => {
    if (next !== null && next === target) return;
    clearTimeout(timer);
    timer = undefined;
    revision += 1;
    target = next;
    pending = undefined;
    if (next === null) return;
    const current = revision;
    timer = setTimeout(() => {
      timer = undefined;
      pending = { target: next, revision: current };
      void run();
    }, 100);
  };
  return request;
}

export function useIntentPreload(preload: Preload): PreloadIntent {
  const scheduler = useMemo(() => createIntentPreloader(async (target, cancelled) => {
    const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
    if (document.visibilityState !== 'visible' || nav.connection?.saveData) return;
    await preload(target, cancelled);
  }), [preload]);
  useEffect(() => () => scheduler(null), [scheduler]);
  return scheduler;
}

/** Pointer and keyboard intent share the same queue; touching never counts as hover. */
export function preloadIntent(target: string, request?: PreloadIntent) {
  return {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === 'mouse' || event.pointerType === 'pen') request?.(target);
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(document.activeElement)) request?.(null);
    },
    onFocus: () => request?.(target),
    onBlur: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.matches(':hover')) request?.(null);
    },
    onPointerDown: () => request?.(null),
  };
}
