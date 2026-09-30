import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A callback with a fixed identity that always runs the latest `fn`. For
 * handlers passed to memoized children, where the closure changes with state
 * the child does not otherwise care about.
 */
export function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
