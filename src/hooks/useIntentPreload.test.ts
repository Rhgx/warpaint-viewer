import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIntentPreloader } from './useIntentPreload';

describe('intent preloading', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('ignores brief hover and cancels a target when the pointer leaves', async () => {
    const preload = vi.fn(async () => undefined);
    const scheduler = createIntentPreloader(preload);
    scheduler('a');
    await vi.advanceTimersByTimeAsync(99);
    scheduler(null);
    await vi.advanceTimersByTimeAsync(200);
    expect(preload).not.toHaveBeenCalled();
  });

  it('deduplicates repeated intent without postponing the warmup', async () => {
    const preload = vi.fn(async () => undefined);
    const scheduler = createIntentPreloader(preload);
    scheduler('a');
    await vi.advanceTimersByTimeAsync(50);
    scheduler('a');
    await vi.advanceTimersByTimeAsync(50);
    expect(preload).toHaveBeenCalledTimes(1);
    scheduler('a');
    await vi.advanceTimersByTimeAsync(200);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('serializes slow loads and keeps only the newest hovered target', async () => {
    let finish: () => void = () => { throw new Error('warmup has not started'); };
    let cancelled: () => boolean = () => false;
    const calls: string[] = [];
    const scheduler = createIntentPreloader(async (target, isCancelled) => {
      calls.push(target);
      if (target === 'a') {
        cancelled = isCancelled;
        await new Promise<void>((resolve) => { finish = resolve; });
      }
    });
    scheduler('a');
    await vi.advanceTimersByTimeAsync(100);
    scheduler('b');
    await vi.advanceTimersByTimeAsync(100);
    scheduler('c');
    await vi.advanceTimersByTimeAsync(100);
    expect(cancelled()).toBe(true);
    expect(calls).toEqual(['a']);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['a', 'c']);
  });

  it('cancellation invalidates a running load and removes queued work', async () => {
    let finish: () => void = () => undefined;
    let cancelled: () => boolean = () => false;
    const preload = vi.fn(async (_target: string, isCancelled: () => boolean) => {
      cancelled = isCancelled;
      await new Promise<void>((resolve) => { finish = resolve; });
    });
    const scheduler = createIntentPreloader(preload);
    scheduler('a');
    await vi.advanceTimersByTimeAsync(100);
    scheduler('b');
    await vi.advanceTimersByTimeAsync(100);
    scheduler(null);
    expect(cancelled()).toBe(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(preload).toHaveBeenCalledTimes(1);
  });

  it('a failed warmup does not block a later retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const preload = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const scheduler = createIntentPreloader(preload);
    scheduler('a');
    await vi.advanceTimersByTimeAsync(100);
    scheduler(null);
    scheduler('a');
    await vi.advanceTimersByTimeAsync(100);
    expect(preload).toHaveBeenCalledTimes(2);
  });
});
