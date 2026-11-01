import { useCallback, useLayoutEffect, useRef } from 'react';

/** Fixed-identity callback that always runs the latest `fn`, for handlers passed to memoized children. */
export function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result) {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: Args) => latest.current(...args), []);
}
