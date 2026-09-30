import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ControlsState } from '../viewer/controls';
import { randomSeed } from './useBootData';

const SEED_HISTORY_CAP = 20;

interface UseSeedHistoryOptions {
  state: ControlsState;
  setState: Dispatch<SetStateAction<ControlsState>>;
}

/** Controls patching plus the seed undo stack that rides along with it. */
export function useSeedHistory({
  state,
  setState,
}: UseSeedHistoryOptions) {
  const seedHistoryRef = useRef<string[]>([]);

  // Pushing history here (rather than inside the setState updater) keeps the
  // updater pure: React/StrictMode may invoke an updater function twice in
  // dev, which would double-push if the ref mutation lived in there.
  const patch = useCallback(
    (p: Partial<ControlsState>) => {
      if (p.seed !== undefined && p.seed !== state.seed) {
        const stack = seedHistoryRef.current;
        stack.push(state.seed);
        if (stack.length > SEED_HISTORY_CAP) stack.shift();
      }
      setState((s) => ({ ...s, ...p }));
    },
    [state.seed, setState],
  );

  // Pops the history stack and jumps straight to that seed, bypassing patch
  // so the undo itself is not recorded as a new history entry.
  const undoSeed = useCallback(() => {
    const prev = seedHistoryRef.current.pop();
    if (prev === undefined) return;
    setState((s) => ({ ...s, seed: prev }));
  }, [setState]);
  const canUndoSeed = seedHistoryRef.current.length > 0;

  const randomizeSeed = useCallback(() => patch({ seed: randomSeed() }), [patch]);

  return { patch, undoSeed, canUndoSeed, randomizeSeed };
}
