import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  LoaderCircle,
  OctagonAlert,
  PackageSearch,
  ScrollText,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  CustomDefinitionKitRow,
  CustomDefinitionsState,
} from '../protodefs/types';
import { PROTO_DEFS_ACCEPT } from '../protodefs/types';
import { TextField } from './components';
import './SourcePackagePanel.css';
import './DefinitionsPanel.css';

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

function ImportPicker({
  state,
  label,
}: {
  state: CustomDefinitionsState;
  label: string;
}) {
  const busy = state.status === 'importing';
  return (
    <label
      className="definitions-btn definitions-btn-primary"
      data-busy={busy ? '' : undefined}
    >
      <Upload size={12} />
      <span>{label}</span>
      <input
        type="file"
        accept={PROTO_DEFS_ACCEPT}
        // A community war paint is two JSON files (its operation and its
        // definition), which have to arrive together to resolve.
        multiple
        disabled={busy}
        aria-label="Import war paint definitions"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length) state.onImport(files);
        }}
      />
    </label>
  );
}

function DefinitionRow({
  kit,
  onSelectKit,
  onToggleKit,
}: {
  kit: CustomDefinitionKitRow;
  onSelectKit: (id: number) => void;
  onToggleKit: (defindex: number) => void;
}) {
  return (
    <div
      className="definitions-row"
      data-loaded={kit.loaded || undefined}
      data-unsupported={kit.unsupported || undefined}
    >
      <div className="definitions-row-main">
        <span className="definitions-row-name">{kit.name}</span>
        <span className="definitions-row-meta">
          #{kit.defindex} · {plural(kit.weapons.length, 'weapon')}
        </span>
      </div>
      <span className="definitions-row-chip" data-new={kit.isNew || undefined}>
        {kit.isNew ? 'New' : `Built-in #${kit.defindex}`}
      </span>
      {kit.unsupported ? (
        <span className="definitions-row-reason">
          No weapon this viewer can render
        </span>
      ) : kit.loaded ? (
        <div className="definitions-row-actions">
          <button
            type="button"
            className="definitions-btn definitions-btn-primary"
            onClick={() => onSelectKit(kit.id)}
          >
            Use
          </button>
          <button
            type="button"
            className="definitions-btn"
            onClick={() => onToggleKit(kit.defindex)}
          >
            Unload
          </button>
        </div>
      ) : (
        <div className="definitions-row-actions">
          <button
            type="button"
            className="definitions-btn"
            onClick={() => onToggleKit(kit.defindex)}
          >
            Load
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Definitions tab: an imported proto_defs container's kits. Its empty state,
 * import control and diagnostics mirror the package panel's so the two
 * "mount a file, see what's inside" panels read as one family.
 */
export function DefinitionsPanel({ state }: { state: CustomDefinitionsState }) {
  const {
    status,
    fileName,
    kits,
    diagnostics,
    packageCandidate,
    onToggleKit,
    onSelectKit,
    onRemove,
  } = state;
  const [filter, setFilter] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  // Successful decodes are developer-facing noise; only problems belong in the
  // visible list, matching the package panel's diagnostics filter.
  const visibleDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.level !== 'info',
  );
  const query = filter.trim().toLowerCase();
  const filteredKits = useMemo(
    () =>
      kits.filter(
        (kit) =>
          !query ||
          kit.name.toLowerCase().includes(query) ||
          String(kit.defindex).includes(query),
      ),
    [kits, query],
  );

  const candidateRow = packageCandidate && status !== 'importing' && (
    <div className="definitions-candidate">
      <PackageSearch size={14} />
      <span
        className="definitions-candidate-path"
        title={packageCandidate.path}
      >
        {packageCandidate.path}
      </span>
      <button
        type="button"
        className="definitions-btn definitions-btn-primary"
        onClick={packageCandidate.onLoad}
      >
        Load from package
      </button>
    </div>
  );

  const diagnosticsList = visibleDiagnostics.length > 0 && (
    <ul className="source-package-diagnostics">
      {visibleDiagnostics.map((diagnostic) => (
        // Errors take the octagon and warnings the triangle, matching the
        // package panel's list.
        <li key={diagnostic.id} data-level={diagnostic.level}>
          {diagnostic.level === 'error' ? (
            <OctagonAlert size={11} />
          ) : (
            <AlertTriangle size={11} />
          )}
          <span>
            {diagnostic.message}
            {diagnostic.detail && <code>{diagnostic.detail}</code>}
          </span>
        </li>
      ))}
    </ul>
  );

  if (status !== 'loaded') {
    return (
      <div className="definitions-panel" data-status={status}>
        {status === 'importing' ? (
          <div className="definitions-status">
            <LoaderCircle className="custom-workbench-spinner" size={16} />{' '}
            Reading {fileName ?? 'definitions'}...
          </div>
        ) : (
          <div className="definitions-empty">
            <ScrollText size={22} />
            <strong>No definitions imported</strong>
            <span>
              Import a paint's JSON files or a proto_defs.vpd. Mounting its ZIP
              on the Package tab finds them for you.
            </span>
            <ImportPicker state={state} label="Import definitions" />
          </div>
        )}
        {candidateRow}
        {diagnosticsList}
      </div>
    );
  }

  return (
    <div className="definitions-panel" data-status="loaded">
      <div className="definitions-toolbar">
        <div className="definitions-search">
          <Search className="definitions-search-icon" size={13} />
          <TextField
            value={filter}
            onChange={setFilter}
            placeholder="Filter definitions..."
            onKeyDown={(event) => {
              if (event.key === 'Escape' && filter) {
                event.preventDefault();
                setFilter('');
              }
            }}
          />
        </div>
        <span className="definitions-filename" title={fileName}>
          {fileName}
        </span>
        <span className="definitions-count">{plural(kits.length, 'kit')}</span>
        <ImportPicker state={state} label="Replace" />
        <button
          type="button"
          className="definitions-btn definitions-remove"
          data-confirm={confirmRemove ? '' : undefined}
          onClick={() => (confirmRemove ? onRemove() : setConfirmRemove(true))}
        >
          <Trash2 size={12} />
          {confirmRemove ? 'Remove it?' : 'Remove'}
        </button>
      </div>

      {candidateRow}
      {diagnosticsList}

      <div className="definitions-list">
        {filteredKits.length === 0 ? (
          <div className="definitions-list-empty">
            <Search size={16} /> No definitions match “{filter}”.
          </div>
        ) : (
          filteredKits.map((kit) => (
            <DefinitionRow
              key={kit.id}
              kit={kit}
              onSelectKit={onSelectKit}
              onToggleKit={onToggleKit}
            />
          ))
        )}
      </div>
    </div>
  );
}
