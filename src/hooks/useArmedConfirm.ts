import { useCallback, useEffect, useRef, useState } from 'react';

/** Two-step confirmation for destructive buttons: the first click arms, and the arm lapses after `ms`. */
export function useArmedConfirm(ms = 3000): [armed: boolean, arm: () => void, disarm: () => void] {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  const disarm = useCallback(() => {
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
    setArmed(false);
  }, []);

  const arm = useCallback(() => {
    window.clearTimeout(timerRef.current);
    setArmed(true);
    timerRef.current = window.setTimeout(disarm, ms);
  }, [disarm, ms]);

  // Reads the ref at cleanup so the timer pending at unmount is cleared, not the first render's.
  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return [armed, arm, disarm];
}
