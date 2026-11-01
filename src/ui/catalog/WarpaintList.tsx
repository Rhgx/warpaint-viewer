import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ScrollArea } from '@base-ui/react/scroll-area';
import { ArrowDownNarrowWide, ArrowUpNarrowWide, LayoutGrid, List, Search, X } from 'lucide-react';

import { AssetIcon, SelectField, TextField } from '../common/controls';
import { preloadIntent, type PreloadIntent } from '../../hooks/useIntentPreload';
import type { Grade, PaintkitEntry, TextureDirectory, TextureDirectoryEntry } from '../../data/types';
import { isCustomKitId, paintkitDefindex } from '../../protodefs/types';
import { useTextureDirectory } from '../../hooks/useTextureDirectory';
import { useOperationTemplates } from '../../hooks/useOperationTemplates';
import { PaintkitDetailsButton } from './PaintkitDetailsButton';
import { operationFilterKits } from './operationFilter';
import { useSettings } from '../../settings';
import { matchesMobileLayout } from '../../device';

interface CollectionRow {
  name: string;
  count: number;
  minId: number;
}

type Group = readonly [string, PaintkitEntry[]];
type CatalogView = 'grid' | 'list';

const VIEW_STORAGE_KEY = 'warpaint-viewer:catalog-view';

// Without a stored choice, mobile starts on the denser grid.
function loadStoredView(): CatalogView {
  const fallback = matchesMobileLayout() ? 'grid' : 'list';
  try {
    const stored = localStorage.getItem(VIEW_STORAGE_KEY);
    return stored === 'grid' || stored === 'list' ? stored : fallback;
  } catch {
    return fallback;
  }
}

// Highest grade first; unknown grade sorts last. Ties broken by name.
const GRADE_RANK: Record<Grade, number> = {
  elite: 6,
  assassin: 5,
  commando: 4,
  mercenary: 3,
  freelance: 2,
  civilian: 1,
};

function byGradeThenName(a: PaintkitEntry, b: PaintkitEntry): number {
  const rankDiff = (b.grade ? GRADE_RANK[b.grade] : 0) - (a.grade ? GRADE_RANK[a.grade] : 0);
  return rankDiff !== 0 ? rankDiff : a.name.localeCompare(b.name);
}

const PaintTile = memo(function PaintTile({
  kit,
  selected,
  icon,
  prioritizeIcon,
  onSelect,
  onPreload,
  showDetails,
}: {
  kit: PaintkitEntry;
  selected: boolean;
  icon: string | undefined;
  prioritizeIcon: boolean;
  onSelect: (id: number) => void;
  onPreload?: PreloadIntent;
  showDetails: boolean;
}) {
  const select = useCallback(() => onSelect(kit.id), [kit.id, onSelect]);
  return (
    <button
      type="button"
      data-kit-id={kit.id}
      className={`warpaint-tile${selected ? ' selected' : ''}`}
      {...preloadIntent(`kit:${kit.id}`, onPreload)}
      onClick={select}
      data-grade={kit.grade}
      title={showDetails ? `${kit.name} (#${paintkitDefindex(kit.id)})` : kit.name}
      aria-label={kit.name}
    >
      <AssetIcon
        src={icon}
        size={48}
        loading={prioritizeIcon ? 'eager' : 'lazy'}
        fetchPriority={prioritizeIcon ? 'high' : 'auto'}
      />
    </button>
  );
});

const PaintListItem = memo(function PaintListItem({
  kit,
  selected,
  icon,
  prioritizeIcon,
  onSelect,
  onPreload,
  showDetails,
  directory,
  paintkits,
}: {
  kit: PaintkitEntry;
  selected: boolean;
  icon: string | undefined;
  prioritizeIcon: boolean;
  onSelect: (id: number) => void;
  onPreload?: PreloadIntent;
  showDetails: boolean;
  directory: TextureDirectory | null;
  paintkits: readonly PaintkitEntry[];
}) {
  const select = useCallback(() => onSelect(kit.id), [kit.id, onSelect]);
  const [hovered, setHovered] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Imported kits are excluded: Pyxell's entry describes the stock paint.
  const entry: TextureDirectoryEntry | undefined = directory && !isCustomKitId(kit.id)
    ? directory.entries[kit.id]
    : undefined;
  const row = (
    <button
      type="button"
      data-kit-id={kit.id}
      className={`warpaint-item${selected ? ' selected' : ''}`}
      {...preloadIntent(`kit:${kit.id}`, onPreload)}
      onClick={select}
      data-grade={kit.grade}
    >
      <span className="warpaint-item-icon">
        <AssetIcon
          src={icon}
          size={42}
          loading={prioritizeIcon ? 'eager' : 'lazy'}
          fetchPriority={prioritizeIcon ? 'high' : 'auto'}
        />
      </span>
      <span className="warpaint-item-name">{kit.name}</span>
    </button>
  );
  if (!showDetails) return row;
  // The details button is a sibling (buttons cannot nest). It mounts only for the selected
  // or hovered row, since a popover on every row made remounting about four times slower.
  // It stays while its card is open, since the card sits outside the row.
  return (
    <div className="warpaint-item-row" onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}>
      {row}
      {(selected || hovered || detailsOpen) && (
        <PaintkitDetailsButton
          defindex={paintkitDefindex(kit.id)}
          kitName={kit.name}
          entry={entry}
          directory={directory}
          paintkits={paintkits}
          onSelectKit={onSelect}
          side="right"
          className="warpaint-item-info"
          onOpenChange={setDetailsOpen}
          stockKit={!isCustomKitId(kit.id)}
        />
      )}
    </div>
  );
});

// Counts the grid tiles in the first tile's row, so ArrowUp/ArrowDown jump a whole row.
// Falls back to 1 when the DOM does not cooperate.
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

// Left panel: a search field and a collection dropdown filter a grouped list.
// Collections and paints share one oldest/newest toggle, proxied by the minimum
// paintkit id, which tracks release order. A filter searches all names, ignoring the collection.
export const WarpaintList = memo(function WarpaintList({
  paintkits,
  selectedId,
  onSelect,
  onPreload,
  collectionIcons,
  paintIcons,
  visibilityTrackedKitIds = [],
  onVisibleKitIdsChange,
}: {
  paintkits: PaintkitEntry[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onPreload?: PreloadIntent;
  collectionIcons: Record<string, string>;
  paintIcons: Record<number, string>;
  /** Restricts visibility observation to entries with deferred work. */
  visibilityTrackedKitIds?: readonly number[];
  /** Reports catalog entries intersecting the scroll viewport for deferred work. */
  onVisibleKitIdsChange?: (ids: readonly number[]) => void;
}) {
  const [filter, setFilter] = useState('');
  const [reversed, setReversed] = useState(() => {
    // Newest first by default. ?sortdesc=0 forces oldest first.
    const param = new URLSearchParams(window.location.search).get('sortdesc');
    return param === null ? true : param === '1';
  });
  const [activeCollection, setActiveCollection] = useState<string | null>(null);
  const [view, setView] = useState<CatalogView>(loadStoredView);
  const showDetails = useSettings((s) => s.showPaintkitDetails);
  const directory = useTextureDirectory();
  const containerRef = useRef<HTMLDivElement>(null);

  // Saved only on an explicit toggle, so the layout-dependent default is never stored.
  const chooseView = (next: CatalogView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable; the toggle still works for this session.
    }
  };

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
  // ID and op: matching sit behind the Settings toggle. "400" or "#400" matches that
  // paint kit ID exactly; a prefix match would turn "4" into dozens of paints.
  const advancedSearch = useSettings((s) => s.advancedCatalogSearch);
  const idQuery = advancedSearch && /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
  // "op:ao" lists the stock paints using an operation named "ao". The operation
  // data loads only once such a query is typed; until it arrives, no paints match.
  const opQuery = advancedSearch && q.startsWith('op:') ? q.slice(3) : null;
  const operationData = useOperationTemplates(opQuery !== null);
  const operationKits = useMemo(
    () => (opQuery !== null && operationData ? operationFilterKits(paintkits, operationData, opQuery) : []),
    [opQuery, operationData, paintkits],
  );
  // Group headers are needed unless a single collection is selected.
  const showGroupHeaders = isFiltering || activeCollection === null;
  // Lazy loading deferred a newly opened collection's few thumbnails for seconds, so a
  // single collection loads its icons eagerly. The full catalog stays lazy.
  const prioritizePaintIcons = activeCollection !== null && !isFiltering;

  const groups = useMemo<Group[]>(() => {
    const source = opQuery !== null
      ? operationKits
      : isFiltering
        ? paintkits.filter(
            (p) =>
              paintkitDefindex(p.id) === idQuery
              || p.name.toLowerCase().includes(q)
              || (p.collection ?? 'Uncategorized').toLowerCase().includes(q),
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
    // Walking `collections` keeps the groups in its direction order.
    return collections.flatMap((collection): Group[] => {
      const kits = byCollection.get(collection.name);
      return kits ? [[collection.name, kits]] : [];
    });
  }, [paintkits, q, idQuery, isFiltering, activeCollection, collections, opQuery, operationKits]);

  useEffect(() => {
    if (!onVisibleKitIdsChange) return;
    if (visibilityTrackedKitIds.length === 0) {
      onVisibleKitIdsChange([]);
      return;
    }
    const container = containerRef.current;
    const viewport = container?.querySelector<HTMLElement>('.ui-scroll-viewport');
    if (!container || !viewport || typeof IntersectionObserver === 'undefined') {
      // Without IntersectionObserver, every tracked kit counts as visible.
      onVisibleKitIdsChange(visibilityTrackedKitIds);
      return;
    }

    const tracked = new Set(visibilityTrackedKitIds);
    const visible = new Set<number>();
    const publish = () => {
      onVisibleKitIdsChange([...visible].sort((a, b) => a - b));
    };
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = Number((entry.target as HTMLElement).dataset.kitId);
        if (!Number.isFinite(id)) continue;
        if (entry.isIntersecting && entry.intersectionRatio > 0) visible.add(id);
        else visible.delete(id);
      }
      publish();
    }, { root: viewport });

    for (const node of container.querySelectorAll<HTMLElement>('[data-kit-id]')) {
      const id = Number(node.dataset.kitId);
      if (tracked.has(id)) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [groups, onVisibleKitIdsChange, view, visibilityTrackedKitIds]);

  // Keyboard navigation order; matches the rendered group order in both layouts.
  const flatKits = useMemo(() => groups.flatMap(([, kits]) => kits), [groups]);

  const clearFilters = () => {
    setFilter('');
    setActiveCollection(null);
  };

  // Reveals a newly selected kit, from any source, by clearing a filter that hides it.
  // Only a change of selection does this, so filtering the current kit out of view is left alone.
  const [revealedId, setRevealedId] = useState(selectedId);
  if (selectedId !== revealedId) {
    setRevealedId(selectedId);
    if (selectedId !== null && !flatKits.some((kit) => kit.id === selectedId)) clearFilters();
  }
  useEffect(() => {
    if (selectedId === null) return;
    containerRef.current?.querySelector<HTMLElement>(`[data-kit-id="${selectedId}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const moveSelection = (nextIndex: number) => {
    const kit = flatKits[nextIndex];
    if (kit) onSelect(kit.id);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Leave typing in the search field and the collection select alone.
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
                onClick={() => chooseView('list')}
              >
                <List size={14} />
              </button>
              <button
                type="button"
                className="view-toggle-btn"
                title="Grid view"
                aria-label="Grid view"
                aria-pressed={view === 'grid'}
                onClick={() => chooseView('grid')}
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
            placeholder={advancedSearch ? 'Filter by name, collection, ID, or op:name...' : 'Filter by name or collection...'}
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
                    <AssetIcon src={collectionIcons[collection]} size={24} />
                    <span className="warpaint-group-label-name">{collection}</span>
                    <span className="warpaint-group-label-count">{kits.length}</span>
                  </div>
                )}
                {view === 'grid' ? (
                  <div className="warpaint-tile-grid">
                    {kits.map((kit) => (
                      <PaintTile
                        key={kit.id}
                        kit={kit}
                        selected={kit.id === selectedId}
                        icon={paintIcons[kit.id]}
                        prioritizeIcon={prioritizePaintIcons}
                        onSelect={onSelect}
                        onPreload={onPreload}
                        showDetails={showDetails}
                      />
                    ))}
                  </div>
                ) : (
                  kits.map((kit) => (
                    <PaintListItem
                      key={kit.id}
                      kit={kit}
                      selected={kit.id === selectedId}
                      icon={paintIcons[kit.id]}
                      prioritizeIcon={prioritizePaintIcons}
                      onSelect={onSelect}
                      onPreload={onPreload}
                      showDetails={showDetails}
                      directory={directory}
                      paintkits={paintkits}
                    />
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
});
