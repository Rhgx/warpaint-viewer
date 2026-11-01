import { AlertTriangle, Download, History, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import { useArmedConfirm } from '../../hooks/useArmedConfirm';
import type { EditorDraftState } from '../../editor/useEditorDraft';

const DISCARD_CONFIRM_MS = 3000;

export function EditorDraftBanner({
  draft,
  onDownloadRecovery,
}: {
  draft: EditorDraftState;
  onDownloadRecovery: () => void;
}) {
  const [confirmDiscard, armDiscard, disarmDiscard] = useArmedConfirm(DISCARD_CONFIRM_MS);
  const recovery = draft.recovery;

  useEffect(() => disarmDiscard(), [recovery, disarmDiscard]);

  if (recovery) {
    return (
      <div className="editor-draft-banner" role="status">
        <History className="editor-draft-banner-icon" size={15} aria-hidden="true" />
        <div className="editor-draft-banner-copy">
          <strong>
            {recovery.paintName
              ? `Unsaved draft found for ${recovery.paintName}`
              : 'Unsaved draft found'}
          </strong>
          <span>Saved locally. Editing is paused until you choose.</span>
        </div>
        <div className="editor-draft-banner-actions">
          <button
            type="button"
            className="editor-draft-banner-btn"
            data-confirm={confirmDiscard ? '' : undefined}
            aria-label={confirmDiscard ? 'Confirm discarding the saved draft' : 'Discard the saved draft'}
            onClick={() => {
              if (!confirmDiscard) {
                armDiscard();
                return;
              }
              recovery.discard();
            }}
          >
            {confirmDiscard ? 'Discard it?' : 'Discard'}
          </button>
          <button
            type="button"
            className="editor-draft-banner-btn"
            data-primary=""
            onClick={recovery.restore}
          >
            <RotateCcw size={14} aria-hidden="true" />
            Restore draft
          </button>
        </div>
      </div>
    );
  }

  if (draft.status !== 'error') return null;

  return (
    <div className="editor-draft-banner" data-tone="error" role="alert">
      <AlertTriangle className="editor-draft-banner-icon" size={15} aria-hidden="true" />
      <div className="editor-draft-banner-copy">
        <strong>Local autosave failed</strong>
        <span>Your edits are not being saved in this browser. Download a copy before reloading or closing this page.</span>
      </div>
      <div className="editor-draft-banner-actions">
        <button type="button" className="editor-draft-banner-btn" data-primary="" onClick={onDownloadRecovery}>
          <Download size={14} aria-hidden="true" />
          Download definitions
        </button>
      </div>
    </div>
  );
}
