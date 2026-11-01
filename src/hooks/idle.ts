export interface IdleRequestOptions {
  /** The longest wait for an idle period; the callback runs once it elapses. */
  timeoutMs: number;
  /** Delay used where requestIdleCallback is unavailable. */
  fallbackDelayMs: number;
  /** Idle periods with less time left than this are skipped. Zero accepts any. */
  minRemainingMs?: number;
}

/** Runs `run` once the browser is idle, or after fallbackDelayMs without requestIdleCallback. Returns a canceller. */
export function requestIdle(run: () => void, options: IdleRequestOptions): () => void {
  const { timeoutMs, fallbackDelayMs, minRemainingMs = 0 } = options;
  let cancelPending = () => {};
  const request = () => {
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback((deadline) => {
        if (!deadline.didTimeout && deadline.timeRemaining() < minRemainingMs) {
          request();
          return;
        }
        run();
      }, { timeout: timeoutMs });
      cancelPending = () => window.cancelIdleCallback(handle);
    } else {
      const timer = window.setTimeout(run, fallbackDelayMs);
      cancelPending = () => window.clearTimeout(timer);
    }
  };
  request();
  return () => cancelPending();
}
