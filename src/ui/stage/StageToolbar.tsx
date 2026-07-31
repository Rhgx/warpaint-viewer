import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Check, Copy, HelpCircle, ImageDown, PackagePlus, RotateCcw, X } from 'lucide-react';
import { ControlsHelpModal } from './ControlsHelpModal';

type Feedback = 'idle' | 'success' | 'error';

const FEEDBACK_MS = 1500;

// One icon button that swaps its own icon for a Check/X after `onAction`
// settles, then reverts. Feedback state is local and per-button so the four
// toolbar actions never interfere with each other.
function ToolbarButton({
  label,
  icon: Icon,
  onAction,
  disabled,
}: {
  label: string;
  icon: ComponentType<{ size?: number }>;
  onAction: () => void | Promise<void>;
  disabled?: boolean;
}) {
  const [feedback, setFeedback] = useState<Feedback>('idle');
  const timerRef = useRef(0);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const handleClick = async () => {
    try {
      await onAction();
      setFeedback('success');
    } catch (e) {
      console.error(`[warpaint-viewer] ${label} failed:`, e);
      setFeedback('error');
    }
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setFeedback('idle'), FEEDBACK_MS);
  };

  const ShownIcon = feedback === 'success' ? Check : feedback === 'error' ? X : Icon;

  return (
    <button
      type="button"
      className="stage-toolbar-btn"
      title={label}
      aria-label={label}
      disabled={disabled}
      data-feedback={feedback !== 'idle' ? feedback : undefined}
      onClick={handleClick}
    >
      <ShownIcon size={15} />
    </button>
  );
}

// Top-right overlay on the canvas: save/copy the current render and reset the
// camera. Save/Copy image share one local "capturing" flag (both drive the same
// expensive viewer capture) so they disable together; Reset stays independently
// available.
export function StageToolbar({
  workbenchOpen,
  onToggleWorkbench,
  onSavePng,
  onCopyImage,
  onResetView,
}: {
  workbenchOpen: boolean;
  onToggleWorkbench: () => void;
  onSavePng: () => Promise<void>;
  onCopyImage: () => Promise<void>;
  onResetView: () => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [controlsHelpOpen, setControlsHelpOpen] = useState(false);
  const controlsHelpTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeControlsHelp = useCallback(() => setControlsHelpOpen(false), []);

  const withCapture = (fn: () => Promise<void>) => async () => {
    setCapturing(true);
    try {
      await fn();
    } finally {
      setCapturing(false);
    }
  };

  return (
    <>
      <div className="stage-toolbar">
        <button
          type="button"
          className="stage-toolbar-btn custom-workbench-trigger"
          title={workbenchOpen ? 'Close custom warpaint files' : 'Open custom warpaint files'}
          aria-label={workbenchOpen ? 'Close custom warpaint files' : 'Open custom warpaint files'}
          aria-pressed={workbenchOpen}
          onClick={onToggleWorkbench}
        >
          <PackagePlus size={15} />
        </button>
        <span className="stage-toolbar-divider" aria-hidden="true" />
        <ToolbarButton label="Save PNG" icon={ImageDown} disabled={capturing} onAction={withCapture(onSavePng)} />
        <ToolbarButton label="Copy image" icon={Copy} disabled={capturing} onAction={withCapture(onCopyImage)} />
        <ToolbarButton label="Reset view" icon={RotateCcw} onAction={onResetView} />
        <span className="stage-toolbar-divider" aria-hidden="true" />
        <button
          ref={controlsHelpTriggerRef}
          type="button"
          className="stage-toolbar-btn stage-toolbar-help"
          title="Controls"
          aria-label="Open controls reference"
          aria-haspopup="dialog"
          aria-expanded={controlsHelpOpen}
          onClick={() => setControlsHelpOpen(true)}
        >
          <HelpCircle size={15} />
        </button>
      </div>
      <ControlsHelpModal
        open={controlsHelpOpen}
        onClose={closeControlsHelp}
        returnFocusRef={controlsHelpTriggerRef}
      />
    </>
  );
}
