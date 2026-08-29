import { AlertDialog } from '@base-ui/react/alert-dialog';
import { AlertTriangle, Download, LoaderCircle, Trash2 } from 'lucide-react';
import './ClearWorkspaceDialog.css';

interface ClearWorkspaceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unsavedWarning?: string | null;
  onDownloadRecovery: () => void;
  clearing: boolean;
  error?: string | null;
  onConfirm: () => void;
}

export function ClearWorkspaceDialog({
  open,
  onOpenChange,
  unsavedWarning,
  onDownloadRecovery,
  clearing,
  error,
  onConfirm,
}: ClearWorkspaceDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => { if (!clearing) onOpenChange(next); }}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="clear-workspace-backdrop" />
        <AlertDialog.Popup className="clear-workspace-popup">
          <AlertDialog.Title className="clear-workspace-title">Clear workspace?</AlertDialog.Title>
          <AlertDialog.Description className="clear-workspace-description">
            This removes the imported archive, definitions, replaced textures, and drafts for imported paints.
          </AlertDialog.Description>

          <p className="clear-workspace-preserved">
            Camera, lighting, wear, team, seed, and your edits to built-in war paints stay as they are.
          </p>

          {unsavedWarning && (
            <div className="clear-workspace-warning">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{unsavedWarning}</span>
            </div>
          )}

          {error && (
            <div className="clear-workspace-warning" data-tone="error" role="alert">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{error} Nothing was removed.</span>
            </div>
          )}

          <div className="clear-workspace-actions">
            {unsavedWarning && (
              <button
                type="button"
                className="clear-workspace-btn clear-workspace-btn-aside"
                onClick={onDownloadRecovery}
              >
                <Download size={14} aria-hidden="true" />
                Download definition recovery
              </button>
            )}
            <AlertDialog.Close className="clear-workspace-btn" disabled={clearing}>
              Cancel
            </AlertDialog.Close>
            <button
              type="button"
              className="clear-workspace-btn"
              data-destructive=""
              disabled={clearing}
              aria-busy={clearing}
              onClick={onConfirm}
            >
              {clearing
                ? <LoaderCircle className="clear-workspace-spinner" size={14} aria-hidden="true" />
                : <Trash2 size={14} aria-hidden="true" />}
              {clearing ? 'Clearing...' : 'Clear workspace'}
            </button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
