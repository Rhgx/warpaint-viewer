import { memo, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { SlidersHorizontal } from 'lucide-react';

import { joinData } from '../../data/loader';
import type { WeaponEntry } from '../../data/types';
import { isRigged } from '../../showcase/poseRigs';
import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { ShowcasePaint } from '../../showcase/showcaseTypes';
import { SearchField } from '../primitives/Input';
import { Button } from '../primitives/Button';

// The weapon tray under the board: search, then drag a card onto the board or click to add it.

const TRAY_DRAG_THRESHOLD = 6;
const TRAY_ICON = 'pointer-events-none h-10 w-16 object-contain';

/** The weapons of the selected paint. */
export const ShowcaseTray = memo(function ShowcaseTray({ board, paint, weapons, placedCounts }: {
  board: ShowcaseBoard | null;
  paint: ShowcasePaint | null;
  weapons: readonly WeaponEntry[];
  placedCounts: Readonly<Record<string, number>>;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? weapons.filter((weapon) => weapon.name.toLowerCase().includes(needle)) : weapons;
  }, [query, weapons]);

  const onCardPointerDown = (weapon: WeaponEntry) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    const row = rowRef.current;
    if (!board || !paint || !row || event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY, scroll: row.scrollLeft };
    const trayTop = row.getBoundingClientRect().top;
    let mode: 'pending' | 'scroll' | 'place' = 'pending';
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - start.x;
      const dy = moveEvent.clientY - start.y;
      // Upward is a pick-up, sideways inside the row is a scroll, and a scroll
      // that leaves the row upward turns into a pick-up after all.
      const leftUpward = moveEvent.clientY < trayTop;
      if (mode !== 'place' && (leftUpward || (mode === 'pending' && dy <= -TRAY_DRAG_THRESHOLD && -dy >= Math.abs(dx) * 0.5))) {
        mode = 'place';
        void board.beginExternalDrag(weapon.key, paint, moveEvent.clientX, moveEvent.clientY);
        return;
      }
      if (mode === 'pending' && Math.abs(dx) >= TRAY_DRAG_THRESHOLD) mode = 'scroll';
      if (mode === 'scroll') row.scrollLeft = start.scroll - dx;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (mode === 'pending') void board.addAt(weapon.key, paint);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="flex items-stretch gap-2.5 border-t border-border bg-panel px-2.5 py-2">
      <SearchField data-slot="board-tray-search" className="w-45 flex-none self-center" value={query} onChange={setQuery} placeholder="Filter weapons..." />
      <div
        ref={rowRef}
        className="flex min-w-0 gap-1.5 scrollbar-slim overflow-x-auto"
        onWheel={(event) => {
          if (event.deltaY && rowRef.current) rowRef.current.scrollLeft += event.deltaY;
        }}
      >
        {shown.map((weapon) => {
          const count = placedCounts[weapon.key] ?? 0;
          return (
            <Button
              key={weapon.key}
              data-slot="board-tray-item"
              className="relative h-auto w-21 flex-none cursor-grab touch-none flex-col justify-start gap-0.5 px-1 pt-1 pb-1.25 select-none active:cursor-grabbing"
              title={weapon.name}
              onPointerDown={onCardPointerDown(weapon)}
            >
              {weapon.icon ? <img className={TRAY_ICON} src={joinData(weapon.icon)} alt="" draggable={false} /> : <span className={TRAY_ICON} />}
              <span className="line-clamp-2 h-[2lh] max-w-full text-11 leading-tight">{weapon.name}</span>
              {isRigged(weapon.key) && <SlidersHorizontal size={11} className="absolute top-1 left-1 text-accent" aria-label="Has pose options" />}
              {count > 0 && <span className="absolute top-0.75 right-0.75 min-w-4 rounded-sm bg-accent px-1 text-center text-10 leading-4 font-bold text-accent-text">{count}</span>}
            </Button>
          );
        })}
      </div>
    </div>
  );
});
