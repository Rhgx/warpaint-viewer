import { AlertTriangle, Download, History, RotateCcw } from 'lucide-react';
import { useEffect } from 'react';
import { useArmedConfirm } from '../../hooks/useArmedConfirm';
import type { EditorDraftState } from '../../editor/useEditorDraft';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';

const DISCARD_CONFIRM_MS = 3000;

const BANNER = 'mx-3 mt-2 flex flex-none items-start gap-2 rounded-md border px-2.5 py-2 text-text max-[720px]:flex-wrap';
const COPY = 'grid min-w-0 flex-1 gap-0.5';
const TITLE = 'text-11.5 font-[650]';
const DETAIL = 'text-11 leading-[1.4] text-dim';
const ACTIONS = 'flex flex-none items-center gap-1.5 max-[720px]:w-full max-[720px]:justify-end';

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
      <div className={cn(BANNER, 'border-[color-mix(in_srgb,var(--warn)_55%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_10%,var(--panel))]')} data-slot="editor-draft-banner" role="status">
        <History className="mt-px flex-none text-warn" size={15} aria-hidden="true" />
        <div className={COPY}>
          <strong className={TITLE}>
            {recovery.paintName
              ? `Unsaved draft found for ${recovery.paintName}`
              : 'Unsaved draft found'}
          </strong>
          <span className={DETAIL}>Saved locally. Editing is paused until you choose.</span>
        </div>
        <div className={ACTIONS}>
          <Button
            variant={confirmDiscard ? 'armed' : 'default'}
            size="compact"
            aria-label={confirmDiscard ? 'Confirm discarding the saved draft' : 'Discard the saved draft'}
            onClick={() => {
              if (!confirmDiscard) {
                armDiscard();
                return;
              }
              recovery.discard();
            }}
          >
            {confirmDiscard ? 'Discard It?' : 'Discard'}
          </Button>
          <Button variant="primary" size="compact" className="gap-1.25" onClick={recovery.restore}>
            <RotateCcw size={14} aria-hidden="true" />
            Restore Draft
          </Button>
        </div>
      </div>
    );
  }

  if (draft.status !== 'error') return null;

  return (
    <div className={cn(BANNER, 'border-fail-edge bg-[color-mix(in_srgb,var(--fail)_10%,var(--panel))]')} data-slot="editor-draft-banner" data-tone="error" role="alert">
      <AlertTriangle className="mt-px flex-none text-fail" size={15} aria-hidden="true" />
      <div className={COPY}>
        <strong className={TITLE}>Local autosave failed</strong>
        <span className={DETAIL}>Your edits are not being saved in this browser. Download a copy before reloading or closing this page.</span>
      </div>
      <div className={ACTIONS}>
        <Button variant="primary" size="compact" className="gap-1.25" onClick={onDownloadRecovery}>
          <Download size={14} aria-hidden="true" />
          Download Definitions
        </Button>
      </div>
    </div>
  );
}
