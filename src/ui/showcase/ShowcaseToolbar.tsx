import { useCallback, useRef, useState } from 'react';
import { Copy, HelpCircle, ImageDown, Redo2, Trash2, Undo2, X } from 'lucide-react';

import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import { ControlsHelpModal } from '../stage/ControlsHelpModal';
import { useBusy } from './useBusy';

// The board toolbar: undo, redo, export, clear, controls reference and close.

export function ShowcaseToolbar({ board, onClose, hasItems, canUndo, canRedo, onSave, onCopy }: {
  board: ShowcaseBoard | null;
  onClose: () => void;
  hasItems: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
}) {
  const [busy, run] = useBusy();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  return (
    <>
      <div className="stage-toolbar">
        <button type="button" className="stage-toolbar-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo}
          onClick={() => board?.undo()}>
          <Undo2 size={15} />
        </button>
        <button type="button" className="stage-toolbar-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!canRedo}
          onClick={() => board?.redo()}>
          <Redo2 size={15} />
        </button>
        <span className="stage-toolbar-divider" aria-hidden="true" />
        <button type="button" className="stage-toolbar-btn" title="Save PNG" aria-label="Save PNG" disabled={busy || !hasItems} onClick={run(onSave)}>
          <ImageDown size={15} />
        </button>
        <button type="button" className="stage-toolbar-btn" title="Copy image" aria-label="Copy image" disabled={busy || !hasItems} onClick={run(onCopy)}>
          <Copy size={15} />
        </button>
        <span className="stage-toolbar-divider" aria-hidden="true" />
        <button type="button" className="stage-toolbar-btn" title="Clear board" aria-label="Clear board" disabled={!hasItems}
          onClick={() => board?.clear()}>
          <Trash2 size={15} />
        </button>
        <span className="stage-toolbar-divider" aria-hidden="true" />
        <button ref={helpTriggerRef} type="button" className="stage-toolbar-btn stage-toolbar-help" title="Controls" aria-label="Open controls reference"
          aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => setHelpOpen(true)}>
          <HelpCircle size={15} />
        </button>
        <button type="button" className="stage-toolbar-btn" title="Back to the viewer" aria-label="Close showcase board" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <ControlsHelpModal open={helpOpen} editingMode="showcase" onClose={closeHelp} returnFocusRef={helpTriggerRef} />
    </>
  );
}
