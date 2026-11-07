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
} from 'lucide-react';
import { TOUCH_ONLY_DEVICE } from '../../device';
import { ControlLabel } from '../common/controls';
import { cn } from '../primitives/cn';
import { DIALOG_SURFACE, DIALOG_TITLE, DIALOG_VIEWPORT, DialogBody, DialogCloseButton, DialogHeader, DialogSection } from '../primitives/Dialog';
import { Kbd } from '../primitives/Kbd';

export type ControlsEditingMode = 'paint' | 'sticker' | 'lighting' | 'graph' | 'showcase' | null;

type ControlsHelpModalProps = {
  open: boolean;
  editingMode?: ControlsEditingMode;
  onClose: () => void;
  returnFocusRef: React.RefObject<HTMLButtonElement | null>;
};

const GRAPH_CHIP = 'inline-flex min-h-6.5 items-center rounded-sm border border-border bg-panel text-10 whitespace-nowrap text-dim';
const TRACE_MODE = 'inline-flex min-h-6.5 items-center gap-0.75 border-border px-1.5 not-first:border-l';
// Each column runs on by itself, so that a short section does not leave a hole beside a long one.
const COLUMN = 'flex min-w-0 flex-col gap-4';

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function Key({ children, label }: { children: React.ReactNode; label?: string }) {
  return <Kbd className="min-h-5 min-w-5" aria-label={label}>{children}</Kbd>;
}

function GraphControl({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return <span className={cn(GRAPH_CHIP, 'gap-1 px-1.75')}>{icon}<span>{children}</span></span>;
}

/** A short length of line, so the legend looks like what it describes. */
function Swatch({ type }: { type: 'texture' | 'mask' }) {
  return <span className={cn('inline-block h-0.75 w-6 rounded-full align-middle', type === 'texture' ? 'bg-graph-texture' : 'bg-graph-mask')} aria-hidden="true" />;
}

function ControlRow({ keys, children }: { keys: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-4 text-12 group-data-[mode=graph]:min-h-8 group-data-[mode=graph]:py-0.5">
      <span className="text-text">{children}</span>
      <span className="flex flex-none flex-wrap items-center justify-end gap-1">{keys}</span>
    </div>
  );
}

function ControlGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-2.5 border-t border-border/72 pt-2 first-of-type:mt-1.5">
      <h4 className="mt-0 mb-0.75"><ControlLabel>{title}</ControlLabel></h4>
      {children}
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

  const wide = editingMode === 'sticker' || editingMode === 'graph';

  return (
    <div
      className={DIALOG_VIEWPORT}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={cn(DIALOG_SURFACE, wide && 'w-[min(620px,100%)]')}
        data-slot="controls-help"
        role="dialog"
        aria-modal="true"
        data-camera-input-suspended=""
        aria-labelledby="controls-help-title"
        tabIndex={-1}
      >
        <DialogHeader>
          <h2 id="controls-help-title" className={DIALOG_TITLE}>Controls</h2>
          <DialogCloseButton aria-label="Close controls" onClick={onClose} />
        </DialogHeader>

        <DialogBody
          className={cn('group', wide ? 'grid grid-cols-2 gap-x-7 gap-y-4 max-[620px]:grid-cols-1' : 'flex flex-col gap-4.5')}
          data-mode={editingMode ?? 'camera'}
        >
          {editingMode === 'showcase' ? (
            <>
              <DialogSection id="showcase-board-heading" title="Board">
                <ControlRow keys={<><Key>Drag up from the tray</Key><Key>{TOUCH_ONLY_DEVICE ? 'Tap a card' : 'Click a card'}</Key></>}>Place a weapon</ControlRow>
                <ControlRow keys={<Key>Drag a weapon</Key>}>Move it, with the rest of the selection</ControlRow>
                <ControlRow keys={<Key>{TOUCH_ONLY_DEVICE ? 'Tap a weapon' : 'Click a weapon'}</Key>}>Select it</ControlRow>
                {!TOUCH_ONLY_DEVICE && (
                  <>
                    <ControlRow keys={<><Key>Ctrl</Key><Key>Click</Key></>}>Add a weapon to the selection, or take it out</ControlRow>
                    <ControlRow keys={<><Key>Shift</Key><Key>Click in the list</Key></>}>Select a run of weapons</ControlRow>
                  </>
                )}
                <ControlRow keys={<Key>Esc</Key>}>Deselect</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Z</Key></>}>Undo</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Y</Key></>}>Redo</ControlRow>
              </DialogSection>
              <DialogSection id="showcase-selected-heading" title="Selected or Carried Weapons">
                <ControlRow keys={<><Key>Q</Key><Key>E</Key></>}>Turn left or right by the rotation snap</ControlRow>
                <ControlRow keys={<><Key>R</Key><Key>Shift+R</Key></>}>Turn right or left</ControlRow>
                <ControlRow keys={<Key>F</Key>}>Show the other side</ControlRow>
                <ControlRow keys={<Key>Arrow keys</Key>}>Nudge one grid cell</ControlRow>
                <ControlRow keys={<><Key>Del</Key><Key>Backspace</Key></>}>Remove</ControlRow>
              </DialogSection>
              <DialogSection id="showcase-handles-heading" title="Handles">
                <ControlRow keys={<Key>Drag the rings</Key>}>Roll, tilt or turn</ControlRow>
                <ControlRow keys={<Key>Drag a dot on the weapon</Key>}>Pose a moving part</ControlRow>
                <ControlRow keys={<><Key>Shift</Key><Key>Drag</Key></>}>Turn or pose without snapping</ControlRow>
              </DialogSection>
            </>
          ) : editingMode === 'lighting' ? (
            <>
              <DialogSection id="lighting-pointer-heading" title="Light Editing">
                <ControlRow keys={<Key>{TOUCH_ONLY_DEVICE ? 'Tap marker' : 'Click marker'}</Key>}>Select a light</ControlRow>
                <ControlRow keys={<Key>Drag axis</Key>}>Move selected light</ControlRow>
                <ControlRow keys={<Key>Drag aim</Key>}>Aim a spot or sun light</ControlRow>
              </DialogSection>
              <DialogSection id="lighting-keyboard-heading" title="Selected Light">
                <ControlRow keys={<><Key>Ctrl</Key><Key>D</Key></>}>Duplicate</ControlRow>
                <ControlRow keys={<><Key>Del</Key><Key>Backspace</Key></>}>Delete</ControlRow>
                <ControlRow keys={<Key>H</Key>}>Turn on or off</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Z</Key></>}>Undo</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Y</Key></>}>Redo</ControlRow>
              </DialogSection>
              <DialogSection id="lighting-camera-heading" title="Camera">
                <ControlRow keys={<Key>Drag</Key>}>Rotate rig and weapon</ControlRow>
                {TOUCH_ONLY_DEVICE ? (
                  <>
                    <ControlRow keys={<Key>Pinch</Key>}>Zoom</ControlRow>
                    <ControlRow keys={<Key>Two-finger drag</Key>}>Move weapon</ControlRow>
                  </>
                ) : (
                  <>
                    <ControlRow keys={<><Key>Right drag</Key><Key>Middle drag</Key></>}>Move weapon</ControlRow>
                    <ControlRow keys={<Key>Scroll</Key>}>Zoom</ControlRow>
                  </>
                )}
              </DialogSection>
            </>
          ) : editingMode === 'graph' ? (
            <>
              <div className={COLUMN}>
              <DialogSection id="graph-canvas-heading" title="Graph Canvas">
                <ControlRow keys={<Key>Drag</Key>}>Pan the canvas</ControlRow>
                <ControlRow keys={<Key>Scroll</Key>}>Zoom</ControlRow>
                <ControlRow keys={<Key>Click a stage</Key>}>Select it and trace its path</ControlRow>
                <ControlRow keys={<Key>Drag a stage</Key>}>Move it</ControlRow>
                <ControlRow keys={<Key>Click empty space</Key>}>Clear the selection</ControlRow>
              </DialogSection>

              <DialogSection id="graph-connection-heading" title="Connections">
                <ControlGroup title="Wiring">
                  <ControlRow keys={<Key>Drag from a port</Key>}>Start a connection</ControlRow>
                  <ControlRow keys={<Key>Drop on a lit input</Key>}>Connect the two stages</ControlRow>
                  <ControlRow keys={<Key>Drag either end</Key>}>Move an existing connection</ControlRow>
                  <ControlRow keys={<Key>Hover a line</Key>}>Reveal its disconnect button</ControlRow>
                </ControlGroup>
                <ControlGroup title="What a Line Carries">
                  <ControlRow keys={<Swatch type="texture" />}>Texture, a painted surface</ControlRow>
                  <ControlRow keys={<Swatch type="mask" />}>Mask, where a surface applies</ControlRow>
                </ControlGroup>
              </DialogSection>
              </div>

              <div className={COLUMN}>
              <DialogSection id="graph-selected-heading" title="Selected Stage">
                <ControlRow keys={<><GraphControl icon={<Focus size={12} />}>Focus</GraphControl><Key>F</Key></>}>Focus it</ControlRow>
                <ControlRow keys={<><GraphControl icon={<Copy size={12} />}>Duplicate</GraphControl><Key>Ctrl+D</Key></>}>Duplicate</ControlRow>
                <ControlRow keys={<><GraphControl icon={<Trash2 size={12} />}>Delete</GraphControl><Key>Del</Key></>}>Remove the stage or connection</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>S</Key></>}>Save draft now</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Z</Key></>}>Undo paint edit</ControlRow>
                <ControlRow keys={<><Key>Ctrl</Key><Key>Y</Key></>}>Redo paint edit</ControlRow>
              </DialogSection>

              <DialogSection id="graph-toolbar-heading" title="Graph Toolbar">
                <ControlRow keys={<span className={cn(GRAPH_CHIP, 'min-w-28 justify-start gap-1.5 px-1.75')}><Search size={12} /> Find stages... <small className="ml-auto text-10 text-dim tabular-nums">1 of 4</small><ChevronUp size={11} /><ChevronDown size={11} /></span>}>Step through matches</ControlRow>
                <ControlRow keys={(
                  <span className={cn(GRAPH_CHIP, 'overflow-hidden')} aria-label="Trace all, inputs, or outputs">
                    <span className={cn(TRACE_MODE, 'bg-accent font-medium text-accent-text')}><Waypoints size={11} /> Both</span>
                    <span className={TRACE_MODE}><ArrowUp size={11} /> Inputs</span>
                    <span className={TRACE_MODE}><ArrowDown size={11} /> Outputs</span>
                  </span>
                )}>Trace direction</ControlRow>
                <ControlRow keys={<GraphControl icon={<LayoutDashboard size={12} />}>Arrange</GraphControl>}>Lay out every stage automatically</ControlRow>
                <ControlRow keys={<GraphControl icon={<Download size={12} />}>Export</GraphControl>}>Download a stage</ControlRow>
              </DialogSection>

              <DialogSection id="graph-picker-heading" title="Value Pickers">
                <ControlRow keys={<><Key label="Up arrow"><ArrowUp size={12} /></Key><Key label="Down arrow"><ArrowDown size={12} /></Key></>}>Move through the list</ControlRow>
                <ControlRow keys={<><Key>Home</Key><Key>End</Key></>}>Jump to either end</ControlRow>
                <ControlRow keys={<><Key>PgUp</Key><Key>PgDn</Key></>}>Move a screen at a time</ControlRow>
                <ControlRow keys={<Key>Enter</Key>}>Pick the highlighted entry</ControlRow>
                <ControlRow keys={<Key>Esc</Key>}>Cancel without changing it</ControlRow>
              </DialogSection>
              </div>
            </>
          ) : editingMode === 'sticker' ? (
            <>
              <DialogSection id="sticker-weapon-heading" title="On the Weapon">
                <ControlGroup title="Sticker">
                  <ControlRow keys={<Key>Drag handle</Key>}>Use the selected tool</ControlRow>
                  <ControlRow keys={<Key>Corner handle</Key>}>Scale evenly</ControlRow>
                  <ControlRow keys={<Key>Edge handle</Key>}>Change width or height</ControlRow>
                  <ControlRow keys={<><Key>Shift</Key><Key>Drag</Key></>}>Place on another surface</ControlRow>
                </ControlGroup>
                <ControlGroup title="Camera">
                  <ControlRow keys={<Key>Middle drag</Key>}>Rotate view</ControlRow>
                  <ControlRow keys={<Key>Right drag</Key>}>Pan view</ControlRow>
                  <ControlRow keys={<Key>Wheel</Key>}>Zoom view</ControlRow>
                  <ControlRow keys={<Key>Middle double-click</Key>}>Reset view</ControlRow>
                </ControlGroup>
                <ControlGroup title="Model Parts (Parts Tool)">
                  <ControlRow keys={<Key>Hover</Key>}>Preview the part under the pointer</ControlRow>
                  <ControlRow keys={<Key>Click</Key>}>Hide that part</ControlRow>
                  <ControlRow keys={<Key>Click outline</Key>}>Show a hidden part again</ControlRow>
                  <ControlRow keys={<Key>Esc</Key>}>Leave the picker, keeping parts hidden</ControlRow>
                  <ControlRow keys={<><Key>1</Key><Key>2</Key><Key>3</Key></>}>Leave for Move, Scale, or Turn</ControlRow>
                </ControlGroup>
              </DialogSection>

              <DialogSection id="sticker-uv-heading" title="In the UV View">
                <ControlGroup title="Pointer">
                  <ControlRow keys={<Key>Drag handles</Key>}>Move, scale, or turn</ControlRow>
                  <ControlRow keys={<Key>Ctrl</Key>}>Temporarily snap</ControlRow>
                  <ControlRow keys={<Key>Wheel</Key>}>Zoom view</ControlRow>
                  <ControlRow keys={<Key>Right drag</Key>}>Pan view</ControlRow>
                </ControlGroup>
                <ControlGroup title="Keyboard">
                  <ControlRow keys={<Key>Arrow keys</Key>}>Move</ControlRow>
                  <ControlRow keys={<Key>[ ]</Key>}>Scale</ControlRow>
                  <ControlRow keys={<Key>Q E</Key>}>Turn</ControlRow>
                  <ControlRow keys={<Key>+ -</Key>}>Zoom</ControlRow>
                  <ControlRow keys={<Key>0</Key>}>Fit texture to view</ControlRow>
                </ControlGroup>
              </DialogSection>

              <DialogSection id="sticker-history-heading" title="Edit History" className="col-span-full border-t border-border pt-3 max-[620px]:col-auto">
                <div className="grid grid-cols-2 gap-x-7 max-[620px]:grid-cols-1">
                  <ControlRow keys={<><Key>Ctrl</Key><Key>S</Key></>}>Save draft now</ControlRow>
                  <ControlRow keys={<><Key>Ctrl</Key><Key>Z</Key></>}>Undo</ControlRow>
                  <ControlRow keys={<><Key>Ctrl</Key><Key>Y</Key></>}>Redo</ControlRow>
                </div>
              </DialogSection>
            </>
          ) : (
            <>
          <DialogSection id="inspect-camera-heading" title="Inspect Camera">
            {TOUCH_ONLY_DEVICE ? (
              <>
                <ControlRow keys={<Key>Drag</Key>}>Rotate weapon</ControlRow>
                <ControlRow keys={<Key>Pinch</Key>}>Zoom</ControlRow>
                <ControlRow keys={<Key>Two-finger twist</Key>}>Roll weapon</ControlRow>
                <ControlRow keys={<Key>Two-finger drag</Key>}>Move weapon</ControlRow>
                <ControlRow keys={<Key>Double-tap</Key>}>Reset view</ControlRow>
              </>
            ) : (
              <>
                <ControlRow keys={<Key>Drag</Key>}>Rotate weapon</ControlRow>
                <ControlRow keys={<><Key>Right drag</Key><Key>Middle drag</Key></>}>Move weapon</ControlRow>
                <ControlRow keys={<Key>Scroll</Key>}>Zoom</ControlRow>
                <ControlRow keys={<Key>Double-click</Key>}>Reset view</ControlRow>
              </>
            )}
          </DialogSection>

          {editingMode === 'paint' ? (
            <DialogSection id="paint-editing-heading" title="Paint Editing">
              <ControlRow keys={<><Key>Shift</Key><Key>Click</Key></>}>Add or remove a part</ControlRow>
              <ControlRow keys={<Key>Drag</Key>}>Rotate weapon</ControlRow>
              <ControlRow keys={<><Key>Ctrl</Key><Key>S</Key></>}>Save draft now</ControlRow>
              <ControlRow keys={<><Key>Ctrl</Key><Key>Z</Key></>}>Undo paint edit</ControlRow>
              <ControlRow keys={<><Key>Ctrl</Key><Key>Y</Key></>}>Redo paint edit</ControlRow>
            </DialogSection>
          ) : !TOUCH_ONLY_DEVICE && (
            <DialogSection id="advanced-camera-heading" title="Advanced Camera">
              <ControlRow keys={<Key>Alt</Key>}>Enter or exit</ControlRow>
              <ControlRow keys={<Key>Mouse</Key>}>Look around</ControlRow>
              <ControlRow keys={<><Key>W</Key><Key>A</Key><Key>S</Key><Key>D</Key></>}>Fly and strafe</ControlRow>
              <ControlRow keys={<><Key>E</Key><Key>Space</Key></>}>Ascend</ControlRow>
              <ControlRow keys={<Key>Q</Key>}>Descend</ControlRow>
              <ControlRow keys={<Key>Ctrl</Key>}>Move faster</ControlRow>
              <ControlRow keys={<Key>Shift</Key>}>Move slower</ControlRow>
              <ControlRow keys={<Key>Esc</Key>}>Release cursor</ControlRow>
            </DialogSection>
          )}
            </>
          )}
        </DialogBody>

        {!editingMode && !TOUCH_ONLY_DEVICE && <p className="m-0 hidden border-t border-border px-4 py-2.5 text-11 leading-[1.4] text-dim mobile:block">Advanced camera requires a keyboard and mouse.</p>}
      </div>
    </div>
  );
}
