import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorDraftState } from '../../editor/useEditorDraft';
import { ManagedToast } from './Toast';

interface DraftToastProps {
  draft: EditorDraftState;
  draftKey: string | null;
}

export function DraftToast({
  draft,
  draftKey,
}: DraftToastProps) {
  const [showSaved, setShowSaved] = useState(false);
  const observedKeyRef = useRef<string | null>(null);
  const announcedRef = useRef(false);

  useEffect(() => {
    if (observedKeyRef.current !== draftKey) {
      observedKeyRef.current = draftKey;
      setShowSaved(false);
      return;
    }
    if (draft.status !== 'saved' || !draftKey || announcedRef.current) return;

    announcedRef.current = true;
    setShowSaved(true);
  }, [draft.status, draftKey]);

  const hideSaved = useCallback(() => setShowSaved(false), []);

  return (
    <ManagedToast
      id="editor-draft-saved"
      open={!draft.recovery && draft.status !== 'error' && showSaved}
      title="Draft saved locally"
      description="Your war paint edits will survive a reload."
      dismissible
      timeout={3_500}
      onClose={hideSaved}
    />
  );
}
