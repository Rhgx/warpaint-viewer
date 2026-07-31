import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import './ControlsHelpModal.css';

type ControlsHelpModalProps = {
  open: boolean;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
};

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="controls-help-key">{children}</kbd>;
}

function ControlRow({ keys, children }: { keys: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="controls-help-row">
      <span className="controls-help-label">{children}</span>
      <span className="controls-help-keys">{keys}</span>
    </div>
  );
}

export function ControlsHelpModal({ open, onClose, returnFocusRef }: ControlsHelpModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const returnFocusTarget = returnFocusRef.current;
    if (!dialog) return;

    const focusInitial = window.requestAnimationFrame(() => {
      dialog.querySelector<HTMLElement>(focusableSelector)?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector));
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.cancelAnimationFrame(focusInitial);
      window.removeEventListener('keydown', handleKeyDown);
      returnFocusTarget?.focus();
    };
  }, [open, onClose, returnFocusRef]);

  if (!open) return null;

  return (
    <div
      className="controls-help-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="controls-help-modal"
        role="dialog"
        aria-modal="true"
        data-camera-input-suspended=""
        aria-labelledby="controls-help-title"
        tabIndex={-1}
      >
        <header className="controls-help-header">
          <h2 id="controls-help-title">Controls</h2>
          <button type="button" className="controls-help-close" aria-label="Close controls" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        <div className="controls-help-body">
          <section className="controls-help-section" aria-labelledby="inspect-camera-heading">
            <h3 id="inspect-camera-heading">Inspect camera</h3>
            <ControlRow keys={<Key>Drag</Key>}>Rotate weapon</ControlRow>
            <ControlRow keys={<><Key>Right drag</Key><Key>Middle drag</Key></>}>Move weapon</ControlRow>
            <ControlRow keys={<Key>Scroll</Key>}>Zoom</ControlRow>
            <ControlRow keys={<Key>Double-click</Key>}>Reset view</ControlRow>
          </section>

          <section className="controls-help-section" aria-labelledby="advanced-camera-heading">
            <h3 id="advanced-camera-heading">Advanced camera</h3>
            <ControlRow keys={<Key>Alt</Key>}>Enter or exit</ControlRow>
            <ControlRow keys={<Key>Mouse</Key>}>Look around</ControlRow>
            <ControlRow keys={<><Key>W</Key><Key>A</Key><Key>S</Key><Key>D</Key></>}>Fly and strafe</ControlRow>
            <ControlRow keys={<><Key>E</Key><Key>Space</Key></>}>Ascend</ControlRow>
            <ControlRow keys={<Key>Q</Key>}>Descend</ControlRow>
            <ControlRow keys={<Key>Ctrl</Key>}>Move faster</ControlRow>
            <ControlRow keys={<Key>Shift</Key>}>Move slower</ControlRow>
            <ControlRow keys={<Key>Esc</Key>}>Release cursor</ControlRow>
          </section>
        </div>

        <p className="controls-help-mobile-note">Advanced camera requires a keyboard and mouse.</p>
      </div>
    </div>
  );
}
