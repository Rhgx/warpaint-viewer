import { useEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Tooltip } from '@base-ui/react/tooltip';
import { AlertTriangle, Ellipsis, FolderOpen, History, Paintbrush, Pencil, Plus, RefreshCw, Save, Share2, Trash2, X } from 'lucide-react';

import { BOARD_HEIGHT, BOARD_WIDTH, LOGO_SPACE } from '../../showcase/boardMetrics';
import type { ShowcaseItem } from '../../showcase/showcaseTypes';
import { Section } from './ShowcaseControls';
import { LAYOUT_FILE_EXTENSION } from './layoutFile';
import { SLOT_NAME_LIMIT, type LayoutSlot } from './layoutSlots';
import type { SavedLayouts } from './useSavedLayouts';

// The user's own saved boards, and sharing them as files. Nothing here asks "are you sure":
// every change can be taken back from the slot it happened to.

export function SavedLayoutsSection({ saved, hasItems, open, onOpenChange }: {
  saved: SavedLayouts;
  hasItems: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { slots, backups, activeSlot, modified, unchanged, busy, focus, note, alert, boardUndo } = saved;
  const [renaming, setRenaming] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const root = useRef<HTMLDivElement | null>(null);

  // The control that was used is often gone by now, which would drop keyboard users back at the top of the page.
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => {
      // Someone quicker than this frame has already moved on to another control, such as a slot's menu.
      if (root.current?.contains(document.activeElement)) return;
      const row = root.current?.querySelector(`.showcase-slots > :nth-child(${focus.index + 1})`);
      const inRow = { slot: '.showcase-slot-load, .showcase-slot-new', more: '.showcase-slot-more', restore: '[data-restore]' };
      const target = focus.target === 'undo' ? root.current?.querySelector<HTMLElement>('[data-undo]')
        : focus.target === 'open' ? root.current?.querySelector<HTMLElement>('.showcase-share button')
          : row?.querySelector<HTMLElement>(inRow[focus.target]);
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  const firstEmpty = slots.indexOf(null);
  const fullUp = firstEmpty < 0 && activeSlot === null && hasItems;
  return (
    <Section title="Saved boards" open={open} onOpenChange={onOpenChange}>
      <div ref={root} className="showcase-saved">
        <ul className="showcase-slots">
          {slots.map((slot, index) => (
            <li key={index} className="showcase-slot" data-active={activeSlot === index && slot ? '' : undefined}>
              {slot ? (
                <FilledSlot slot={slot} disabled={busy} active={activeSlot === index} modified={activeSlot === index && modified} unchanged={activeSlot === index && unchanged} canSave={hasItems} renaming={renaming === index}
                  paint={saved.selectedPaint} hasBackup={!!backups[index]} onRestore={() => saved.restore(index)} onLoadInPaint={() => void saved.loadInPaint(index)}
                  onLoad={() => void saved.load(index)} onSave={() => saved.saveTo(index)} onDelete={() => saved.remove(index)} onExport={() => void saved.exportLayout(slot)}
                  onStartRename={() => setRenaming(index)}
                  onRename={(name, returnFocus) => {
                    setRenaming(null);
                    saved.rename(index, name);
                    if (returnFocus) saved.focusOn('more', index);
                  }}
                  onCancelRename={() => {
                    setRenaming(null);
                    saved.focusOn('more', index);
                  }} />
              ) : (
                <>
                  <button type="button" className="showcase-slot-new" data-deleted={backups[index] ? '' : undefined} disabled={!hasItems || busy} onClick={() => saved.saveTo(index)}>
                    <span className="showcase-slot-picture"><Plus size={14} /></span>
                    <span className="showcase-slot-text">
                      <span className="showcase-slot-name">{backups[index] && hasItems ? 'Save board here' : 'Empty slot'}</span>
                      {backups[index]
                        ? <span className="showcase-slot-meta" title={backups[index].name}>Deleted: {backups[index].name}</span>
                        // Once is enough to say why they cannot be used yet.
                        : (hasItems || index === firstEmpty) && <span className="showcase-slot-meta">{hasItems ? 'Save board here' : 'Nothing to save yet'}</span>}
                    </span>
                  </button>
                  {backups[index] && (
                    <div className="showcase-slot-deleted-actions">
                      <button type="button" className="showcase-btn" data-restore="" disabled={busy} aria-label={`Restore deleted board ${backups[index].name}`} onClick={() => saved.restore(index)}>
                        Restore
                      </button>
                      <button type="button" className="showcase-btn" disabled={busy} aria-label={`Clear deleted board ${backups[index].name}`} onClick={() => saved.clearDeleted(index)}>
                        Clear
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        {fullUp && <p className="showcase-slot-line showcase-slot-full"><span>All slots are full.</span></p>}
        <div className="showcase-share">
          <button type="button" className="showcase-btn" disabled={busy} title={`Open a ${LAYOUT_FILE_EXTENSION} file, or drop it anywhere on the page`}
            onClick={() => fileInput.current?.click()}>
            <FolderOpen size={13} /> Open file
          </button>
          <button type="button" className="showcase-btn" disabled={busy || !hasItems} title={`Download this board as a ${LAYOUT_FILE_EXTENSION} file`}
            onClick={() => {
              const layout = saved.boardLayout();
              if (layout) void saved.exportLayout(layout);
            }}>
            <Share2 size={13} /> Share file
          </button>
          <input ref={fileInput} type="file" accept={LAYOUT_FILE_EXTENSION} hidden aria-label="Board file to open"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              // Cleared so picking the same file again still counts as a change.
              event.currentTarget.value = '';
              if (file) void saved.importFile(file);
            }} />
        </div>
        {/* Mounted while empty, as screen readers can miss a live region that arrives along with its text. */}
        <div className="showcase-slot-status" role="status" aria-atomic="false">
          {boardUndo && (
            <p className="showcase-slot-line">
              <span>{boardUndo.message}</span>
              <button type="button" data-undo="" aria-label={boardUndo.label} onClick={boardUndo.undo}>Undo</button>
            </p>
          )}
          {note && (
            <p key={note.tick} className="showcase-slot-line">
              <span>{note.message}</span>
              {note.action && (
                <button type="button" data-restore={note.action.restores ? '' : undefined} data-note-action="" aria-label={note.action.ariaLabel} title={note.action.ariaLabel} onClick={note.action.run}>{note.action.label}</button>
              )}
            </p>
          )}
        </div>
        <div className="showcase-slot-status" role="alert">
          {alert && (
            <p key={alert.tick} className="showcase-slot-line" data-kind={alert.kind}>
              {alert.kind === 'warning' && <AlertTriangle size={13} aria-hidden="true" />}
              <span>{alert.message}</span>
              <button type="button" className="showcase-slot-dismiss" aria-label="Dismiss this message" title="Dismiss" onClick={saved.dismissAlert}><X size={12} /></button>
            </p>
          )}
        </div>
      </div>
    </Section>
  );
}

function FilledSlot({ slot, disabled, active, modified, unchanged, canSave, renaming, paint, hasBackup, onRestore, onLoadInPaint, onLoad, onSave, onDelete, onExport, onStartRename, onRename, onCancelRename }: {
  slot: LayoutSlot;
  disabled: boolean;
  active: boolean;
  modified: boolean;
  unchanged: boolean;
  canSave: boolean;
  renaming: boolean;
  paint: { id: number; name: string; weapons: readonly string[] } | null;
  hasBackup: boolean;
  onRestore: () => void;
  onLoadInPaint: () => void;
  onLoad: () => void;
  onSave: () => void;
  onDelete: () => void;
  onExport: () => void;
  onStartRename: () => void;
  onRename: (name: string, returnFocus: boolean) => void;
  onCancelRename: () => void;
}) {
  const itemCount = `${slot.items.length} ${slot.items.length === 1 ? 'item' : 'items'}`;
  const when = savedWhen(slot.savedAt);
  // Set when the action that closes the menu moves the focus itself, so the menu must not move it back to its button.
  const focusTaken = useRef(false);
  const enterPressed = useRef(false);
  const weapons = slot.items.filter((item) => !item.image);
  const uncovered = paint ? weapons.filter((item) => !paint.weapons.includes(item.weaponKey)).length : 0;
  // Nothing to offer when this save already wears that paint throughout.
  const offerPaint = paint && weapons.some((item) => item.paint.kitId !== paint.id);
  return (
    <>
      <Tooltip.Root>
        <Tooltip.Trigger delay={300} render={(
          // Off while renaming, or clicking away from the name field onto the thumbnail would replace the board.
          <button type="button" className="showcase-slot-load" disabled={disabled || renaming} aria-current={active ? 'true' : undefined}
            aria-label={`Load ${slot.name}, ${itemCount}, saved ${when}${modified ? ', changed since saved' : ''}. Replaces the board and settings.`} onClick={onLoad} />
        )}>
          <span className="showcase-slot-picture">
            {slot.thumbnail ? <img src={slot.thumbnail} alt="" draggable={false} /> : <SlotSketch items={slot.items} />}
          </span>
          <span className="showcase-slot-text">
            {/* Kept while renaming, hidden, so that the row stays the same height. */}
            <span className="showcase-slot-name" data-hidden={renaming ? '' : undefined}>{slot.name}</span>
            {modified
              ? <span className="showcase-slot-meta showcase-slot-modified">Changed</span>
              : <span className="showcase-slot-meta">{itemCount}, {shortDate(slot.savedAt)}</span>}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="left" sideOffset={8} collisionPadding={10} className="showcase-hint-positioner">
            <Tooltip.Popup className="showcase-hint-popup showcase-slot-preview">
              {slot.thumbnail && <img src={slot.thumbnail} alt="" draggable={false} />}
              <span>{slot.name}, saved {when}</span>
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
      {renaming && (
        <input className="showcase-slot-rename" aria-label={`New name for ${slot.name}`} defaultValue={slot.name} maxLength={SLOT_NAME_LIMIT} autoFocus
          onFocus={(event) => {
            event.currentTarget.select();
            // Selecting scrolls to the end of a long name, which hides how it starts.
            event.currentTarget.scrollLeft = 0;
          }}
          onBlur={(event) => {
            focusTaken.current = false;
            onRename(event.currentTarget.value, enterPressed.current);
            enterPressed.current = false;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              enterPressed.current = true;
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              focusTaken.current = false;
              onCancelRename();
            }
          }} />
      )}
      {modified && !renaming && (
        <button type="button" className="showcase-btn showcase-slot-update" disabled={disabled} aria-label={`Update ${slot.name} with the current board`} title={`Update "${slot.name}" with the current board`} onClick={onSave}>
          <Save size={13} />
        </button>
      )}
      <Menu.Root onOpenChange={(open) => { if (open) focusTaken.current = false; }}>
        <Menu.Trigger className="showcase-btn showcase-slot-more" disabled={disabled} aria-label={`More actions for ${slot.name}`} title="More actions">
          <Ellipsis size={13} />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={10} className="showcase-hint-positioner">
            <Menu.Popup className="showcase-menu" finalFocus={() => !focusTaken.current}>
              <Menu.Item className="showcase-menu-item" onClick={() => { focusTaken.current = true; onLoad(); }}><FolderOpen size={13} /> Load</Menu.Item>
              {paint && offerPaint && (
                <Menu.Item className="showcase-menu-item" disabled={uncovered === weapons.length} onClick={() => { focusTaken.current = true; onLoadInPaint(); }}>
                  <Paintbrush size={13} />
                  <span className="showcase-menu-text">
                    <span className="showcase-menu-title">Load with {paint.name}</span>
                    <span className="showcase-menu-detail">
                      {uncovered === weapons.length ? 'This paint covers none of these weapons.'
                        : `${uncovered ? `${uncovered} ${uncovered === 1 ? 'weapon keeps its' : 'weapons keep their'} paint. ` : ''}This save stays as it is.`}
                    </span>
                  </span>
                </Menu.Item>
              )}
              <Menu.Item className="showcase-menu-item" onClick={() => { focusTaken.current = true; onStartRename(); }}><Pencil size={13} /> Rename</Menu.Item>
              <Menu.Item className="showcase-menu-item" onClick={onExport}><Share2 size={13} /> Share this save as a file</Menu.Item>
              <Menu.Separator className="showcase-menu-separator" />
              {/* Replacing a save with itself would only cost its way back. */}
              {!unchanged && <Menu.Item className="showcase-menu-item" disabled={!canSave} onClick={onSave}><RefreshCw size={13} /> Replace with current board</Menu.Item>}
              {hasBackup && <Menu.Item className="showcase-menu-item" onClick={onRestore}><History size={13} /> Restore previous save</Menu.Item>}
              <Menu.Item className="showcase-menu-item" data-danger="" onClick={() => { focusTaken.current = true; onDelete(); }}><Trash2 size={13} /> Delete</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
}

// In the language of the interface, not the browser's.
const savedWhen = (savedAt: number) => new Date(savedAt).toLocaleString('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const shortDate = (savedAt: number) => new Date(savedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' });

const SKETCH = { width: 64, height: 36 };
/** Length and thickness of a weapon's bar at 100%; a sketch has no measurements to go on, so it is only a likeness. */
const SKETCH_WEAPON = { length: 20, thickness: 3 };

/** Where things sat on the board, for a slot with no picture of itself. */
function SlotSketch({ items }: { items: readonly ShowcaseItem[] }) {
  return (
    <svg viewBox={`0 0 ${SKETCH.width} ${SKETCH.height}`} aria-hidden="true">
      {items.filter((item) => !item.hidden).map((item) => {
        const x = (item.x / BOARD_WIDTH + 0.5) * SKETCH.width;
        const y = (0.5 - item.y / BOARD_HEIGHT) * SKETCH.height;
        const fit = item.image ? Math.min(LOGO_SPACE.width / item.image.aspect, LOGO_SPACE.height) * (SKETCH.width / BOARD_WIDTH) : 0;
        const width = (item.image ? fit * item.image.aspect : SKETCH_WEAPON.length) * item.scale;
        const height = (item.image ? fit : SKETCH_WEAPON.thickness) * item.scale;
        return (
          // Board rolls turn counterclockwise; SVG rotations turn clockwise.
          <rect key={item.id} x={x - width / 2} y={y - height / 2} width={width} height={height} rx={1}
            className={item.image ? 'showcase-slot-image' : undefined} transform={`rotate(${-item.roll} ${x} ${y})`} />
        );
      })}
    </svg>
  );
}
