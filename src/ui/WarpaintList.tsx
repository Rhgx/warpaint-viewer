import { useMemo, useState } from 'react';
import { ScrollArea } from '@base-ui/react/scroll-area';
import { ArrowDownNarrowWide, ArrowUpNarrowWide } from 'lucide-react';
import { AssetIcon, TextField } from './components';
import type { PaintkitEntry } from '../data/types';

interface CollectionRow {
  name: string;
  count: number;
  minId: number;
}

type Group = readonly [string, PaintkitEntry[]];

// Left panel: a collection rail (with an "All" entry) filters a warpaint list
// below it. Collections and paints share one oldest/newest order toggle
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

  const q = filter.trim().toLowerCase();
  const isFiltering = q.length > 0;
  // A filter, or the "All" entry, spans every collection and needs group
  // headers; a single selected collection is already unambiguous.
  const showGroupHeaders = isFiltering || activeCollection === null;

  const groups = useMemo<Group[]>(() => {
    const source = isFiltering
      ? paintkits.filter(
          (p) =>
            p.name.toLowerCase().includes(q) || (p.collection ?? 'Uncategorized').toLowerCase().includes(q),
        )
      : activeCollection
        ? paintkits.filter((p) => (p.collection ?? 'Uncategorized') === activeCollection)
        : paintkits;

    if (!isFiltering && activeCollection) return [[activeCollection, source]];

    const byCollection = new Map<string, PaintkitEntry[]>();
    for (const p of source) {
      const key = p.collection ?? 'Uncategorized';
      const arr = byCollection.get(key) ?? [];
      arr.push(p);
      byCollection.set(key, arr);
    }
    const sorted = [...byCollection.entries()].sort(
      (a, b) => Math.min(...a[1].map((p) => p.id)) - Math.min(...b[1].map((p) => p.id)),
    );
    return reversed ? sorted.reverse() : sorted;
  }, [paintkits, q, isFiltering, activeCollection, reversed]);

  return (
    <div className="warpaint-list">
      <div className="warpaint-list-header">
        <div className="warpaint-list-title">
          <h2>Warpaints</h2>
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
        <TextField value={filter} onChange={setFilter} placeholder="Filter warpaints or collections..." />
      </div>

      <div className="collection-rail">
        <button
          type="button"
          className={`collection-row${activeCollection === null ? ' selected' : ''}`}
          onClick={() => setActiveCollection(null)}
          aria-pressed={activeCollection === null}
        >
          <span className="collection-row-icon-slot" aria-hidden="true" />
          <span className="collection-row-name">All collections</span>
          <span className="collection-row-count">{paintkits.length}</span>
        </button>
        <ScrollArea.Root className="ui-scroll-root collection-rail-scroll">
          <ScrollArea.Viewport className="ui-scroll-viewport">
            <ScrollArea.Content>
              {collections.map((c) => (
                <button
                  type="button"
                  key={c.name}
                  className={`collection-row${activeCollection === c.name ? ' selected' : ''}`}
                  onClick={() => setActiveCollection(c.name)}
                  aria-pressed={activeCollection === c.name}
                >
                  <span className="collection-row-icon-slot">
                    <AssetIcon src={collectionIcons[c.name]} size={34} />
                  </span>
                  <span className="collection-row-name">{c.name}</span>
                  <span className="collection-row-count">{c.count}</span>
                </button>
              ))}
            </ScrollArea.Content>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar className="ui-scrollbar" orientation="vertical">
            <ScrollArea.Thumb className="ui-scrollbar-thumb" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      </div>

      <ScrollArea.Root className="ui-scroll-root">
        <ScrollArea.Viewport className="ui-scroll-viewport">
          <ScrollArea.Content>
            {groups.length === 0 && <div className="warpaint-empty">No matches</div>}
            {groups.map(([collection, kits]) => (
              <div className="warpaint-group" key={collection}>
                {showGroupHeaders && (
                  <div className="warpaint-group-label">
                    <AssetIcon src={collectionIcons[collection]} size={16} />
                    <span>{collection}</span>
                  </div>
                )}
                {kits.map((kit) => (
                  <button
                    type="button"
                    key={kit.id}
                    className={`warpaint-item${kit.id === selectedId ? ' selected' : ''}`}
                    onClick={() => onSelect(kit.id)}
                  >
                    <span className="warpaint-item-icon">
                      <AssetIcon src={paintIcons[kit.id]} size={42} />
                    </span>
                    <span className="warpaint-item-name">{kit.name}</span>
                  </button>
                ))}
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
