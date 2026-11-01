import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import { GripVertical } from 'lucide-react';

import type { Grade, Manifest } from '../../data/types';
import { joinData } from '../../data/loader';
import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { FitProblem, ShowcaseItem } from '../../showcase/showcaseTypes';
import { EYE_ICON, EYE_OFF_ICON, Section } from './ShowcaseControls';

// The layer list: stacking order, visibility, and dragging rows to reorder.

const LAYER_ROW_HEIGHT = 36;

/** Placed weapons, front first like an image editor's layers. Handles reorder only when weapons may overlap; otherwise the list is for picking and hiding. */
function LayerList({ board, manifest, items, selectedId, problems, reorderable, grades }: {
  board: ShowcaseBoard | null;
  manifest: Manifest;
  grades: ReadonlyMap<number, Grade | undefined>;
  items: readonly ShowcaseItem[];
  selectedId: string | null;
  problems: Readonly<Record<string, FitProblem>>;
  reorderable: boolean;
}) {
  const [drag, setDrag] = useState<{ id: string; from: number; to: number } | null>(null);
  // Front first: the last item on the board is drawn on top.
  const layers = useMemo(() => [...items].reverse(), [items]);
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
    <ol className="showcase-layers" style={{ '--layer-h': `${LAYER_ROW_HEIGHT}px` } as CSSProperties}>
      {layers.map((item, index) => {
        const offset = drag?.id === item.id
          ? (drag.to - drag.from) * LAYER_ROW_HEIGHT
          : drag && index > drag.from && index <= drag.to ? -LAYER_ROW_HEIGHT
            : drag && index < drag.from && index >= drag.to ? LAYER_ROW_HEIGHT : 0;
        return (
          <LayerRow key={item.id} board={board} item={item} index={index} icon={icons.get(item.weaponKey)} grade={grades.get(item.paint.kitId)}
            selected={item.id === selectedId} problem={!!problems[item.id]} reorderable={reorderable}
            offset={offset} dragging={drag?.id === item.id} onHandleDown={onHandleDown} />
        );
      })}
    </ol>
  );
}

const GRIP_ICON = <GripVertical size={13} />;

/** One layer; rows whose weapon did not change skip re-rendering. */
const LayerRow = memo(function LayerRow({ board, item, index, icon, grade, selected, problem, reorderable, offset, dragging, onHandleDown }: {
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
}) {
  return (
    <li
      className="showcase-layer"
      data-selected={selected || undefined}
      data-hidden={item.hidden || undefined}
      data-dragging={dragging || undefined}
      data-problem={problem || undefined}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      onClick={() => !item.hidden && board?.select(item.id)}
    >
      {reorderable && (
        <span className="showcase-layer-handle" title="Drag to change the order" onPointerDown={(event) => onHandleDown(item.id, index, event)}>
          {GRIP_ICON}
        </span>
      )}
      {icon ? <img src={joinData(icon)} alt="" draggable={false} /> : <span className="showcase-layer-noicon" />}
      <span className="showcase-layer-text">
        <span className="showcase-layer-name">{item.weaponName}</span>
        <span className="showcase-layer-paint showcase-paint-name" data-grade={grade}>{item.paint.kitName}</span>
      </span>
      <button type="button" className="showcase-layer-eye" title={item.hidden ? 'Show' : 'Hide'}
        aria-label={item.hidden ? `Show ${item.weaponName}` : `Hide ${item.weaponName}`}
        onClick={(event) => {
          event.stopPropagation();
          board?.setHidden(item.id, !item.hidden);
        }}>
        {item.hidden ? EYE_OFF_ICON : EYE_ICON}
      </button>
    </li>
  );
});

export const LayersSection = memo(function LayersSection({ board, manifest, items, selectedId, problems, reorderable, grades }: {
  board: ShowcaseBoard | null;
  manifest: Manifest;
  items: readonly ShowcaseItem[];
  selectedId: string | null;
  problems: Readonly<Record<string, FitProblem>>;
  reorderable: boolean;
  grades: ReadonlyMap<number, Grade | undefined>;
}) {
  return (
    <Section title={reorderable ? 'Layers' : 'Weapons'} aside={<span className="showcase-section-count">{items.length}</span>}>
      <LayerList board={board} manifest={manifest} items={items} selectedId={selectedId} problems={problems} reorderable={reorderable} grades={grades} />
    </Section>
  );
});
