import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Check, Copy, ImageDown, Link, PackagePlus, PanelLeft, PanelRight, RotateCcw, X } from 'lucide-react';

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

// Top-right overlay on the canvas: save/copy the current render, copy a
// shareable link, and reset the camera. Save/Copy image share one local
// "capturing" flag (both drive the same expensive viewer capture) so they
// disable together; Copy link and Reset stay independently available.
export function StageToolbar({
  catalogVisible,
  controlsVisible,
  workbenchOpen,
  onToggleWorkbench,
  onToggleCatalog,
  onToggleControls,
  onSavePng,
  onCopyImage,
  onCopyLink,
  onResetView,
}: {
  catalogVisible: boolean;
  controlsVisible: boolean;
  workbenchOpen: boolean;
  onToggleWorkbench: () => void;
  onToggleCatalog: () => void;
  onToggleControls: () => void;
  onSavePng: () => Promise<void>;
  onCopyImage: () => Promise<void>;
  onCopyLink: () => void | Promise<void>;
  onResetView: () => void;
}) {
  const [capturing, setCapturing] = useState(false);

  const withCapture = (fn: () => Promise<void>) => async () => {
    setCapturing(true);
    try {
      await fn();
    } finally {
      setCapturing(false);
    }
  };

  return (
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
      <button
        type="button"
        className="stage-toolbar-btn stage-panel-toggle"
        title={catalogVisible ? 'Hide warpaint catalog' : 'Show warpaint catalog'}
        aria-label={catalogVisible ? 'Hide warpaint catalog' : 'Show warpaint catalog'}
        aria-pressed={catalogVisible}
        onClick={onToggleCatalog}
      >
        <PanelLeft size={15} />
      </button>
      <button
        type="button"
        className="stage-toolbar-btn stage-panel-toggle"
        title={controlsVisible ? 'Hide controls' : 'Show controls'}
        aria-label={controlsVisible ? 'Hide controls' : 'Show controls'}
        aria-pressed={controlsVisible}
        onClick={onToggleControls}
      >
        <PanelRight size={15} />
      </button>
      <span className="stage-toolbar-divider" aria-hidden="true" />
      <ToolbarButton label="Save PNG" icon={ImageDown} disabled={capturing} onAction={withCapture(onSavePng)} />
      <ToolbarButton label="Copy image" icon={Copy} disabled={capturing} onAction={withCapture(onCopyImage)} />
      <ToolbarButton label="Copy link" icon={Link} onAction={onCopyLink} />
      <ToolbarButton label="Reset view" icon={RotateCcw} onAction={onResetView} />
    </div>
  );
}
