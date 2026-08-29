import { Download, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { EditorDraftStatus } from '../../editor/useEditorDraft';
import { ManagedToast } from './Toast';

export function UpdateToast({
  editorDirty,
  draftStatus,
  onDownloadRecovery,
}: {
  editorDirty: boolean;
  draftStatus: EditorDraftStatus;
  onDownloadRecovery: () => void;
}) {
  const [updateAvailable, setUpdateAvailable] = useState(false);

  useEffect(() => {
    const handlePreloadError = (event: Event) => {
      event.preventDefault();
      setUpdateAvailable(true);
    };

    window.addEventListener('vite:preloadError', handlePreloadError);
    return () => window.removeEventListener('vite:preloadError', handlePreloadError);
  }, []);

  const waitingForDraft = editorDirty
    && draftStatus !== 'saved'
    && draftStatus !== 'error';
  const copy = !editorDirty
    ? 'A newer version was deployed. Reload to continue.'
    : draftStatus === 'saved'
      ? 'Your editor draft is saved locally. Reload to continue.'
      : draftStatus === 'error'
        ? 'Your editor draft could not be saved. Download a copy of your definition edits before reloading.'
        : 'Saving your editor draft before reloading...';
  const actions = useMemo(() => [
    ...(editorDirty && draftStatus === 'error' ? [{
      label: 'Download definitions',
      onClick: onDownloadRecovery,
      icon: <Download size={14} strokeWidth={2} aria-hidden="true" />,
    }] : []),
    {
      label: 'Reload',
      onClick: () => window.location.reload(),
      disabled: waitingForDraft,
      primary: !(editorDirty && draftStatus === 'error'),
      icon: <RefreshCw size={14} strokeWidth={2} aria-hidden="true" />,
    },
  ], [draftStatus, editorDirty, onDownloadRecovery, waitingForDraft]);

  return (
    <ManagedToast
      id="site-update"
      open={updateAvailable}
      title="Update available"
      description={copy}
      actions={actions}
      priority="high"
      tone={editorDirty && draftStatus === 'error' ? 'error' : 'default'}
    />
  );
}
