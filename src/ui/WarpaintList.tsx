import { useMemo, useState } from 'react';
import { ScrollArea } from '@base-ui/react/scroll-area';
import { ChevronDown, ChevronRight, ArrowDownNarrowWide, ArrowUpNarrowWide } from 'lucide-react';
import { TextField } from './components';
import type { PaintkitEntry } from '../data/types';

// Left panel: filterable warpaint list grouped by collection. Collections are
// ordered oldest to newest (proxy: ascending minimum paintkit id, which tracks
// release order), reversible via the order toggle. Groups collapse per header;
// all default open. ?sortdesc=1 / ?collapsed=<substring> preset the state.
export function WarpaintList({
  paintkits,
  selectedId,
  onSelect,
}: {
  paintkits: PaintkitEntry[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const [filter, setFilter] = useState('');
  const [reversed, setReversed] = useState(
    () => new URLSearchParams(window.location.search).get('sortdesc') === '1',
  );
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    const pre = new URLSearchParams(window.location.search).get('collapsed');
    if (!pre) return new Set<string>();
    const hit = [...new Set(paintkits.map((p) => p.collection ?? 'Uncategorized'))].filter((c) =>
      c.toLowerCase().includes(pre.toLowerCase()),
    );
    return new Set(hit);
  });

  const toggleGroup = (name: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    // Filter matches kit names AND collection names.
    const filtered = q
      ? paintkits.filter(
          (p) =>
            p.name.toLowerCase().includes(q) ||
            (p.collection ?? 'Uncategorized').toLowerCase().includes(q),
        )
      : paintkits;
    const byCollection = new Map<string, PaintkitEntry[]>();
    for (const p of filtered) {
      const key = p.collection ?? 'Uncategorized';
      const arr = byCollection.get(key) ?? [];
      arr.push(p);
      byCollection.set(key, arr);
    }
    // Oldest first: ascending minimum kit id within each collection.
    const sorted = [...byCollection.entries()].sort(
      (a, b) => Math.min(...a[1].map((p) => p.id)) - Math.min(...b[1].map((p) => p.id)),
    );
    return reversed ? sorted.reverse() : sorted;
  }, [paintkits, filter, reversed]);

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
        <TextField value={filter} onChange={setFilter} placeholder="Filter..." />
      </div>
      <ScrollArea.Root className="ui-scroll-root">
        <ScrollArea.Viewport className="ui-scroll-viewport">
          <ScrollArea.Content>
            {groups.length === 0 && <div className="warpaint-empty">No matches</div>}
            {groups.map(([collection, kits]) => {
              const isCollapsed = collapsed.has(collection);
              return (
                <div className="warpaint-group" key={collection}>
                  <button
                    type="button"
                    className="warpaint-group-label"
                    onClick={() => toggleGroup(collection)}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span>{collection}</span>
                  </button>
                  {!isCollapsed &&
                    kits.map((kit) => (
                      <button
                        type="button"
                        key={kit.id}
                        className={`warpaint-item${kit.id === selectedId ? ' selected' : ''}`}
                        onClick={() => onSelect(kit.id)}
                      >
                        <span className="warpaint-item-name">{kit.name}</span>
                        <span className="warpaint-item-id">#{kit.id}</span>
                      </button>
                    ))}
                </div>
              );
            })}
          </ScrollArea.Content>
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className="ui-scrollbar" orientation="vertical">
          <ScrollArea.Thumb className="ui-scrollbar-thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </div>
  );
}
