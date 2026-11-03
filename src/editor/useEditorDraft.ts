import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WORKSHOP_ENABLED } from '../device';
import type { ProtoDefKitBundle } from '../protodefs/types';
import {
  DRAFT_VERSION,
  deleteEditorDraft,
  readEditorDraft,
  writeEditorDraft,
  type EditorDraftRecord,
} from './draftStorage';

const SAVE_DELAY_MS = 300;

export type EditorDraftStatus = 'idle' | 'checking' | 'pending' | 'saving' | 'saved' | 'error';

interface EditorDraftRecovery {
  paintName?: string;
  savedAt: number;
  restore: () => void;
  discard: () => void;
}

interface UseEditorDraftOptions {
  key: string | null;
  kitId: number | null;
  paintName?: string;
  revision: number;
  original: ProtoDefKitBundle | null;
  current: ProtoDefKitBundle | null;
  dirty: boolean;
  restore: (bundle: ProtoDefKitBundle) => boolean;
  /** Off leaves every stored draft untouched: nothing is read, written, or deleted. */
  enabled?: boolean;
}

export interface EditorDraftState {
  status: EditorDraftStatus;
  recovery?: EditorDraftRecovery;
  save: () => void;
}

function bundlesEqual(left: ProtoDefKitBundle, right: ProtoDefKitBundle): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function useEditorDraft({
  key: requestedKey,
  kitId,
  paintName,
  revision,
  original,
  current,
  dirty,
  restore,
  enabled = WORKSHOP_ENABLED,
}: UseEditorDraftOptions): EditorDraftState {
  // Without a key every storage path below is already inert.
  const key = enabled ? requestedKey : null;
  const [candidate, setCandidate] = useState<EditorDraftRecord | null>(null);
  const checksDraft = Boolean(key) && kitId !== null && Boolean(original);
  const [storageStatus, setStorageStatus] = useState<EditorDraftStatus>(checksDraft ? 'checking' : 'idle');
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const [checkedInputs, setCheckedInputs] = useState({ key, kitId, original });
  const settledKeyRef = useRef<string | null>(null);
  const operationRef = useRef(0);
  const [enqueue] = useState(() => {
    let tail: Promise<void> = Promise.resolve();
    return (operation: () => Promise<void>): Promise<void> => {
      const queued = tail.catch(() => undefined).then(operation);
      tail = queued;
      return queued;
    };
  });

  const save = useCallback(() => {
    if (!key || kitId === null || !current || !dirty || candidate || settledKeyRef.current !== key) return;
    const operation = ++operationRef.current;
    const timestamp = Date.now();
    setStorageStatus('saving');
    const record: EditorDraftRecord = {
      version: DRAFT_VERSION,
      key,
      kitId,
      ...(paintName ? { paintName } : {}),
      savedAt: timestamp,
      bundle: structuredClone(current),
    };
    void enqueue(() => writeEditorDraft(record)).then(() => {
      if (operation !== operationRef.current) return;
      setSavedRevision(revision);
      setStorageStatus('saved');
    }).catch(() => {
      if (operation === operationRef.current) setStorageStatus('error');
    });
  }, [candidate, current, dirty, enqueue, key, kitId, paintName, revision]);

  // A new paint, kit or baseline starts its draft check over.
  if (checkedInputs.key !== key || checkedInputs.kitId !== kitId || checkedInputs.original !== original) {
    setCheckedInputs({ key, kitId, original });
    setCandidate(null);
    setSavedRevision(null);
    setStorageStatus(checksDraft ? 'checking' : 'idle');
  }

  useEffect(() => {
    const operation = ++operationRef.current;
    settledKeyRef.current = null;
    if (!key || kitId === null || !original) return;

    void readEditorDraft(key).then((draft) => {
      if (operation !== operationRef.current) return;
      settledKeyRef.current = key;
      if (draft && !bundlesEqual(draft.bundle, original)) {
        setCandidate(draft);
      } else if (draft) {
        void enqueue(() => deleteEditorDraft(key)).catch(() => undefined);
      }
      setStorageStatus('idle');
    }).catch(() => {
      if (operation !== operationRef.current) return;
      settledKeyRef.current = key;
      setStorageStatus('error');
    });
  }, [enqueue, key, kitId, original]);

  useEffect(() => {
    if (!key || kitId === null || !current || settledKeyRef.current !== key || candidate) return;
    const operation = ++operationRef.current;
    if (!dirty) {
      // Autosave: status moves with the debounced IndexedDB write or delete this effect schedules, guarded by operationRef.
      // oxlint-disable-next-line react/set-state-in-effect
      setStorageStatus('idle');
      setSavedRevision(null);
      void enqueue(() => deleteEditorDraft(key)).catch(() => {
        if (operation === operationRef.current) setStorageStatus('error');
      });
      return;
    }

    setStorageStatus('pending');
    const timeout = window.setTimeout(() => {
      if (operation === operationRef.current) save();
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [candidate, current, dirty, enqueue, key, kitId, save]);

  const restoreCandidate = useCallback(() => {
    if (!candidate || !restore(candidate.bundle)) return;
    setCandidate(null);
    setStorageStatus('saved');
  }, [candidate, restore]);

  const discardCandidate = useCallback(() => {
    if (!candidate) return;
    setCandidate(null);
    setStorageStatus('idle');
    // Delete here, not in the clean-state effect, which deletes only while dirty is false.
    void enqueue(() => deleteEditorDraft(candidate.key)).catch(() => undefined);
  }, [candidate, enqueue]);

  const status = dirty && savedRevision !== revision && storageStatus === 'saved'
    ? 'pending'
    : storageStatus;
  const recovery = useMemo<EditorDraftRecovery | undefined>(() => candidate ? {
    ...(candidate.paintName ? { paintName: candidate.paintName } : {}),
    savedAt: candidate.savedAt,
    restore: restoreCandidate,
    discard: discardCandidate,
  } : undefined, [candidate, discardCandidate, restoreCandidate]);

  return {
    status,
    save,
    ...(recovery ? { recovery } : {}),
  };
}
