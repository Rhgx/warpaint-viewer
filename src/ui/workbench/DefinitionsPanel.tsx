import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { useArmedConfirm } from '../../hooks/useArmedConfirm';
import { Control, SelectField, TextField } from '../common/controls';
import { Button, FileButton } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { COMPACT_INPUTS, Input, SearchField } from '../primitives/Input';
import { InlineNotice } from '../primitives/Notice';
import { PATH_TEXT } from '../primitives/textStyles';
import { ToggleGroup } from '../primitives/ToggleGroup';
import { DiagnosticsList } from './DiagnosticItem';

const CREATE_ACTIONS = 'flex flex-none items-center justify-end gap-1.5 border-t border-border px-3.5 py-2.25';
const CREATE_SUMMARY = 'm-0 -mt-0.5 text-10 leading-normal text-dim';
const DIAGNOSTICS_GUTTER = 'flex-none not-empty:mx-3 not-empty:mt-2.5';
const STATUS = 'flex flex-[1_0_auto] items-center justify-center gap-2 text-11 text-dim';

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

// custom_uv is the only stock template without texture layers, so its bare name says little.
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

// SelectField has no option groups, so this is a flat list sorted by group (the sort is stable).
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
  return (
    <FileButton
      variant="primary"
      label="Import war paint definitions"
      accept={PROTO_DEFS_ACCEPT}
      // A community paint's operation and definition JSON must arrive together to resolve.
      multiple
      busy={state.status === 'importing'}
      onFiles={state.onImport}
    >
      <Upload size={12} />
      <span>{label}</span>
    </FileButton>
  );
}

// Enter and blur commit, Escape cancels; the guard stops the unmount blur from committing twice.
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
      className="min-w-0 px-1.5 py-0.5 text-11 font-[650]"
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
      className="flex items-center gap-2.5 rounded-sm border border-border bg-panel-2 px-2.5 py-2 transition-fast data-loaded:border-accent-edge data-unsupported:opacity-55"
      data-slot="definitions-row"
      data-loaded={kit.loaded || undefined}
      data-unsupported={kit.unsupported || kit.quarantined || undefined}
    >
      <div className="flex min-w-0 flex-auto flex-col gap-0.5">
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
          <span className="truncate text-11 font-[650] text-text">{kit.name}</span>
        )}
        <span className="text-9 text-dim tabular-nums">
          #{kit.defindex} · {plural(kit.weapons.length, 'weapon')}
        </span>
      </div>
      <span className="flex-none rounded-sm bg-panel px-1.5 py-0.5 text-8.5 font-bold tracking-[0.3px] whitespace-nowrap text-dim uppercase data-new:border data-new:border-accent-edge data-new:bg-accent-soft data-new:text-accent" data-new={kit.isNew || undefined}>
        {kit.isNew ? 'New' : `Built-in #${kit.defindex}`}
      </span>
      <div className="flex flex-none gap-1.25">
        {kit.quarantined ? (
          <span className="max-w-40 flex-none text-9 text-dim italic">
            Could not produce a paint recipe
          </span>
        ) : kit.unsupported ? (
          <span className="max-w-40 flex-none text-9 text-dim italic">
            No weapon this viewer can render
          </span>
        ) : kit.loaded ? (
          <>
            <Button variant="primary" size="compact" onClick={() => onSelectKit(kit.id)}>
              Use
            </Button>
            <Button variant="outline" size="compact" onClick={() => onToggleKit(kit.defindex)}>
              Unload
            </Button>
          </>
        ) : (
          <Button variant="outline" size="compact" onClick={() => onToggleKit(kit.defindex)}>
            Load
          </Button>
        )}
        {kit.generated && (
          <>
            <Button variant="outline" size="compact" onClick={() => setRenaming(true)}>
              Rename
            </Button>
            <Button
              variant={deleteConfirming ? 'armed' : 'outline'}
              size="compact"
              title="Delete this war paint"
              onClick={() => onDeleteKit(kit.defindex)}
            >
              <Trash2 size={12} />
              {deleteConfirming ? 'Delete it?' : null}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** Definitions tab: a proto_defs container's kits. Mirrors the package panel so both read as one family. */
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
  const [confirmRemove, armRemove] = useArmedConfirm();
  // The defindex of the paint whose delete is waiting for a second click.
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null);
  // Held here, not in the form, so a failed create that remounts the body keeps the typed text.
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
    <div className="mx-3 mt-2.5 flex flex-none items-center gap-2 rounded-sm border border-accent-edge bg-accent-soft px-2.5 py-2 text-10.5 text-text" data-slot="definitions-candidate">
      <PackageSearch className="flex-none text-accent" size={14} />
      <span
        className={cn('min-w-0 flex-auto truncate text-dim', PATH_TEXT)}
        title={packageCandidate.path}
      >
        {packageCandidate.path}
      </span>
      <Button variant="primary" size="compact" onClick={packageCandidate.onLoad}>
        Load from package
      </Button>
    </div>
  );

  const hasProblems = diagnostics.some((diagnostic) => diagnostic.level !== 'info');

  const newPaintButton = (
    <Button
      variant="outline"
      size="compact"
      data-slot="definitions-new"
      aria-expanded={creating}
      disabled={!state.canAddWarPaint || status === 'importing'}
      title={state.canAddWarPaint ? undefined : 'Clear the imported proto_defs.vpd to create a new war paint.'}
      onClick={() => setCreating((open) => !open)}
    >
      <Plus size={12} />
      <span>New war paint</span>
    </Button>
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

  const nameField = (
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
  );

  const createFields = (
    // No card of its own; the tab already frames it.
    <div className={cn('flex w-full max-w-96 flex-none flex-col gap-2 p-3 text-left', COMPACT_INPUTS, status === 'loaded' ? 'max-w-none *:max-w-90' : 'mx-auto')}>
      <strong className="text-12 font-[650] text-text">New war paint</strong>
      {stockKit && state.exportSelectedStockKit && (
        <Control label="Start from" group>
          <ToggleGroup
            size="compact"
            label="Start from"
            value={copying ? 'copy' : 'template'}
            onChange={chooseSource}
            options={[
              { value: 'template', label: <span className="block truncate">Stock template</span> },
              { value: 'copy', label: <span className="block truncate">Copy of {stockKit.name}</span> },
            ]}
          />
        </Control>
      )}
      {copying ? nameField : templates && template ? (
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
          <p className={CREATE_SUMMARY}>
            {templateSummary(template, (templates.usage[String(template.defindex)] ?? []).length)}
          </p>
          {examples.length > 0 && (
            <p className={CREATE_SUMMARY}>
              Examples:{' '}
              {examples.map((kit, index) => (
                <span key={kit.id}>
                  {index > 0 && ', '}
                  <Button variant="link" size="inline" className="p-0 font-normal" onClick={() => onSelectKit(kit.id)}>
                    {kit.name}
                  </Button>
                </span>
              ))}
            </p>
          )}
          {nameField}
        </>
      ) : (
        <div className={STATUS}>
          {templateStatus.failed ? 'Could not load the templates.' : 'Loading templates...'}
        </div>
      )}
    </div>
  );

  const canSubmit = copying || Boolean(templates && template);

  // The fields scroll in a short drawer. The actions and any error stay in view below them, as on the Export tab.
  const createForm = (fields: ReactNode, className?: string) => (
    <div className={cn('flex min-h-0 flex-col', className)} data-slot="definitions-create" role="group" aria-label="New war paint">
      <div className="scrollbar-slim flex min-h-0 flex-auto flex-col justify-center-safe overflow-auto">{fields}</div>
      <div className={CREATE_ACTIONS} data-slot="definitions-create-actions">
        {canSubmit && creatingError && (
          <InlineNotice tone="error" className="flex-auto" role="alert">{creatingError}</InlineNotice>
        )}
        {!canSubmit && templateStatus.failed && (
          <Button variant="outline" size="compact" onClick={templateStatus.retry}>
            Retry
          </Button>
        )}
        <Button variant="outline" size="compact" onClick={() => setCreating(false)}>
          Cancel
        </Button>
        {canSubmit && (
          <Button
            variant="primary"
            size="compact"
            disabled={creatingBusy || !state.canAddWarPaint}
            onClick={createWarPaint}
          >
            Create
          </Button>
        )}
      </div>
    </div>
  );

  if (status !== 'loaded') {
    const belowContent = (
      <>
        {candidateRow}
        <DiagnosticsList className={cn(DIAGNOSTICS_GUTTER, 'not-empty:mb-3')} diagnostics={diagnostics} />
      </>
    );
    if (creating && status !== 'importing') {
      return (
        <div className="flex min-h-0 flex-1 flex-col" data-slot="definitions-panel" data-status={status}>
          {createForm(<>{createFields}{belowContent}</>, 'flex-1')}
        </div>
      );
    }
    return (
      // Safe centring keeps diagnostics reachable in the short drawer.
      <div className="scrollbar-slim flex min-h-0 flex-1 flex-col justify-center-safe overflow-auto" data-slot="definitions-panel" data-status={status}>
        {status === 'importing' ? (
          <div className={STATUS}>
            <LoaderCircle className="animate-spin motion-reduce:animate-none" size={16} />{' '}
            Reading {fileName ?? 'definitions'}...
          </div>
        ) : (
          // A failed import takes priority over the pitch, so the pitch shrinks to leave room for its diagnostics.
          <div className={cn('mx-auto flex max-w-85 flex-[1_0_auto] flex-col items-center justify-center gap-2.5 px-4 py-5 text-center text-dim', hasProblems && 'flex-none gap-1.75 pt-3 pb-0.5')}>
            <ScrollText className="opacity-80" size={22} />
            <strong className="text-12 text-text">No definitions imported</strong>
            <span className="text-11 leading-normal">
              Import a paint's JSON files or a proto_defs.vpd, or start a new
              war paint from a stock template. Mounting a paint's archive
              finds its files for you.
            </span>
            <div className="mt-1 flex items-center justify-center gap-2">
              <ImportPicker state={state} label="Import definitions" />
              {newPaintButton}
            </div>
          </div>
        )}
        {belowContent}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-slot="definitions-panel" data-status="loaded">
      <div className="flex min-h-10 flex-none items-center gap-2 border-b border-border px-3 py-1.75">
        <SearchField
          className={cn('max-w-60 flex-auto', COMPACT_INPUTS)}
          data-slot="definitions-search"
          value={filter}
          onChange={setFilter}
          placeholder="Filter definitions..."
          // SearchField clears on Escape. Marked handled, so that the same key does not also close the drawer.
          onKeyDown={(event) => {
            if (event.key === 'Escape' && filter) event.preventDefault();
          }}
        />
        <span className="min-w-0 truncate text-10.5 font-[650] text-text" title={fileName}>
          {fileName}
        </span>
        <span className="ml-auto flex-none text-11 whitespace-nowrap text-dim">{plural(kits.length, 'kit')}</span>
        {newPaintButton}
        <ImportPicker state={state} label="Replace" />
        <Button
          variant={confirmRemove ? 'armed' : 'outline'}
          size="compact"
          onClick={() => (confirmRemove ? onRemove() : armRemove())}
        >
          <Trash2 size={12} />
          {confirmRemove ? 'Remove it?' : 'Remove'}
        </Button>
      </div>

      {creating && createForm(createFields, 'border-b border-border')}
      {candidateRow}
      <DiagnosticsList className={cn(DIAGNOSTICS_GUTTER, 'scrollbar-slim not-empty:max-h-[45%] not-empty:overflow-auto')} diagnostics={diagnostics} />

      {/* Padding on the inside, so that a create form filling a short drawer leaves no sliver of this list. */}
      <div className="scrollbar-slim min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full flex-col gap-1.5 px-3 pt-2 pb-3">
          {filteredKits.length === 0 ? (
            <div className="flex flex-auto items-center justify-center gap-2 text-11 text-dim">
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
    </div>
  );
}
