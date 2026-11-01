import { memo, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Search, SlidersHorizontal, X } from 'lucide-react';

import { joinData } from '../../data/loader';
import type { WeaponEntry } from '../../data/types';
import { isRigged } from '../../showcase/poseRigs';
import type { ShowcaseBoard } from '../../showcase/ShowcaseBoard';
import type { ShowcasePaint } from '../../showcase/showcaseTypes';
import { TextField } from '../common/controls';

// The weapon tray under the board: search, then drag a card onto the board or click to add it.

const TRAY_DRAG_THRESHOLD = 6;

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
    <div className="showcase-tray">
      <div className="search-field showcase-tray-search">
        <Search className="search-field-icon" size={14} />
        <TextField value={query} onChange={setQuery} placeholder="Search weapons"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) setQuery('');
          }} />
        {query.length > 0 && (
          <button type="button" className="search-clear-btn" title="Clear search" aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={13} />
          </button>
        )}
      </div>
      <div
        ref={rowRef}
        className="showcase-tray-items"
        onWheel={(event) => {
          if (event.deltaY && rowRef.current) rowRef.current.scrollLeft += event.deltaY;
        }}
      >
        {shown.map((weapon) => {
          const count = placedCounts[weapon.key] ?? 0;
          return (
            <button
              key={weapon.key}
              type="button"
              className="showcase-tray-item"
              title={weapon.name}
              onPointerDown={onCardPointerDown(weapon)}
            >
              {weapon.icon ? <img src={joinData(weapon.icon)} alt="" draggable={false} /> : <span className="showcase-tray-noicon" />}
              <span className="showcase-tray-name">{weapon.name}</span>
              {isRigged(weapon.key) && <SlidersHorizontal size={11} className="showcase-tray-posable" aria-label="Has pose options" />}
              {count > 0 && <span className="showcase-tray-count">{count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
});
