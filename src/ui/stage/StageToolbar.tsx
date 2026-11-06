import { preloadIntent, type PreloadIntent } from '../../hooks/useIntentPreload';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Check, Copy, Download, Film, HelpCircle, LayoutGrid, PackagePlus, Rotate3d, RotateCcw, X } from 'lucide-react';
import { ControlsHelpModal, type ControlsEditingMode } from './ControlsHelpModal';
import { SettingsDialog } from './SettingsDialog';
import { TOUCH_ONLY_DEVICE, WORKSHOP_ENABLED } from '../../device';
import { useSettings } from '../../settings';
import { Toolbar, ToolbarButton, ToolbarDivider } from '../primitives/Toolbar';

type Feedback = 'idle' | 'success' | 'error';

const FEEDBACK_MS = 1500;

// One icon button that swaps its icon for Check/X after `onAction` settles. Feedback is local to each button.
function ActionButton({
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
    <ToolbarButton
      title={label}
      aria-label={label}
      disabled={disabled}
      data-feedback={feedback !== 'idle' ? feedback : undefined}
      onClick={handleClick}
    >
      <ShownIcon size={15} />
    </ToolbarButton>
  );
}

// Top-right canvas overlay. The capture actions share one "capturing" flag so they disable together;
// Reset and Auto spin stay available.
export function StageToolbar({
  workbenchOpen,
  editingMode = null,
  onToggleWorkbench,
  onPreloadWorkbench,
  captureFormat,
  saveLabel,
  onSave,
  onCopyImage,
  onResetView,
  autoSpin,
  onToggleAutoSpin,
  showAutoSpin,
  showcaseOpen,
  onToggleShowcase,
}: {
  workbenchOpen: boolean;
  editingMode?: Exclude<ControlsEditingMode, 'showcase'>;
  onToggleWorkbench: () => void;
  onPreloadWorkbench?: PreloadIntent;
  captureFormat: 'image' | 'animated';
  saveLabel: string;
  onSave: () => Promise<void>;
  onCopyImage: () => Promise<void>;
  onResetView: () => void;
  autoSpin: boolean;
  onToggleAutoSpin: () => void;
  showAutoSpin: boolean;
  showcaseOpen: boolean;
  onToggleShowcase: () => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const showcaseEnabled = useSettings((s) => s.showcaseBoard) && WORKSHOP_ENABLED;
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
      <Toolbar>
        {WORKSHOP_ENABLED && (
          <>
            <ToolbarButton
              title={workbenchOpen ? 'Close custom warpaint files' : 'Open custom warpaint files'}
              aria-label={workbenchOpen ? 'Close custom warpaint files' : 'Open custom warpaint files'}
              aria-pressed={workbenchOpen}
              {...preloadIntent('workbench', onPreloadWorkbench)}
              onClick={onToggleWorkbench}
            >
              <PackagePlus size={15} />
            </ToolbarButton>
            <ToolbarDivider />
          </>
        )}
        {showcaseEnabled && (
          <>
            <ToolbarButton
              title="Showcase board"
              aria-label="Open showcase board"
              aria-pressed={showcaseOpen}
              onClick={onToggleShowcase}
            >
              <LayoutGrid size={15} />
            </ToolbarButton>
            <ToolbarDivider />
          </>
        )}
        <ActionButton
          label={saveLabel}
          icon={captureFormat === 'animated' ? Film : Download}
          disabled={capturing}
          onAction={withCapture(onSave)}
        />
        {/* iOS drops the user gesture across the capture await, so the
            clipboard write fails on touch-only devices; Save still works. */}
        {captureFormat === 'image' && !TOUCH_ONLY_DEVICE && (
          <ActionButton label="Copy image" icon={Copy} disabled={capturing} onAction={withCapture(onCopyImage)} />
        )}
        <ToolbarDivider />
        {showAutoSpin && (
          <ToolbarButton
            title="Auto spin"
            aria-label="Auto spin"
            aria-pressed={autoSpin}
            onClick={onToggleAutoSpin}
          >
            <Rotate3d size={15} />
          </ToolbarButton>
        )}
        <ActionButton label="Reset view" icon={RotateCcw} onAction={onResetView} />
        <ToolbarDivider />
        <SettingsDialog />
        <ToolbarButton
          ref={controlsHelpTriggerRef}
          title="Controls"
          aria-label="Open controls reference"
          aria-haspopup="dialog"
          aria-expanded={controlsHelpOpen}
          onClick={() => setControlsHelpOpen(true)}
        >
          <HelpCircle size={15} />
        </ToolbarButton>
      </Toolbar>
      <ControlsHelpModal
        open={controlsHelpOpen}
        editingMode={editingMode}
        onClose={closeControlsHelp}
        returnFocusRef={controlsHelpTriggerRef}
      />
    </>
  );
}
