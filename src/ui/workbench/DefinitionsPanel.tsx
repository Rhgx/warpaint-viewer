import { useEffect, useMemo, useRef, useState } from 'react';
import { Input } from '@base-ui/react/input';
import {
  LoaderCircle,
  PackageSearch,
  Plus,
  ScrollText,
  Search,
  Trash2,
  Upload,
} from 'lucide-react';
import type { OperationTemplateInfo } from '../../data/types';
import { useOperationTemplatesStatus } from '../../hooks/useOperationTemplates';
import type {
  CustomDefinitionKitRow,
  CustomDefinitionsState,
} from '../../protodefs/types';
import { PROTO_DEFS_ACCEPT } from '../../protodefs/types';
import { Control, SelectField, TextField } from '../common/controls';
import './DefinitionsPanel.css';
import { DiagnosticsList } from './DiagnosticItem';

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

// custom_uv is the only stock template with no texture layers, so its bare name
// says little on its own.
function templateLabel(template: OperationTemplateInfo): string {
  return template.name === 'custom_uv' ? 'custom_uv (UV paint)' : template.name;
}

const TEMPLATE_GROUPS = ['UV', 'Stickers', 'Team colors', 'Plain'] as const;
type TemplateGroup = (typeof TEMPLATE_GROUPS)[number];

function templateGroup(template: OperationTemplateInfo): TemplateGroup {
  if (template.name === 'custom_uv') return 'UV';
  if (template.stickers > 0) return 'Stickers';
  if (template.teamTextures) return 'Team colors';
  return 'Plain';
}

// SelectField has no option groups, so the picker is a flat list sorted by
// group (the sort is stable, so templates keep their order within a group).
function sortByGroup(templates: OperationTemplateInfo[]): OperationTemplateInfo[] {
  const rank = (template: OperationTemplateInfo) => TEMPLATE_GROUPS.indexOf(templateGroup(template));
  return [...templates].sort((a, b) => rank(a) - rank(b));
}

// Zero parts are left out, so a template with nothing of a kind never lists it.
function templateSummary(template: OperationTemplateInfo, usedBy: number): string {
  const parts: string[] = [];
  if (template.textureLayers > 0) parts.push(plural(template.textureLayers, 'texture'));
  if (template.stickers > 0) {
    parts.push(
      plural(template.stickers, 'sticker')
      + (template.stickerVariants > 1 ? ` with ${plural(template.stickerVariants, 'variant')}` : ''),
    );
  }
  if (template.innerWear) parts.push('inner wear');
  if (template.teamTextures) parts.push('team textures');
  const sentences: string[] = [`${templateGroup(template)}.`];
  if (parts.length) sentences.push(`${parts.join(', ')}.`);
  if (usedBy > 0) sentences.push(`Used by ${plural(usedBy, 'war paint')}.`);
  return sentences.join(' ');
}

// Stock paints that use a template, to show as examples in the form.
function exampleKits(ids: number[], names: Record<number, string>): { id: number; name: string }[] {
  return ids.slice(0, 3).flatMap((id) => {
    const name = names[id];
    return name === undefined ? [] : [{ id, name }];
  });
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

// Enter and blur commit, Escape cancels. The guard stops the blur that comes
// with unmounting the field after Enter or Escape from committing a second time.
function RenameField({
  name,
  onCommit,
  onCancel,
}: {
  name: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const finished = useRef(false);
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit) onCommit(draft);
    else onCancel();
  };
  return (
    <Input
      className="ui-input definitions-row-rename"
      aria-label="War paint name"
      autoFocus
      value={draft}
      onValueChange={(value) => setDraft(value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

function DefinitionRow({
  kit,
  deleteConfirming,
  onSelectKit,
  onToggleKit,
  onRenameKit,
  onDeleteKit,
}: {
  kit: CustomDefinitionKitRow;
  deleteConfirming: boolean;
  onSelectKit: (id: number) => void;
  onToggleKit: (defindex: number) => void;
  onRenameKit: (defindex: number, name: string) => void;
  onDeleteKit: (defindex: number) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  return (
    <div
      className="definitions-row"
      data-loaded={kit.loaded || undefined}
      data-unsupported={kit.unsupported || kit.quarantined || undefined}
    >
      <div className="definitions-row-main">
        {renaming ? (
          <RenameField
            name={kit.name}
            onCommit={(name) => {
              setRenaming(false);
              // A blank or unchanged name keeps the paint as it was.
              const next = name.trim();
              if (next && next !== kit.name) onRenameKit(kit.defindex, next);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="definitions-row-name">{kit.name}</span>
        )}
        <span className="definitions-row-meta">
          #{kit.defindex} · {plural(kit.weapons.length, 'weapon')}
        </span>
      </div>
      <span className="definitions-row-chip" data-new={kit.isNew || undefined}>
        {kit.isNew ? 'New' : `Built-in #${kit.defindex}`}
      </span>
      <div className="definitions-row-actions">
        {kit.quarantined ? (
          <span className="definitions-row-reason">
            Could not produce a paint recipe
          </span>
        ) : kit.unsupported ? (
          <span className="definitions-row-reason">
            No weapon this viewer can render
          </span>
        ) : kit.loaded ? (
          <>
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
          </>
        ) : (
          <button
            type="button"
            className="definitions-btn"
            onClick={() => onToggleKit(kit.defindex)}
          >
            Load
          </button>
        )}
        {kit.generated && (
          <>
            <button
              type="button"
              className="definitions-btn"
              onClick={() => setRenaming(true)}
            >
              Rename
            </button>
            <button
              type="button"
              className="definitions-btn definitions-row-delete"
              data-confirm={deleteConfirming ? '' : undefined}
              title="Delete this war paint"
              onClick={() => onDeleteKit(kit.defindex)}
            >
              <Trash2 size={12} />
              {deleteConfirming ? 'Delete it?' : null}
            </button>
          </>
        )}
      </div>
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
    onRenameWarPaint,
    onDeleteWarPaint,
    stockKitNames,
    onRemove,
  } = state;
  const [filter, setFilter] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  // The defindex of the paint whose delete is waiting for a second click.
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  // Held here rather than in the form so a failed create, which passes through
  // the importing state and remounts the panel body, keeps what was typed.
  const [creating, setCreating] = useState(false);
  const [creatingTemplate, setCreatingTemplate] = useState<number | null>(null);
  const [creatingName, setCreatingName] = useState('New war paint');
  const [creatingBusy, setCreatingBusy] = useState(false);
  const [creatingFrom, setCreatingFrom] = useState<'template' | 'copy'>('template');
  const [creatingError, setCreatingError] = useState<string | null>(null);
  const templateStatus = useOperationTemplatesStatus(creating);
  const templates = templateStatus.data;
  const template = templates?.templates.find((entry) => entry.defindex === creatingTemplate)
    ?? templates?.templates[0];
  const stockKit = state.selectedStockKit;
  const copying = creatingFrom === 'copy' && stockKit !== undefined && state.exportSelectedStockKit !== undefined;

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  useEffect(() => {
    if (confirmDelete === null) return;
    const timer = window.setTimeout(() => setConfirmDelete(null), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmDelete]);

  const deleteWarPaint = (defindex: number) => {
    if (confirmDelete !== defindex) {
      setConfirmDelete(defindex);
      return;
    }
    setConfirmDelete(null);
    onDeleteWarPaint(defindex);
  };

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

  const diagnosticsList = <DiagnosticsList diagnostics={diagnostics} />;

  const newPaintButton = (
    <button
      type="button"
      className="definitions-btn"
      aria-expanded={creating}
      disabled={!state.canAddWarPaint || status === 'importing'}
      title={state.canAddWarPaint ? undefined : 'Clear the imported proto_defs.vpd to create a new war paint.'}
      onClick={() => setCreating((open) => !open)}
    >
      <Plus size={12} />
      <span>New war paint</span>
    </button>
  );

  // A per-wear paint has no single operation to copy, so the form stays open with the reason.
  const copyWarPaint = async () => {
    const exportStockKit = state.exportSelectedStockKit;
    if (!exportStockKit) return;
    setCreatingBusy(true);
    setCreatingError(null);
    try {
      const messages = await exportStockKit();
      if (!messages) {
        setCreatingError('This war paint sets a separate operation for each weapon and wear, so it cannot be copied yet.');
        return;
      }
      if (await state.onCreateWarPaintCopy(messages, creatingName)) setCreating(false);
    } catch (cause) {
      setCreatingError(cause instanceof Error ? cause.message : 'The war paint could not be copied.');
    } finally {
      setCreatingBusy(false);
    }
  };

  const createWarPaint = () => {
    if (creatingBusy || !state.canAddWarPaint) return;
    if (copying) {
      void copyWarPaint();
      return;
    }
    if (!template) return;
    setCreatingBusy(true);
    void state.onCreateWarPaint(template.defindex, creatingName).then((created) => {
      setCreatingBusy(false);
      if (created) setCreating(false);
    });
  };

  const chooseSource = (source: 'template' | 'copy') => {
    setCreatingFrom(source);
    setCreatingError(null);
    if (source === 'copy' && stockKit) setCreatingName(`${stockKit.name} copy`);
  };

  const examples = templates && template
    ? exampleKits(templates.usage[String(template.defindex)] ?? [], stockKitNames)
    : [];

  const nameAndActions = (
    <>
      <Control label="Name">
        <TextField
          value={creatingName}
          onChange={setCreatingName}
          placeholder="New war paint"
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              createWarPaint();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              setCreating(false);
            }
          }}
        />
      </Control>
      {creatingError && <p className="definitions-create-error" role="alert">{creatingError}</p>}
      <div className="definitions-create-actions">
        <button type="button" className="definitions-btn" onClick={() => setCreating(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="definitions-btn definitions-btn-primary"
          disabled={creatingBusy || !state.canAddWarPaint}
          onClick={createWarPaint}
        >
          Create
        </button>
      </div>
    </>
  );

  const createForm = creating && (
    <div className="definitions-create" role="group" aria-label="New war paint">
      <strong className="definitions-create-title">New war paint</strong>
      {stockKit && state.exportSelectedStockKit && (
        <Control label="Start from" group>
          <div className="definitions-segmented">
            <button
              type="button"
              className="definitions-btn"
              aria-pressed={!copying}
              onClick={() => chooseSource('template')}
            >
              <span>Stock template</span>
            </button>
            <button
              type="button"
              className="definitions-btn"
              aria-pressed={copying}
              onClick={() => chooseSource('copy')}
            >
              <span>Copy of {stockKit.name}</span>
            </button>
          </div>
        </Control>
      )}
      {copying ? nameAndActions : templates && template ? (
        <>
          <Control label="Template">
            <SelectField
              value={String(template.defindex)}
              onChange={(value) => setCreatingTemplate(Number(value))}
              options={sortByGroup(templates.templates).map((entry) => ({
                value: String(entry.defindex),
                label: templateLabel(entry),
              }))}
            />
          </Control>
          <p className="definitions-create-summary">
            {templateSummary(template, (templates.usage[String(template.defindex)] ?? []).length)}
          </p>
          {examples.length > 0 && (
            <p className="definitions-create-summary">
              Examples:{' '}
              {examples.map((kit, index) => (
                <span key={kit.id}>
                  {index > 0 && ', '}
                  <button
                    type="button"
                    className="definitions-link"
                    onClick={() => onSelectKit(kit.id)}
                  >
                    {kit.name}
                  </button>
                </span>
              ))}
            </p>
          )}
          {nameAndActions}
        </>
      ) : (
        <>
          <div className="definitions-status">
            {templateStatus.failed ? 'Could not load the templates.' : 'Loading templates...'}
          </div>
          <div className="definitions-create-actions">
            {templateStatus.failed && (
              <button type="button" className="definitions-btn" onClick={templateStatus.retry}>
                Retry
              </button>
            )}
            <button type="button" className="definitions-btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );

  if (status !== 'loaded') {
    return (
      <div className="definitions-panel" data-status={status}>
        {status === 'importing' ? (
          <div className="definitions-status">
            <LoaderCircle className="custom-workbench-spinner" size={16} />{' '}
            Reading {fileName ?? 'definitions'}...
          </div>
        ) : creating ? createForm : (
          <div className="definitions-empty">
            <ScrollText size={22} />
            <strong>No definitions imported</strong>
            <span>
              Import a paint's JSON files or a proto_defs.vpd, or start a new
              war paint from a stock template. Mounting a paint's ZIP on the
              Package tab finds its files for you.
            </span>
            <div className="definitions-empty-actions">
              <ImportPicker state={state} label="Import definitions" />
              {newPaintButton}
            </div>
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
        {newPaintButton}
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

      {createForm}
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
              deleteConfirming={confirmDelete === kit.defindex}
              onSelectKit={onSelectKit}
              onToggleKit={onToggleKit}
              onRenameKit={onRenameWarPaint}
              onDeleteKit={deleteWarPaint}
            />
          ))
        )}
      </div>
    </div>
  );
}
