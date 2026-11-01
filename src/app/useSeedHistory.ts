import { useCallback, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ControlsState } from '../viewer/controls';
import { randomSeed } from '../hooks/useBootData';

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

  // Push history here, not in the setState updater: StrictMode may run an updater twice and double-push.
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

  // Jumps straight to the seed, bypassing patch so the undo is not recorded as a new entry.
  const undoSeed = useCallback(() => {
    const prev = seedHistoryRef.current.pop();
    if (prev === undefined) return;
    setState((s) => ({ ...s, seed: prev }));
  }, [setState]);
  const canUndoSeed = seedHistoryRef.current.length > 0;

  const randomizeSeed = useCallback(() => patch({ seed: randomSeed() }), [patch]);

  return { patch, undoSeed, canUndoSeed, randomizeSeed };
}
