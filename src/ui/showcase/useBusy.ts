import { useState } from 'react';


export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      console.error('[showcase] action failed', cause);
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}
