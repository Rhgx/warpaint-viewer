import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ScrollArea } from '@base-ui/react/scroll-area';
import { ArrowDownNarrowWide, ArrowUpNarrowWide, LayoutGrid, List, Search, X } from 'lucide-react';
import { AssetIcon, SelectField, TextField } from './components';
import type { PaintkitEntry } from '../data/types';

interface CollectionRow {
  name: string;
  count: number;
  minId: number;
}

type Group = readonly [string, PaintkitEntry[]];
type CatalogView = 'grid' | 'list';

const VIEW_STORAGE_KEY = 'warpaint-viewer:catalog-view';

function loadStoredView(): CatalogView {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY) === 'grid' ? 'grid' : 'list';
  } catch {
    return 'list';
  }
}

// Highest grade first; unknown grade sorts last. Ties broken by name.
const GRADE_RANK: Record<string, number> = {
  elite: 6,
  assassin: 5,
  commando: 4,
  mercenary: 3,
  freelance: 2,
  civilian: 1,
};

function byGradeThenName(a: PaintkitEntry, b: PaintkitEntry): number {
  const rankDiff = (GRADE_RANK[b.grade ?? ''] ?? 0) - (GRADE_RANK[a.grade ?? ''] ?? 0);
  return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name);
}

// Counts how many grid tiles share the first tile's row inside `group`, used
// to turn ArrowUp/ArrowDown into a row-height jump in grid view. Falls back
// to 1 (behaves like ArrowLeft/ArrowRight) if the DOM doesn't cooperate.
function countGridColumns(group: Element | null): number {
  if (!group) return 1;
  const tiles = group.querySelectorAll<HTMLElement>('.warpaint-tile');
  if (tiles.length === 0) return 1;
  const firstTop = tiles[0].offsetTop;
  let count = 0;
  for (const tile of tiles) {
    if (tile.offsetTop !== firstTop) break;
    count += 1;
  }
  return count || 1;
}

// Left panel: a search field and a collection dropdown filter a grouped
// warpaint list. Collections and paints share one oldest/newest order toggle
// (proxy: ascending minimum paintkit id, which tracks release order).
// Typing in the filter searches every paintkit and collection name, ignoring
// whichever collection is selected. ?sortdesc=1 presets descending order.
export function WarpaintList({
  paintkits,
  selectedId,
  onSelect,
  collectionIcons,
  paintIcons,
}: {
  paintkits: PaintkitEntry[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  collectionIcons: Record<string, string>;
  paintIcons: Record<number, string>;
}) {
  const [filter, setFilter] = useState('');
  const [reversed, setReversed] = useState(() => {
    // Newest first by default (proxy: descending collection release order).
    // ?sortdesc=0 forces oldest first; ?sortdesc=1 is redundant but honored.
    const param = new URLSearchParams(window.location.search).get('sortdesc');
    return param === null ? true : param === '1';
  });
  const [activeCollection, setActiveCollection] = useState<string | null>(null);
  const [view, setView] = useState<CatalogView>(loadStoredView);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, view);
    } catch {
      // Storage may be unavailable (private browsing, quota); the toggle
      // still works for the session, it just won't persist.
    }
  }, [view]);

  const collections = useMemo<CollectionRow[]>(() => {
    const byName = new Map<string, CollectionRow>();
    for (const p of paintkits) {
      const name = p.collection ?? 'Uncategorized';
      const row = byName.get(name);
      if (row) {
        row.count += 1;
        row.minId = Math.min(row.minId, p.id);
      } else {
        byName.set(name, { name, count: 1, minId: p.id });
      }
    }
    const list = [...byName.values()].sort((a, b) => a.minId - b.minId);
    return reversed ? list.reverse() : list;
  }, [paintkits, reversed]);

  const collectionOptions = useMemo(
    () => [
      { value: '', label: 'All collections' },
      ...collections.map((c) => ({ value: c.name, label: `${c.name} (${c.count})` })),
    ],
    [collections],
  );

  const q = filter.trim().toLowerCase();
  const isFiltering = q.length > 0;
  // A filter, or the "All" entry, spans every collection and needs group
  // headers; a single selected collection is already unambiguous.
  const showGroupHeaders = isFiltering || activeCollection === null;
  // A collection has only a handful of thumbnail assets (at most 15). Native
  // lazy loading can defer all of them after this panel is swapped into view,
  // which made a newly opened collection look empty for seconds. Keep the
  // large, all-collections catalogue lazy, but fetch the chosen collection's
  // compact set immediately.
  const prioritizePaintIcons = activeCollection !== null && !isFiltering;

  const groups = useMemo<Group[]>(() => {
    const source = isFiltering
      ? paintkits.filter(
          (p) =>
            p.name.toLowerCase().includes(q) || (p.collection ?? 'Uncategorized').toLowerCase().includes(q),
        )
      : activeCollection
        ? paintkits.filter((p) => (p.collection ?? 'Uncategorized') === activeCollection)
        : paintkits;

    if (!isFiltering && activeCollection) return [[activeCollection, [...source].sort(byGradeThenName)]];

    const byCollection = new Map<string, PaintkitEntry[]>();
    for (const p of source) {
      const key = p.collection ?? 'Uncategorized';
      const arr = byCollection.get(key) ?? [];
      arr.push(p);
      byCollection.set(key, arr);
    }
    for (const arr of byCollection.values()) arr.sort(byGradeThenName);
    const sorted = [...byCollection.entries()].sort(
      (a, b) => Math.min(...a[1].map((p) => p.id)) - Math.min(...b[1].map((p) => p.id)),
    );
    return reversed ? sorted.reverse() : sorted;
  }, [paintkits, q, isFiltering, activeCollection, reversed]);

  // Flat, filtered kit order used for keyboard navigation; matches the order
  // the groups render in, independent of grid vs. list layout.
  const flatKits = useMemo(() => groups.flatMap(([, kits]) => kits), [groups]);

  const clearFilters = () => {
    setFilter('');
    setActiveCollection(null);
  };

  const moveSelection = (nextIndex: number) => {
    const kit = flatKits[nextIndex];
    if (!kit) return;
    onSelect(kit.id);
    containerRef.current?.querySelector<HTMLElement>(`[data-kit-id="${kit.id}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Never hijack typing in the search field or interaction with the
    // collection select (open or closed).
    const target = event.target as HTMLElement;
    if (target.closest('input, .ui-select-trigger, .ui-select-popup')) return;
    if (flatKits.length === 0) return;

    const navKeys = view === 'grid'
      ? ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']
      : ['ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!navKeys.includes(event.key)) return;
    event.preventDefault();

    const currentIndex = selectedId !== null ? flatKits.findIndex((k) => k.id === selectedId) : -1;
    const last = flatKits.length - 1;

    if (event.key === 'Home') {
      moveSelection(0);
      return;
    }
    if (event.key === 'End') {
      moveSelection(last);
      return;
    }

    if (view === 'list') {
      if (event.key === 'ArrowDown') moveSelection(currentIndex < 0 ? 0 : Math.min(currentIndex + 1, last));
      else if (event.key === 'ArrowUp') moveSelection(currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0));
      return;
    }

    const columns = countGridColumns(containerRef.current?.querySelector('.warpaint-group') ?? null);
    if (event.key === 'ArrowRight') moveSelection(currentIndex < 0 ? 0 : Math.min(currentIndex + 1, last));
    else if (event.key === 'ArrowLeft') moveSelection(currentIndex < 0 ? 0 : Math.max(currentIndex - 1, 0));
    else if (event.key === 'ArrowDown') moveSelection(currentIndex < 0 ? 0 : Math.min(currentIndex + columns, last));
    else if (event.key === 'ArrowUp') moveSelection(currentIndex < 0 ? 0 : Math.max(currentIndex - columns, 0));
  };

  return (
    <div className="warpaint-list" ref={containerRef} onKeyDown={handleKeyDown}>
      <div className="warpaint-list-header">
        <div className="warpaint-list-title">
          <h2>Warpaints</h2>
          <div className="warpaint-list-title-actions">
            <div className="view-toggle" role="group" aria-label="Catalog view">
              <button
                type="button"
                className="view-toggle-btn"
                title="List view"
                aria-label="List view"
                aria-pressed={view === 'list'}
                onClick={() => setView('list')}
              >
                <List size={14} />
              </button>
              <button
                type="button"
                className="view-toggle-btn"
                title="Grid view"
                aria-label="Grid view"
                aria-pressed={view === 'grid'}
                onClick={() => setView('grid')}
              >
                <LayoutGrid size={14} />
              </button>
            </div>
            <button
              type="button"
              className="btn order-toggle"
              title={reversed ? 'Newest first (click for oldest first)' : 'Oldest first (click for newest first)'}
              onClick={() => setReversed((r) => !r)}
            >
              {reversed ? <ArrowUpNarrowWide size={14} /> : <ArrowDownNarrowWide size={14} />}
              <span>{reversed ? 'Newest' : 'Oldest'}</span>
            </button>
          </div>
        </div>
        <div className="search-field">
          <Search className="search-field-icon" size={14} />
          <TextField
            value={filter}
            onChange={setFilter}
            placeholder="Filter warpaints or collections..."
            onKeyDown={(event) => {
              if (event.key === 'Escape' && filter) setFilter('');
            }}
          />
          {filter.length > 0 && (
            <button type="button" className="search-clear-btn" title="Clear search" aria-label="Clear search" onClick={() => setFilter('')}>
              <X size={13} />
            </button>
          )}
        </div>
        <div className="collection-filter">
          <SelectField
            value={activeCollection ?? ''}
            onChange={(v) => setActiveCollection(v === '' ? null : v)}
            options={collectionOptions}
          />
        </div>
      </div>

      <ScrollArea.Root className="ui-scroll-root paint-list-scroll">
        <ScrollArea.Viewport className="ui-scroll-viewport">
          <ScrollArea.Content>
            {groups.length === 0 && (
              <div className="warpaint-empty">
                <p>No matches</p>
                <button type="button" className="btn clear-filters-btn" onClick={clearFilters}>
                  Clear filters
                </button>
              </div>
            )}
            {groups.map(([collection, kits]) => (
              <div className="warpaint-group" key={collection}>
                {showGroupHeaders && (
                  <div className="warpaint-group-label">
                    <AssetIcon src={collectionIcons[collection]} size={16} />
                    <span className="warpaint-group-label-name">{collection}</span>
                    <span className="warpaint-group-label-count">{kits.length}</span>
                  </div>
                )}
                {view === 'grid' ? (
                  <div className="warpaint-tile-grid">
                    {kits.map((kit) => (
                      <button
                        type="button"
                        key={kit.id}
                        data-kit-id={kit.id}
                        className={`warpaint-tile${kit.id === selectedId ? ' selected' : ''}`}
                        onClick={() => onSelect(kit.id)}
                        data-grade={kit.grade}
                        title={kit.name}
                        aria-label={kit.name}
                      >
                        <AssetIcon
                          src={paintIcons[kit.id]}
                          size={48}
                          loading={prioritizePaintIcons ? 'eager' : 'lazy'}
                          fetchPriority={prioritizePaintIcons ? 'high' : 'auto'}
                        />
                      </button>
                    ))}
                  </div>
                ) : (
                  kits.map((kit) => (
                    <button
                      type="button"
                      key={kit.id}
                      data-kit-id={kit.id}
                      className={`warpaint-item${kit.id === selectedId ? ' selected' : ''}`}
                      onClick={() => onSelect(kit.id)}
                      data-grade={kit.grade}
                    >
                      <span className="warpaint-item-icon">
                        <AssetIcon
                          src={paintIcons[kit.id]}
                          size={42}
                          loading={prioritizePaintIcons ? 'eager' : 'lazy'}
                          fetchPriority={prioritizePaintIcons ? 'high' : 'auto'}
                        />
                      </span>
                      <span className="warpaint-item-name">{kit.name}</span>
                    </button>
                  ))
                )}
              </div>
            ))}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className="ui-scrollbar" orientation="vertical">
          <ScrollArea.Thumb className="ui-scrollbar-thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
}
