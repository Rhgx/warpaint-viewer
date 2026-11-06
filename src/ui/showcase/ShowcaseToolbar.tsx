import { useCallback, useRef, useState } from 'react';
import { Copy, Download, HelpCircle, ImagePlus, Redo2, Trash2, Undo2, X } from 'lucide-react';

import { IMAGE_FILE_TYPES } from '../../showcase/boardImages';
import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import { Toolbar, ToolbarButton, ToolbarDivider } from '../primitives/Toolbar';
import { ControlsHelpModal } from '../stage/ControlsHelpModal';
import { useBusy } from './useBusy';

// The board toolbar: undo, redo, export, clear, controls reference and close.

export function ShowcaseToolbar({ board, onClose, hasItems, canUndo, canRedo, onSave, onCopy, onAddImage }: {
  board: ShowcaseBoard | null;
  onClose: () => void;
  hasItems: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
  onAddImage: (file: File) => Promise<void>;
}) {
  const [busy, run] = useBusy();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpTriggerRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  return (
    <>
      <Toolbar>
        <ToolbarButton title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo}
          onClick={() => board?.undo()}>
          <Undo2 size={15} />
        </ToolbarButton>
        <ToolbarButton title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!canRedo}
          onClick={() => board?.redo()}>
          <Redo2 size={15} />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title="Add image" aria-label="Add image" disabled={!board || busy} onClick={() => fileInputRef.current?.click()}>
          <ImagePlus size={15} />
        </ToolbarButton>
        <input ref={fileInputRef} type="file" accept={IMAGE_FILE_TYPES} hidden
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            // Cleared so picking the same file again still counts as a change.
            event.currentTarget.value = '';
            if (file) void run(() => onAddImage(file))();
          }} />
        <ToolbarButton title="Save PNG" aria-label="Save PNG" disabled={busy || !hasItems} onClick={run(onSave)}>
          <Download size={15} />
        </ToolbarButton>
        <ToolbarButton title="Copy image" aria-label="Copy image" disabled={busy || !hasItems} onClick={run(onCopy)}>
          <Copy size={15} />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton title="Clear board" aria-label="Clear board" disabled={!hasItems}
          onClick={() => board?.clear()}>
          <Trash2 size={15} />
        </ToolbarButton>
        <ToolbarDivider />
        <ToolbarButton ref={helpTriggerRef} title="Controls" aria-label="Open controls reference"
          aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => setHelpOpen(true)}>
          <HelpCircle size={15} />
        </ToolbarButton>
        <ToolbarButton title="Back to the viewer" aria-label="Close showcase board" onClick={onClose}>
          <X size={15} />
        </ToolbarButton>
      </Toolbar>
      <ControlsHelpModal open={helpOpen} editingMode="showcase" onClose={closeHelp} returnFocusRef={helpTriggerRef} />
    </>
  );
}
