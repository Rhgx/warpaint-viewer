import { useEffect, useRef } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Focus,
  LayoutDashboard,
  Search,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react';
import './ControlsHelpModal.css';

type ControlsHelpModalProps = {
  open: boolean;
  editingMode?: 'paint' | 'sticker' | 'lighting' | 'graph' | null;
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

function Key({ children, label }: { children: React.ReactNode; label?: string }) {
  return <kbd className="controls-help-key" aria-label={label}>{children}</kbd>;
}

function GraphControl({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <span className="controls-help-graph-control">{icon}<span>{children}</span></span>;
}

/** A short length of line, so the legend looks like what it describes. */
function Swatch({ type }: { type: 'texture' | 'mask' }) {
  return <span className="controls-help-swatch" data-type={type} aria-hidden="true" />;
}

function ControlRow({ keys, children }: { keys: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="controls-help-row">
      <span className="controls-help-label">{children}</span>
      <span className="controls-help-keys">{keys}</span>
    </div>
  );
}

export function ControlsHelpModal({ open, editingMode = null, onClose, returnFocusRef }: ControlsHelpModalProps) {
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

        <div className="controls-help-body" data-mode={editingMode ?? 'camera'}>
          {editingMode === 'lighting' ? (
            <>
              <section className="controls-help-section" aria-labelledby="lighting-pointer-heading">
                <h3 id="lighting-pointer-heading">Light editing</h3>
                <ControlRow keys={<Key>Click marker</Key>}>Select a light</ControlRow>
                <ControlRow keys={<Key>Drag axis</Key>}>Move selected light</ControlRow>
                <ControlRow keys={<Key>Drag aim</Key>}>Aim a spot or sun light</ControlRow>
              </section>
              <section className="controls-help-section" aria-labelledby="lighting-keyboard-heading">
                <h3 id="lighting-keyboard-heading">Selected light</h3>
                <ControlRow keys={<><Key>Ctrl</Key><Key>D</Key></>}>Duplicate</ControlRow>
                <ControlRow keys={<><Key>Del</Key><Key>Backspace</Key></>}>Delete</ControlRow>
                <ControlRow keys={<Key>H</Key>}>Turn on or off</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Z</Key></>}>Undo</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Y</Key></>}>Redo</ControlRow>
              </section>
              <section className="controls-help-section" aria-labelledby="lighting-camera-heading">
                <h3 id="lighting-camera-heading">Camera</h3>
                <ControlRow keys={<Key>Drag</Key>}>Rotate rig and weapon</ControlRow>
                <ControlRow keys={<><Key>Right drag</Key><Key>Middle drag</Key></>}>Move weapon</ControlRow>
                <ControlRow keys={<Key>Scroll</Key>}>Zoom</ControlRow>
              </section>
            </>
          ) : editingMode === 'graph' ? (
            <>
              <section className="controls-help-section" aria-labelledby="graph-canvas-heading">
                <h3 id="graph-canvas-heading">Graph canvas</h3>
                <ControlRow keys={<Key>Drag</Key>}>Pan the canvas</ControlRow>
                <ControlRow keys={<Key>Scroll</Key>}>Zoom</ControlRow>
                <ControlRow keys={<Key>Click a stage</Key>}>Select it and trace its path</ControlRow>
                <ControlRow keys={<Key>Drag a stage</Key>}>Move it</ControlRow>
                <ControlRow keys={<Key>Click empty space</Key>}>Clear the selection</ControlRow>
              </section>

              <section className="controls-help-section" aria-labelledby="graph-connection-heading">
                <h3 id="graph-connection-heading">Connections</h3>
                <div className="controls-help-group">
                  <h4>Wiring</h4>
                  <ControlRow keys={<Key>Drag from a port</Key>}>Start a connection</ControlRow>
                  <ControlRow keys={<Key>Drop on a lit input</Key>}>Connect the two stages</ControlRow>
                  <ControlRow keys={<Key>Drag either end</Key>}>Move an existing connection</ControlRow>
                  <ControlRow keys={<Key>Hover a line</Key>}>Reveal its disconnect button</ControlRow>
                </div>
                <div className="controls-help-group">
                  <h4>What a line carries</h4>
                  <ControlRow keys={<Swatch type="texture" />}>Texture, a painted surface</ControlRow>
                  <ControlRow keys={<Swatch type="mask" />}>Mask, where a surface applies</ControlRow>
                </div>
              </section>

              <section className="controls-help-section" aria-labelledby="graph-selected-heading">
                <h3 id="graph-selected-heading">Selected stage</h3>
                <ControlRow keys={<><GraphControl icon={<Focus size={12} />}>Focus</GraphControl><Key>F</Key></>}>Focus it</ControlRow>
                <ControlRow keys={<><GraphControl icon={<Copy size={12} />}>Duplicate</GraphControl><Key>Ctrl+D</Key></>}>Duplicate</ControlRow>
                <ControlRow keys={<><GraphControl icon={<Trash2 size={12} />}>Delete</GraphControl><Key>Del</Key></>}>Remove the stage or connection</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Z</Key></>}>Undo paint edit</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Y</Key></>}>Redo paint edit</ControlRow>
              </section>

              <section className="controls-help-section" aria-labelledby="graph-toolbar-heading">
                <h3 id="graph-toolbar-heading">Graph toolbar</h3>
                <ControlRow keys={<span className="controls-help-graph-search"><Search size={12} /> Find nodes <small>1/4</small><ChevronUp size={11} /><ChevronDown size={11} /></span>}>Search, then use the arrows or Enter to move between matches</ControlRow>
                <ControlRow keys={(
                  <span className="controls-help-graph-trace" aria-label="Trace all, inputs, or outputs">
                    <span data-active="true"><Waypoints size={11} /> Both</span>
                    <span><ArrowUp size={11} /> Inputs</span>
                    <span><ArrowDown size={11} /> Outputs</span>
                  </span>
                )}>Choose which connections to trace</ControlRow>
                <ControlRow keys={<GraphControl icon={<LayoutDashboard size={12} />}>Arrange</GraphControl>}>Lay out every stage automatically</ControlRow>
                <ControlRow keys={<GraphControl icon={<Download size={12} />}>Export</GraphControl>}>Choose PNG image or VTF texture</ControlRow>
              </section>

              <section className="controls-help-section" aria-labelledby="graph-picker-heading">
                <h3 id="graph-picker-heading">Value pickers</h3>
                <ControlRow keys={<><Key label="Up arrow"><ArrowUp size={12} /></Key><Key label="Down arrow"><ArrowDown size={12} /></Key></>}>Move through the list</ControlRow>
                <ControlRow keys={<><Key>Home</Key><Key>End</Key></>}>Jump to either end</ControlRow>
                <ControlRow keys={<><Key>PgUp</Key><Key>PgDn</Key></>}>Move a screen at a time</ControlRow>
                <ControlRow keys={<Key>Enter</Key>}>Pick the highlighted entry</ControlRow>
                <ControlRow keys={<Key>Esc</Key>}>Cancel without changing it</ControlRow>
              </section>
            </>
          ) : editingMode === 'sticker' ? (
            <>
              <section className="controls-help-section" aria-labelledby="sticker-weapon-heading">
                <h3 id="sticker-weapon-heading">On the weapon</h3>
                <div className="controls-help-group">
                  <h4>Sticker</h4>
                  <ControlRow keys={<Key>Drag handle</Key>}>Use the selected tool</ControlRow>
                  <ControlRow keys={<Key>Corner handle</Key>}>Scale evenly</ControlRow>
                  <ControlRow keys={<Key>Edge handle</Key>}>Change width or height</ControlRow>
                  <ControlRow keys={<><Key>Shift</Key><Key>Drag</Key></>}>Place on another surface</ControlRow>
                </div>
                <div className="controls-help-group">
                  <h4>Camera</h4>
                  <ControlRow keys={<Key>Middle drag</Key>}>Rotate view</ControlRow>
                  <ControlRow keys={<Key>Right drag</Key>}>Pan view</ControlRow>
                  <ControlRow keys={<Key>Wheel</Key>}>Zoom view</ControlRow>
                  <ControlRow keys={<Key>Middle double-click</Key>}>Reset view</ControlRow>
                </div>
                <div className="controls-help-group">
                  <h4>Model parts (Parts tool)</h4>
                  <ControlRow keys={<Key>Hover</Key>}>Preview the part under the pointer</ControlRow>
                  <ControlRow keys={<Key>Click</Key>}>Hide that part</ControlRow>
                  <ControlRow keys={<Key>Click outline</Key>}>Show a hidden part again</ControlRow>
                  <ControlRow keys={<Key>Esc</Key>}>Leave the picker, keeping parts hidden</ControlRow>
                  <ControlRow keys={<><Key>1</Key><Key>2</Key><Key>3</Key></>}>Leave for Move, Scale, or Turn</ControlRow>
                </div>
              </section>

              <section className="controls-help-section" aria-labelledby="sticker-uv-heading">
                <h3 id="sticker-uv-heading">In the UV view</h3>
                <div className="controls-help-group">
                  <h4>Pointer</h4>
                  <ControlRow keys={<Key>Drag handles</Key>}>Move, scale, or turn</ControlRow>
                  <ControlRow keys={<Key>Ctrl</Key>}>Temporarily snap</ControlRow>
                  <ControlRow keys={<Key>Wheel</Key>}>Zoom view</ControlRow>
                  <ControlRow keys={<Key>Right drag</Key>}>Pan view</ControlRow>
                </div>
                <div className="controls-help-group">
                  <h4>Keyboard</h4>
                  <ControlRow keys={<Key>Arrow keys</Key>}>Move</ControlRow>
                  <ControlRow keys={<Key>[ ]</Key>}>Scale</ControlRow>
                  <ControlRow keys={<Key>Q E</Key>}>Turn</ControlRow>
                  <ControlRow keys={<Key>+ -</Key>}>Zoom</ControlRow>
                  <ControlRow keys={<Key>0</Key>}>Fit texture to view</ControlRow>
                </div>
              </section>

              <section className="controls-help-section controls-help-history" aria-labelledby="sticker-history-heading">
                <h3 id="sticker-history-heading">Edit history</h3>
                <div className="controls-help-history-row">
                  <ControlRow keys={<><Key>Ctrl</Key><Key>Z</Key></>}>Undo</ControlRow>
                  <ControlRow keys={<><Key>Ctrl</Key><Key>Y</Key></>}>Redo</ControlRow>
                </div>
              </section>
            </>
          ) : (
            <>
          <section className="controls-help-section" aria-labelledby="inspect-camera-heading">
            <h3 id="inspect-camera-heading">Inspect camera</h3>
            <ControlRow keys={<Key>Drag</Key>}>Rotate weapon</ControlRow>
            <ControlRow keys={<><Key>Right drag</Key><Key>Middle drag</Key></>}>Move weapon</ControlRow>
            <ControlRow keys={<Key>Scroll</Key>}>Zoom</ControlRow>
            <ControlRow keys={<Key>Double-click</Key>}>Reset view</ControlRow>
          </section>

          {editingMode === 'paint' ? (
            <section className="controls-help-section" aria-labelledby="paint-editing-heading">
              <h3 id="paint-editing-heading">Paint editing</h3>
              <ControlRow keys={<><Key>Shift</Key><Key>Click</Key></>}>Add or remove a part</ControlRow>
              <ControlRow keys={<Key>Drag</Key>}>Rotate weapon</ControlRow>
              <ControlRow keys={<><Key>Ctrl</Key><Key>Z</Key></>}>Undo paint edit</ControlRow>
              <ControlRow keys={<><Key>Ctrl</Key><Key>Y</Key></>}>Redo paint edit</ControlRow>
            </section>
          ) : (
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
          )}
            </>
          )}
        </div>

        {!editingMode && <p className="controls-help-mobile-note">Advanced camera requires a keyboard and mouse.</p>}
      </div>
    </div>
  );
}
