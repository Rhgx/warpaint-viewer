import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProtoDefKitMessages } from '../protodefs/types';
import {
  deleteEditorDraft,
  readEditorDraft,
  writeEditorDraft,
  type EditorDraftRecord,
} from './draftStorage';

const SAVE_DELAY_MS = 300;

export type EditorDraftStatus = 'idle' | 'checking' | 'pending' | 'saving' | 'saved' | 'error';

export interface EditorDraftRecovery {
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
  original: ProtoDefKitMessages | null;
  current: ProtoDefKitMessages | null;
  dirty: boolean;
  restore: (messages: ProtoDefKitMessages) => boolean;
}

export interface EditorDraftState {
  status: EditorDraftStatus;
  savedAt?: number;
  recovery?: EditorDraftRecovery;
}

function messagesEqual(left: ProtoDefKitMessages, right: ProtoDefKitMessages): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function useEditorDraft({
  key,
  kitId,
  paintName,
  revision,
  original,
  current,
  dirty,
  restore,
}: UseEditorDraftOptions): EditorDraftState {
  const [candidate, setCandidate] = useState<EditorDraftRecord | null>(null);
  const [storageStatus, setStorageStatus] = useState<EditorDraftStatus>('idle');
  const [savedAt, setSavedAt] = useState<number | undefined>();
  const [savedRevision, setSavedRevision] = useState<number | null>(null);
  const settledKeyRef = useRef<string | null>(null);
  const operationRef = useRef(0);
  const storageQueueRef = useRef<Promise<void>>(Promise.resolve());

  const enqueue = useCallback((operation: () => Promise<void>): Promise<void> => {
    const queued = storageQueueRef.current.catch(() => undefined).then(operation);
    storageQueueRef.current = queued;
    return queued;
  }, []);

  useEffect(() => {
    const operation = ++operationRef.current;
    settledKeyRef.current = null;
    setCandidate(null);
    setSavedAt(undefined);
    setSavedRevision(null);
    if (!key || kitId === null || !original) {
      setStorageStatus('idle');
      return;
    }

    setStorageStatus('checking');
    void readEditorDraft(key).then((draft) => {
      if (operation !== operationRef.current) return;
      settledKeyRef.current = key;
      if (draft && !messagesEqual(draft.messages, original)) {
        setCandidate(draft);
        setSavedAt(draft.savedAt);
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
      setStorageStatus('idle');
      setSavedAt(undefined);
      setSavedRevision(null);
      void enqueue(() => deleteEditorDraft(key)).catch(() => {
        if (operation === operationRef.current) setStorageStatus('error');
      });
      return;
    }

    setStorageStatus('pending');
    const timeout = window.setTimeout(() => {
      if (operation !== operationRef.current) return;
      setStorageStatus('saving');
      const timestamp = Date.now();
      const record: EditorDraftRecord = {
        version: 1,
        key,
        kitId,
        ...(paintName ? { paintName } : {}),
        savedAt: timestamp,
        messages: structuredClone(current),
      };
      void enqueue(() => writeEditorDraft(record)).then(() => {
        if (operation !== operationRef.current) return;
        setSavedAt(timestamp);
        setSavedRevision(revision);
        setStorageStatus('saved');
      }).catch(() => {
        if (operation === operationRef.current) setStorageStatus('error');
      });
    }, SAVE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [candidate, current, dirty, enqueue, key, kitId, paintName, revision]);

  const restoreCandidate = useCallback(() => {
    if (!candidate || !restore(candidate.messages)) return;
    setCandidate(null);
    setSavedAt(candidate.savedAt);
    setStorageStatus('saved');
  }, [candidate, restore]);

  const discardCandidate = useCallback(() => {
    if (!candidate) return;
    setCandidate(null);
    setSavedAt(undefined);
    setStorageStatus('idle');
    // Deleting here rather than leaning on the clean-state effect below. That
    // effect only deletes while `dirty` is false, which makes discard's
    // contract depend on a condition it does not control.
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
    ...(savedAt === undefined ? {} : { savedAt }),
    ...(recovery ? { recovery } : {}),
  };
}
