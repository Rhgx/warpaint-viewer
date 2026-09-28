import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Check, Copy, Film, HelpCircle, ImageDown, PackagePlus, Rotate3d, RotateCcw, X } from 'lucide-react';
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

// Top-right overlay on the canvas: save the current capture format, copy
// image (image format only), toggle auto spin, then reset the camera. The
// capture actions share one local "capturing" flag (all drive expensive
// viewer captures) so they disable together; Reset and Auto spin stay
// independently available.
export function StageToolbar({
  workbenchOpen,
  editingMode = null,
  onToggleWorkbench,
  captureFormat,
  saveLabel,
  onSave,
  onCopyImage,
  onResetView,
  autoSpin,
  onToggleAutoSpin,
  showAutoSpin,
}: {
  workbenchOpen: boolean;
  editingMode?: 'paint' | 'sticker' | 'lighting' | 'graph' | null;
  onToggleWorkbench: () => void;
  captureFormat: 'image' | 'animated';
  saveLabel: string;
  onSave: () => Promise<void>;
  onCopyImage: () => Promise<void>;
  onResetView: () => void;
  autoSpin: boolean;
  onToggleAutoSpin: () => void;
  showAutoSpin: boolean;
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
        <ToolbarButton
          label={saveLabel}
          icon={captureFormat === 'animated' ? Film : ImageDown}
          disabled={capturing}
          onAction={withCapture(onSave)}
        />
        {captureFormat === 'image' && (
          <ToolbarButton label="Copy image" icon={Copy} disabled={capturing} onAction={withCapture(onCopyImage)} />
        )}
        <span className="stage-toolbar-divider" aria-hidden="true" />
        {showAutoSpin && (
          <button
            type="button"
            className="stage-toolbar-btn"
            title="Auto spin"
            aria-label="Auto spin"
            aria-pressed={autoSpin}
            onClick={onToggleAutoSpin}
          >
            <Rotate3d size={15} />
          </button>
        )}
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
        editingMode={editingMode}
        onClose={closeControlsHelp}
        returnFocusRef={controlsHelpTriggerRef}
      />
    </>
  );
}
