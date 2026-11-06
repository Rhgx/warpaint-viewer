import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical, Layers } from 'lucide-react';

import type { Grade, Manifest } from '../../data/types';
import { joinData } from '../../data/loader';
import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { FitProblem, ShowcaseItem } from '../../showcase/showcaseTypes';
import { Button } from '../primitives/Button';
import { EYE_ICON, EYE_OFF_ICON, Section } from './ShowcaseControls';

// The layer list: stacking order, visibility, and dragging rows to reorder.

const LAYER_ROW_HEIGHT = 36;
const LAYER_ICON = 'h-6.5 w-10 flex-none object-contain';

/** Placed weapons, front first like an image editor's layers. Handles reorder only when weapons may overlap; otherwise the list is for picking and hiding. */
function LayerList({ board, manifest, items, selectedIds, problems, reorderable, grades }: {
  board: ShowcaseBoard | null;
  manifest: Manifest;
  grades: ReadonlyMap<number, Grade | undefined>;
  items: readonly ShowcaseItem[];
  selectedIds: readonly string[];
  problems: Readonly<Record<string, FitProblem>>;
  reorderable: boolean;
}) {
  const [drag, setDrag] = useState<{ id: string; from: number; to: number } | null>(null);
  // Front first: the last item on the board is drawn on top.
  const layers = useMemo(() => [...items].reverse(), [items]);
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  // Where a Shift+click range starts: the row last clicked without Shift.
  const anchorRef = useRef<string | null>(null);
  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);
  const onRowClick = useCallback((id: string, event: ReactMouseEvent<HTMLLIElement>) => {
    if (!board) return;
    if (event.shiftKey && anchorRef.current) {
      const order = layersRef.current.map((item) => item.id);
      const from = order.indexOf(anchorRef.current);
      const to = order.indexOf(id);
      if (from >= 0 && to >= 0) {
        board.setSelection(order.slice(Math.min(from, to), Math.max(from, to) + 1));
        return;
      }
    }
    anchorRef.current = id;
    if (event.ctrlKey || event.metaKey) board.toggleSelected(id);
    else board.select(id);
  }, [board]);
  const icons = useMemo(() => new Map(manifest.weapons.map((weapon) => [weapon.key, weapon.icon])), [manifest]);
  const countRef = useRef(layers.length);
  useEffect(() => {
    countRef.current = layers.length;
  }, [layers.length]);

  const onHandleDown = useCallback((id: string, from: number, event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    let to = from;
    setDrag({ id, from, to });
    const move = (moveEvent: PointerEvent) => {
      to = Math.max(0, Math.min(countRef.current - 1, from + Math.round((moveEvent.clientY - startY) / LAYER_ROW_HEIGHT)));
      setDrag({ id, from, to });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      // Rows run front to back; the board stores back to front.
      if (to !== from) board?.reorder(id, countRef.current - 1 - to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [board]);

  if (!layers.length) return null;
  return (
    <ol className="m-0 flex list-none flex-col overflow-hidden rounded-sm border border-border p-0" style={{ '--layer-h': `${LAYER_ROW_HEIGHT}px` } as CSSProperties}>
      {layers.map((item, index) => {
        const offset = drag?.id === item.id
          ? (drag.to - drag.from) * LAYER_ROW_HEIGHT
          : drag && index > drag.from && index <= drag.to ? -LAYER_ROW_HEIGHT
            : drag && index < drag.from && index >= drag.to ? LAYER_ROW_HEIGHT : 0;
        return (
          <LayerRow key={item.id} board={board} item={item} index={index} grade={grades.get(item.paint.kitId)}
            icon={item.image ? board?.imageUrl(item.image.assetId) : icons.get(item.weaponKey) && joinData(icons.get(item.weaponKey) ?? '')}
            selected={selected.has(item.id)} problem={!!problems[item.id]} reorderable={reorderable}
            offset={offset} dragging={drag?.id === item.id} onHandleDown={onHandleDown} onRowClick={onRowClick} />
        );
      })}
    </ol>
  );
}

const GRIP_ICON = <GripVertical size={13} />;

/** One layer; rows whose weapon did not change skip re-rendering. */
const LayerRow = memo(function LayerRow({ board, item, index, icon, grade, selected, problem, reorderable, offset, dragging, onHandleDown, onRowClick }: {
  board: ShowcaseBoard | null;
  item: ShowcaseItem;
  index: number;
  icon: string | undefined;
  grade: Grade | undefined;
  selected: boolean;
  problem: boolean;
  reorderable: boolean;
  offset: number;
  dragging: boolean;
  onHandleDown: (id: string, from: number, event: ReactPointerEvent<HTMLSpanElement>) => void;
  onRowClick: (id: string, event: ReactMouseEvent<HTMLLIElement>) => void;
}) {
  return (
    <li
      className="group relative flex h-(--layer-h) cursor-pointer items-center gap-1.5 border-border bg-panel pr-1 pl-0.5 select-none [transition:transform_120ms_ease,background-color_120ms_ease] not-first:border-t hover:bg-panel-2 data-dragging:z-1 data-dragging:bg-panel-2 data-dragging:shadow-pop data-dragging:transition-none data-selected:not-data-dragging:bg-accent-soft data-selected:not-data-dragging:shadow-[inset_2px_0_0_var(--accent)]"
      data-selected={selected || undefined}
      data-hidden={item.hidden || undefined}
      data-dragging={dragging || undefined}
      data-problem={problem || undefined}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      onClick={(event) => !item.hidden && onRowClick(item.id, event)}
    >
      {reorderable && (
        <span className="flex cursor-grab touch-none items-center self-stretch px-px text-dim" title="Drag to change the order" onPointerDown={(event) => onHandleDown(item.id, index, event)}>
          {GRIP_ICON}
        </span>
      )}
      {icon ? <img className={`${LAYER_ICON} group-data-hidden:opacity-40`} src={icon} alt="" draggable={false} /> : <span className={LAYER_ICON} />}
      <span className="flex min-w-0 flex-1 flex-col leading-[1.2] group-data-hidden:opacity-40">
        <span className="truncate text-12 text-text group-data-problem:text-fail">{item.weaponName}</span>
        {/* Takes its grade colour, blended toward the text like the catalog list. */}
        <span className="truncate text-10 text-dim" style={grade ? { color: `color-mix(in srgb, var(--grade-${grade}) var(--grade-tint-strength), var(--text))` } : undefined}>{item.paint.kitName}</span>
      </span>
      <Button variant="ghost" size="icon-sm" className="flex-none" title={item.hidden ? 'Show' : 'Hide'}
        aria-label={item.hidden ? `Show ${item.weaponName}` : `Hide ${item.weaponName}`}
        onClick={(event) => {
          event.stopPropagation();
          board?.setHidden(item.id, !item.hidden);
        }}>
        {item.hidden ? EYE_OFF_ICON : EYE_ICON}
      </Button>
    </li>
  );
});

export const LayersSection = memo(function LayersSection({ board, manifest, items, selectedIds, problems, reorderable, grades, open, onOpenChange }: {
  board: ShowcaseBoard | null;
  manifest: Manifest;
  items: readonly ShowcaseItem[];
  selectedIds: readonly string[];
  problems: Readonly<Record<string, FitProblem>>;
  reorderable: boolean;
  grades: ReadonlyMap<number, Grade | undefined>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Section title={reorderable ? 'Layers' : 'Weapons'} icon={Layers} aside={<span className="font-normal text-dim tabular-nums">{items.length}</span>}
      open={open} onOpenChange={onOpenChange}>
      <LayerList board={board} manifest={manifest} items={items} selectedIds={selectedIds} problems={problems} reorderable={reorderable} grades={grades} />
    </Section>
  );
});
