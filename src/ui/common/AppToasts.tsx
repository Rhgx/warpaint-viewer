import type { ComponentProps } from 'react';
import type { EditorDraftState } from '../../editor/useEditorDraft';
import { DraftToast } from './DraftToast';
import { ManagedToast, ToastViewport } from './Toast';
import { UpdateToast } from './UpdateToast';

interface AppToastsProps {
  editorDraft: EditorDraftState;
  editorDraftKey: string | null;
  editorDirty: boolean;
  onDownloadRecovery: () => void;
  turntableToastProps: Omit<ComponentProps<typeof ManagedToast>, 'id' | 'onClose'>;
  closeTurntableToast: () => void;
  workspaceCleared: { drafts: number } | null;
  onWorkspaceClearedClose: () => void;
}

export function AppToasts({
  editorDraft,
  editorDraftKey,
  editorDirty,
  onDownloadRecovery,
  turntableToastProps,
  closeTurntableToast,
  workspaceCleared,
  onWorkspaceClearedClose,
}: AppToastsProps) {
  return (
    <ToastViewport>
      <DraftToast
        draft={editorDraft}
        draftKey={editorDraftKey}
      />
      <UpdateToast
        editorDirty={editorDirty}
        draftStatus={editorDraft.status}
        onDownloadRecovery={onDownloadRecovery}
      />
      <ManagedToast
        id="turntable"
        {...turntableToastProps}
        onClose={closeTurntableToast}
      />
      <ManagedToast
        id="workspace-cleared"
        open={workspaceCleared !== null}
        title="Workspace cleared"
        description={workspaceCleared && workspaceCleared.drafts > 0
          ? `The imported archive, definitions, and ${workspaceCleared.drafts} draft${workspaceCleared.drafts === 1 ? '' : 's'} were removed from this browser.`
          : 'The imported files were removed from this browser.'}
        dismissible
        timeout={4_500}
        onClose={onWorkspaceClearedClose}
      />
    </ToastViewport>
  );
}
