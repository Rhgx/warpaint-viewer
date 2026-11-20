import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ControlsState } from '../viewer/controls';
import { randomSeed } from '../hooks/useBootData';

const SEED_HISTORY_CAP = 20;

export interface SeedHistoryStacks {
  past: string[];
  future: string[];
}

export function pushSeedHistory(stacks: SeedHistoryStacks, previousSeed: string, cap = SEED_HISTORY_CAP): void {
  stacks.past.push(previousSeed);
  if (stacks.past.length > cap) stacks.past.shift();
  stacks.future.length = 0;
}

export function stepSeedUndo(stacks: SeedHistoryStacks, currentSeed: string, cap = SEED_HISTORY_CAP): string | null {
  const prev = stacks.past.pop();
  if (prev === undefined) return null;
  stacks.future.push(currentSeed);
  if (stacks.future.length > cap) stacks.future.shift();
  return prev;
}

export function stepSeedRedo(stacks: SeedHistoryStacks, currentSeed: string, cap = SEED_HISTORY_CAP): string | null {
  const next = stacks.future.pop();
  if (next === undefined) return null;
  stacks.past.push(currentSeed);
  if (stacks.past.length > cap) stacks.past.shift();
  return next;
}

interface UseSeedHistoryOptions {
  state: ControlsState;
  setState: Dispatch<SetStateAction<ControlsState>>;
}

/** Controls patching plus the seed undo/redo stacks that ride along with it. */
export function useSeedHistory({
  state,
  setState,
}: UseSeedHistoryOptions) {
  const stacksRef = useRef<SeedHistoryStacks>({ past: [], future: [] });
  const currentSeedRef = useRef(state.seed);
  useEffect(() => {
    currentSeedRef.current = state.seed;
  }, [state.seed]);
  const [canUndoSeed, setCanUndoSeed] = useState(false);
  const [canRedoSeed, setCanRedoSeed] = useState(false);

  const syncFlags = useCallback(() => {
    setCanUndoSeed(stacksRef.current.past.length > 0);
    setCanRedoSeed(stacksRef.current.future.length > 0);
  }, []);

  // Push history here, not in the setState updater: StrictMode may run an updater twice and double-push.
  const patch = useCallback(
    (p: Partial<ControlsState>) => {
      if (p.seed !== undefined && p.seed !== currentSeedRef.current) {
        pushSeedHistory(stacksRef.current, currentSeedRef.current);
        currentSeedRef.current = p.seed;
        syncFlags();
      }
      setState((s) => ({ ...s, ...p }));
    },
    [setState, syncFlags],
  );

  // Jumps straight to the seed, bypassing patch so undo/redo is not recorded as a fresh branch.
  const undoSeed = useCallback(() => {
    const prev = stepSeedUndo(stacksRef.current, currentSeedRef.current);
    if (prev === null) return;
    currentSeedRef.current = prev;
    syncFlags();
    setState((s) => ({ ...s, seed: prev }));
  }, [setState, syncFlags]);

  const redoSeed = useCallback(() => {
    const next = stepSeedRedo(stacksRef.current, currentSeedRef.current);
    if (next === null) return;
    currentSeedRef.current = next;
    syncFlags();
    setState((s) => ({ ...s, seed: next }));
  }, [setState, syncFlags]);

  const randomizeSeed = useCallback(() => patch({ seed: randomSeed() }), [patch]);

  return { patch, undoSeed, redoSeed, canUndoSeed, canRedoSeed, randomizeSeed };
}
