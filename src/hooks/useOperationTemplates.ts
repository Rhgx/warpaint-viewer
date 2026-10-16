import { useCallback, useEffect, useState } from 'react';
import { loadOperationTemplates, peekOperationTemplates } from '../data/loader';
import type { OperationTemplateData } from '../data/types';

export interface OperationTemplatesStatus {
  data: OperationTemplateData | null;
  failed: boolean;
  retry: () => void;
}

/** Stock operation template usage once enabled, with the load outcome so a caller can offer a retry. */
export function useOperationTemplatesStatus(enabled: boolean): OperationTemplatesStatus {
  const [data, setData] = useState<OperationTemplateData | null>(peekOperationTemplates);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadOperationTemplates().then(
      (loaded) => { if (live) { setData(loaded); setFailed(false); } },
      (err: unknown) => {
        console.error('[warpaint-viewer] operation templates failed to load:', err);
        if (live) setFailed(true);
      },
    );
    return () => { live = false; };
  }, [enabled, attempt]);

  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((current) => current + 1);
  }, []);

  return { data: enabled ? data : null, failed: enabled && failed, retry };
}

/** Stock operation template usage once enabled, otherwise null. */
export function useOperationTemplates(enabled: boolean): OperationTemplateData | null {
  return useOperationTemplatesStatus(enabled).data;
}
