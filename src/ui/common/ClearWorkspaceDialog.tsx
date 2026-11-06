import { AlertDialog as AlertDialogPrimitive } from '@base-ui/react/alert-dialog';
import { Download, LoaderCircle, Trash2 } from 'lucide-react';

import { Button } from '../primitives/Button';
import { AlertDialog, DialogBody, DialogPopup } from '../primitives/Dialog';
import { BlockNotice } from '../primitives/Notice';

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
    <AlertDialog open={open} onOpenChange={(next) => { if (!clearing) onOpenChange(next); }}>
      {/* Above the toasts, unlike the other dialogs: nothing should compete with this question. */}
      <DialogPopup title="Clear Workspace?" viewportClassName="z-1600">
        <DialogBody>
          <AlertDialogPrimitive.Description className="m-0 text-12 leading-[1.45] text-dim">
            This removes the imported archive, definitions, replaced textures, and drafts for imported paints.
          </AlertDialogPrimitive.Description>

          <p className="mt-2.5 mb-0 text-11.5 leading-[1.45] text-dim">
            Camera, lighting, wear, team, seed, and your edits to built-in war paints stay as they are.
          </p>

          {unsavedWarning && <BlockNotice className="mt-3">{unsavedWarning}</BlockNotice>}

          {error && <BlockNotice tone="error" className="mt-3" role="alert">{error} Nothing was removed.</BlockNotice>}

          <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
            {unsavedWarning && (
              <Button variant="secondary" size="lg" className="mr-auto" onClick={onDownloadRecovery}>
                <Download size={14} aria-hidden="true" />
                Download Recovery
              </Button>
            )}
            <AlertDialogPrimitive.Close disabled={clearing} render={<Button variant="secondary" size="lg" />}>
              Cancel
            </AlertDialogPrimitive.Close>
            <Button
              variant="destructive"
              size="lg"
              data-slot="clear-workspace-confirm"
              disabled={clearing}
              aria-busy={clearing}
              onClick={onConfirm}
            >
              {clearing
                ? <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} aria-hidden="true" />
                : <Trash2 size={14} aria-hidden="true" />}
              {clearing ? 'Clearing...' : 'Clear Workspace'}
            </Button>
          </div>
        </DialogBody>
      </DialogPopup>
    </AlertDialog>
  );
}
