import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Bookmark, Ellipsis, FolderOpen, History, Paintbrush, Pencil, Plus, RefreshCw, Save, Share2, Trash2, X } from 'lucide-react';

import { BOARD_HEIGHT, BOARD_WIDTH, LOGO_SPACE } from '../../showcase/boardMetrics';
import type { ShowcaseItem } from '../../showcase/showcaseTypes';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../primitives/Menu';
import { Tooltip, TooltipPopup, TooltipTrigger } from '../primitives/Tooltip';
import { Section } from './ShowcaseControls';
import { LAYOUT_FILE_EXTENSION } from './layoutFile';
import { SLOT_NAME_LIMIT, type LayoutSlot } from './layoutSlots';
import type { SavedLayouts } from './useSavedLayouts';

// The user's own saved boards, and sharing them as files. Nothing here asks "are you sure":
// every change can be taken back from the slot it happened to.

const TILE = 'group flex min-w-0 flex-auto cursor-pointer items-center gap-2 rounded-sm border border-border p-0.75 text-left text-dim transition-fast focus-ring not-disabled:hover:text-text disabled:cursor-default';
const TILE_PICTURE = 'grid h-9 w-16 flex-none place-items-center overflow-hidden rounded-xs';
const TILE_TEXT = 'flex min-w-0 flex-auto flex-col';
const TILE_NAME = 'line-clamp-2 text-12 leading-tight wrap-anywhere';
const TILE_META = 'truncate text-11 leading-tight text-dim';
const LINE = 'mx-0 mt-1.5 mb-0 flex items-baseline gap-2 text-12 leading-[1.4] text-dim';
const LINE_TEXT = 'min-w-0 flex-auto wrap-anywhere';
const LINE_ACTION = '-my-1 -mr-1.5 ml-auto flex-none';
const ROW_ACTION = 'h-auto w-7 min-w-7 flex-1';

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
      const row = root.current?.querySelector(`[data-slot="slots"] > :nth-child(${focus.index + 1})`);
      const inRow = { slot: '[data-slot="slot-load"], [data-slot="slot-new"]', more: '[data-slot="slot-more"]', restore: '[data-restore]' };
      const target = focus.target === 'undo' ? root.current?.querySelector<HTMLElement>('[data-undo]')
        : focus.target === 'open' ? root.current?.querySelector<HTMLElement>('[data-slot="slot-share"] button')
          : row?.querySelector<HTMLElement>(inRow[focus.target]);
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  return (
    <Section title="Saved Boards" icon={Bookmark} open={open} onOpenChange={onOpenChange}>
      <div ref={root} className="flex flex-col">
        <ul data-slot="slots" className="m-0 flex list-none flex-col gap-1 p-0">
          {slots.map((slot, index) => (
            <li key={index} className="relative flex min-h-13 min-w-0 items-stretch gap-1" data-active={activeSlot === index && slot ? '' : undefined}>
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
                  <button type="button" data-slot="slot-new" className={cn(TILE, 'border-dashed bg-transparent not-disabled:hover:border-strong')} data-deleted={backups[index] ? '' : undefined} disabled={!hasItems || busy} onClick={() => saved.saveTo(index)}>
                    <span className={cn(TILE_PICTURE, 'group-disabled:opacity-65 group-data-deleted:w-6', hasItems && 'text-text')}><Plus size={14} /></span>
                    <span className={TILE_TEXT}>
                      {/* Outside the disabled dimming: what can be recovered stays readable with nothing to save. */}
                      {backups[index] && <span data-slot="slot-meta" className={cn(TILE_NAME, 'text-dim')} title={backups[index].name}>Deleted: {backups[index].name}</span>}
                      {/* Takes its colour from the row, which is what brightens it on hover. */}
                      {(hasItems || !backups[index]) && <span data-slot="slot-name" className={cn(backups[index] ? TILE_META : TILE_NAME, 'text-inherit group-disabled:opacity-65')}>{hasItems ? 'Save Board Here' : 'Empty Slot'}</span>}
                    </span>
                  </button>
                  {backups[index] && (
                    <div data-slot="slot-deleted-actions" className="flex flex-none flex-col gap-0.5">
                      <Button size="sm" className="flex-1 text-text" data-restore="" disabled={busy} aria-label={`Restore deleted board ${backups[index].name}`} onClick={() => saved.restore(index)}>
                        Restore
                      </Button>
                      <Button size="sm" className="flex-1" disabled={busy} aria-label={`Clear deleted board ${backups[index].name}`} onClick={() => saved.clearDeleted(index)}>
                        Clear
                      </Button>
                    </div>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
        <div data-slot="slot-share" className="mt-1.5 grid grid-cols-2 items-center gap-1">
          <Button className="px-1 whitespace-nowrap" disabled={busy} title={`Open a ${LAYOUT_FILE_EXTENSION} file, or drop it anywhere on the page`}
            onClick={() => fileInput.current?.click()}>
            <FolderOpen size={13} /> Open File
          </Button>
          <Button className="px-1 whitespace-nowrap" disabled={busy || !hasItems} title={`Download this board as a ${LAYOUT_FILE_EXTENSION} file`}
            onClick={() => {
              const layout = saved.boardLayout();
              if (layout) void saved.exportLayout(layout);
            }}>
            <Share2 size={13} /> Share File
          </Button>
          <input ref={fileInput} type="file" accept={LAYOUT_FILE_EXTENSION} hidden aria-label="Board file to open"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              // Cleared so picking the same file again still counts as a change.
              event.currentTarget.value = '';
              if (file) void saved.importFile(file);
            }} />
        </div>
        {/* Mounted while empty, as screen readers can miss a live region that arrives along with its text. */}
        <div data-slot="slot-status" className="flex flex-col" role="status" aria-atomic="false">
          {boardUndo && (
            <p data-slot="slot-line" className={LINE}>
              <span className={LINE_TEXT}>{boardUndo.message}</span>
              <Button variant="link" size="inline" className={LINE_ACTION} data-undo="" aria-label={boardUndo.label} onClick={boardUndo.undo}>Undo</Button>
            </p>
          )}
          {note && (
            <p key={note.tick} data-slot="slot-line" className={note.visuallyHidden ? 'sr-only' : LINE}>
              <span className={LINE_TEXT}>{note.message}</span>
              {note.action && (
                <Button variant="link" size="inline" className={LINE_ACTION} data-restore={note.action.restores ? '' : undefined} data-note-action="" aria-label={note.action.ariaLabel} title={note.action.ariaLabel} onClick={note.action.run}>{note.action.label}</Button>
              )}
            </p>
          )}
        </div>
        <div data-slot="slot-status" className="flex flex-col" role="alert">
          {alert && (
            <p key={alert.tick} data-slot="slot-line" className={cn(LINE, 'text-text')} data-kind={alert.kind}>
              {alert.kind === 'warning'
                ? <AlertTriangle className="mt-0.5 flex-none self-start text-warn" size={13} aria-hidden="true" />
                : <AlertCircle className="mt-0.5 flex-none self-start text-fail" size={13} aria-hidden="true" />}
              <span className={LINE_TEXT}>{alert.message}</span>
              <Button variant="ghost" size="icon-sm" data-slot="slot-dismiss" className="-my-0.75 -mr-1.5 ml-0 flex-none self-start" aria-label="Dismiss this message" title="Dismiss" onClick={saved.dismissAlert}><X size={12} /></Button>
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
      <Tooltip>
        <TooltipTrigger delay={300} render={(
          // Off while renaming, or clicking away from the name field onto the thumbnail would replace the board.
          <button type="button" data-slot="slot-load" className={cn(TILE, 'bg-panel', active ? 'border-accent' : 'not-disabled:hover:border-strong')} disabled={disabled || renaming} aria-current={active ? 'true' : undefined}
            aria-label={`Load ${slot.name}, ${itemCount}, saved ${when}${modified ? ', changed since saved' : ''}. Replaces the board and settings.`} onClick={onLoad} />
        )}>
          <span className={cn(TILE_PICTURE, 'bg-panel-2')}>
            {slot.thumbnail ? <img className="block size-full object-contain" src={slot.thumbnail} alt="" draggable={false} /> : <SlotSketch items={slot.items} />}
          </span>
          <span className={TILE_TEXT}>
            {/* Kept while renaming, hidden, so that the row stays the same height. */}
            <span data-slot="slot-name" className={cn(TILE_NAME, 'text-text data-hidden:invisible')} data-hidden={renaming ? '' : undefined}>{slot.name}</span>
            {modified
              ? <span data-slot="slot-modified" className={cn(TILE_META, 'font-semibold text-accent')}>Changed</span>
              : <span data-slot="slot-meta" className={TILE_META}>{itemCount}, {shortDate(slot.savedAt)}</span>}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="left" sideOffset={16} data-slot="slot-preview" className="flex max-w-64 flex-col gap-1.5">
          {slot.thumbnail && <img className="block w-60 rounded-xs" src={slot.thumbnail} alt="" draggable={false} />}
          <span className="flex flex-col">
            <span>{slot.name}</span>
            <span className="whitespace-nowrap text-dim">Saved {when}</span>
          </span>
        </TooltipPopup>
      </Tooltip>
      {renaming && (
        <input data-slot="slot-rename" className="absolute inset-y-0 right-8 left-0 rounded-sm border border-accent bg-panel-2 px-2 [font-family:inherit] text-12 text-text outline-none" aria-label={`New name for ${slot.name}`} defaultValue={slot.name} maxLength={SLOT_NAME_LIMIT} autoFocus
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
      <div className="flex flex-none flex-col gap-0.5">
        {modified && !renaming && (
          <Button variant="accent" size="icon" data-slot="slot-update" className={ROW_ACTION} disabled={disabled} aria-label={`Update ${slot.name} with the current board`} title={`Update "${slot.name}" with the current board`} onClick={onSave}>
            <Save size={13} />
          </Button>
        )}
        <Menu onOpenChange={(open) => { if (open) focusTaken.current = false; }}>
          <MenuTrigger disabled={disabled} aria-label={`More actions for ${slot.name}`} title="More actions" render={<Button size="icon" data-slot="slot-more" className={ROW_ACTION} />}>
            <Ellipsis size={13} />
          </MenuTrigger>
          <MenuPopup align="end" finalFocus={() => !focusTaken.current}>
            <MenuItem onClick={() => { focusTaken.current = true; onLoad(); }}><FolderOpen size={13} /> Load</MenuItem>
            {paint && offerPaint && (
              <MenuItem disabled={uncovered === weapons.length} onClick={() => { focusTaken.current = true; onLoadInPaint(); }}>
                <Paintbrush size={13} />
                <span className="flex max-w-60 min-w-0 flex-col gap-px">
                  <span className="truncate">Load with {paint.name}</span>
                  <span className="text-11 text-dim group-data-highlighted:text-inherit group-data-highlighted:opacity-85">
                    {uncovered === weapons.length ? 'This paint covers none of these weapons.'
                      : `${uncovered ? `${uncovered} ${uncovered === 1 ? 'weapon keeps its' : 'weapons keep their'} paint. ` : ''}This save stays as it is.`}
                  </span>
                </span>
              </MenuItem>
            )}
            <MenuItem onClick={() => { focusTaken.current = true; onStartRename(); }}><Pencil size={13} /> Rename</MenuItem>
            <MenuItem onClick={onExport}><Share2 size={13} /> Share This Save as a File</MenuItem>
            <MenuSeparator />
            {/* Replacing a save with itself would only cost its way back. */}
            {!unchanged && <MenuItem disabled={!canSave} onClick={onSave}><RefreshCw size={13} /> Replace with Current Board</MenuItem>}
            {hasBackup && <MenuItem onClick={onRestore}><History size={13} /> Restore Previous Save</MenuItem>}
            <MenuItem variant="danger" onClick={() => { focusTaken.current = true; onDelete(); }}><Trash2 size={13} /> Delete</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
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
    <svg className="block size-full" viewBox={`0 0 ${SKETCH.width} ${SKETCH.height}`} aria-hidden="true">
      {items.filter((item) => !item.hidden).map((item) => {
        const x = (item.x / BOARD_WIDTH + 0.5) * SKETCH.width;
        const y = (0.5 - item.y / BOARD_HEIGHT) * SKETCH.height;
        const fit = item.image ? Math.min(LOGO_SPACE.width / item.image.aspect, LOGO_SPACE.height) * (SKETCH.width / BOARD_WIDTH) : 0;
        const width = (item.image ? fit * item.image.aspect : SKETCH_WEAPON.length) * item.scale;
        const height = (item.image ? fit : SKETCH_WEAPON.thickness) * item.scale;
        return (
          // Board rolls turn counterclockwise; SVG rotations turn clockwise.
          <rect key={item.id} x={x - width / 2} y={y - height / 2} width={width} height={height} rx={1}
            className={item.image ? 'fill-none stroke-dim stroke-1 [stroke-dasharray:2_2]' : 'fill-dim'} transform={`rotate(${-item.roll} ${x} ${y})`} />
        );
      })}
    </svg>
  );
}
