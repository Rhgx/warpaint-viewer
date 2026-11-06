import { useMemo, useState } from 'react';
import {
  Download,
  FileDown,
  Info,
  LoaderCircle,
  PackageCheck,
} from 'lucide-react';

import type { TextureMetadata } from '../../data/types';
import type { ExportCompression } from '../../export/plan';
import { estimateBytes, exportPathFor, sanitizePackName, warningsFor } from '../../export/plan';
import { useWarpaintExport } from './useWarpaintExport';
import type {
  ExportDefinitionsContext,
  ExportItem,
} from '../../workbench/exportTypes';
import { ControlLabel, TextField } from '../common/controls';
import { formatSize } from '../common/formatSize';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { EmptyState } from '../primitives/EmptyState';
import { COMPACT_INPUTS, SearchField } from '../primitives/Input';
import { InlineNotice } from '../primitives/Notice';
import { PATH_TEXT, SECTION_TITLE } from '../primitives/textStyles';
import { ToggleGroup } from '../primitives/ToggleGroup';

interface ExportPanelProps {
  items: ExportItem[];
  /** Asset recipes are still resolving; exporting now could produce a partial pack. */
  loading?: boolean;
  textureMetadata?: Record<string, TextureMetadata>;
  paintName?: string;
  weaponName?: string;
  gameBuild?: string | null;
  /** When the shipped game-data snapshot was taken (manifest generatedAt). */
  snapshotDate?: string | null;
  definitions?: ExportDefinitionsContext;
  /** Lets the empty state link to the Files and Package tabs, which act on the selected paint. */
  onGoToTab?: (tab: 'files' | 'package') => void;
}

const CONTAINER_OPTIONS: { value: 'vpk' | 'zip'; label: string }[] = [
  { value: 'vpk', label: 'VPK' },
  { value: 'zip', label: 'Folder' },
];

const COMPRESSION_OPTIONS: { value: ExportCompression; label: string }[] = [
  { value: 'auto', label: 'Match the game (DXT)' },
  { value: 'lossless', label: 'Lossless (larger)' },
];

const DEFINITIONS_OPTIONS: { value: 'overwrite' | 'append'; label: string }[] = [
  { value: 'overwrite', label: 'Replace a war paint I own' },
  { value: 'append', label: 'Add as a new war paint' },
];

// The stage narrows as drawers open, so these query the panel rather than the window.
const COL = 'flex min-w-0 flex-col gap-2 border-r border-border px-3 py-2 last:border-r-0 @max-[560px]:border-r-0 @max-[560px]:border-b @max-[560px]:last:border-b-0';
const COL_TITLE = cn('m-0', SECTION_TITLE);
const FIELD = cn('flex min-w-0 flex-col gap-1.5', COMPACT_INPUTS);
const INLINE_LINK = 'text-accent underline';
const BASE_ACTION = 'relative flex-none cursor-pointer border-0 bg-transparent p-0 text-11 text-text underline underline-offset-2 focus-ring hover:text-accent';

const DEFINITIONS_PLUGIN_URL = 'https://github.com/ficool2/custom_items_games/releases/latest';
const WARPAINT_SERVER_PLUGIN_URL = 'https://github.com/Mince1844/tf2warpaints';
const PAINT_PICKER_INITIAL_RESULTS = 40;

/** Picking a war paint to take over is a search, not a dropdown: nobody scrolls an alphabetical list for one they own. */
function PaintPicker({
  kits,
  value,
  onChange,
}: {
  kits: { defindex: number; name: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const [query, setQuery] = useState('');
  const trimmed = query.trim().toLowerCase();
  const matches = useMemo(
    () => (trimmed
      ? kits.filter((kit) => kit.name.toLowerCase().includes(trimmed))
      : kits),
    [kits, trimmed],
  );
  const selected = kits.find((kit) => String(kit.defindex) === value);
  const visibleMatches = useMemo(() => {
    if (matches.length <= PAINT_PICKER_INITIAL_RESULTS) return matches;
    const firstMatches = matches.slice(0, PAINT_PICKER_INITIAL_RESULTS);
    // Keep the selected kit listed even when it falls outside the first page.
    if (selected && !firstMatches.some((kit) => kit.defindex === selected.defindex)) {
      return [selected, ...firstMatches.slice(0, PAINT_PICKER_INITIAL_RESULTS - 1)];
    }
    return firstMatches;
  }, [matches, selected]);
  const hasMoreMatches = visibleMatches.length < matches.length;

  return (
    <div className="flex min-h-0 flex-col gap-1.25">
      <SearchField
        value={query}
        onChange={setQuery}
        placeholder={selected ? selected.name : 'Filter war paints...'}
        // SearchField clears on Escape. Marked handled, so that the same key does not also close the drawer.
        onKeyDown={(event) => {
          if (event.key === 'Escape' && query) event.preventDefault();
        }}
      />
      {/* Four rows at control height, so the list does not take the column over. */}
      <div className="scrollbar-slim flex max-h-30.5 flex-col gap-px overflow-y-auto rounded-sm border border-border bg-panel-2 p-0.5" role="listbox" aria-label="War paint to replace">
        {matches.length === 0 ? (
          <p className="m-0 px-1.75 py-1.5 text-11 text-dim">No war paint matches “{query.trim()}”.</p>
        ) : (
          visibleMatches.map((kit) => (
            <button
              key={kit.defindex}
              type="button"
              role="option"
              aria-selected={String(kit.defindex) === value}
              className="min-h-control flex-none cursor-pointer rounded-sm border-0 bg-transparent px-1.75 py-1 text-left text-11 text-dim focus-ring focus-visible:-outline-offset-2 hover:bg-accent/14 hover:text-text data-selected:bg-accent-soft data-selected:font-semibold data-selected:text-text"
              data-selected={String(kit.defindex) === value ? '' : undefined}
              onClick={() => onChange(String(kit.defindex))}
            >
              {kit.name}
            </button>
          ))
        )}
        {hasMoreMatches && (
          <p className="mx-1.25 mt-0.5 mb-1 text-center text-11 text-dim">
            Showing {visibleMatches.length} of {matches.length}. Search to find another paint.
          </p>
        )}
      </div>
    </div>
  );
}

/** Shows a date, since "17 Jul 2026" answers whether a pack is older than the game, unlike a build number. */
function formatSnapshotDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // Fixed to en-GB, not the browser locale, to match the English interface.
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Title-cases an authoring name like `flak_furnished`, since the in-game name field becomes the paint's label. */
function humanizePaintName(name: string | undefined): string {
  if (!name) return '';
  return name
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

function defaultPackName(paintName: string | undefined): string {
  return sanitizePackName(paintName ? `${paintName} custom` : 'my warpaint');
}

export function ExportPanel({
  items,
  loading = false,
  textureMetadata,
  paintName,
  weaponName,
  gameBuild,
  snapshotDate,
  definitions,
  onGoToTab,
}: ExportPanelProps) {
  const [packName, setPackName] = useState(() => defaultPackName(paintName));
  const [container, setContainer] = useState<'zip' | 'vpk'>('vpk');
  const [compression, setCompression] = useState<ExportCompression>('auto');
  const [definitionsMode, setDefinitionsMode] = useState<'overwrite' | 'append'>('overwrite');
  const [targetDefindex, setTargetDefindex] = useState('');
  const [inGameName, setInGameName] = useState(() => humanizePaintName(paintName));
  // Null means the shipped snapshot, which is the case for almost everyone.
  const [baseContainer, setBaseContainer] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [baseError, setBaseError] = useState('');

  // A paint from imported definitions must carry them or it cannot show up in game.
  // A stock paint already exists there, so the whole section stays hidden for it.
  const writesDefinitions = Boolean(definitions?.isImported);
  const { busy, error, done, buildNotes, runExport } = useWarpaintExport({
    items,
    textureMetadata,
    definitions,
    writesDefinitions,
    definitionsMode,
    targetDefindex,
    inGameName,
    packName,
    container,
    compression,
    paintName,
    weaponName,
    gameBuild,
    snapshotDate,
  });

  const snapshotDay = formatSnapshotDate(snapshotDate);
  const snapshotLabel = snapshotDay
    ? `TF2 definitions from ${snapshotDay}, included`
    : 'TF2 definitions, included';

  const packageFileCount = definitions?.packageFileCount;
  const packageMounted = definitions?.packageMounted;
  const unresolvedTextureRefs = definitions?.unresolvedTextureRefs;

  const plan = useMemo(() => {
    const files = items.map((item) => ({
      ref: item.ref,
      path: exportPathFor(item.ref),
      lossless: compression === 'lossless' || item.kind === 'mask' || item.kind === 'sticker-mask',
      bytes: item.size
        ? estimateBytes(item.kind, compression, item.size.width, item.size.height)
        : undefined,
      size: item.size,
    }));
    const warnings = items.flatMap((item) =>
      warningsFor(item.ref, item.size?.width, item.size?.height, textureMetadata?.[item.ref]),
    );
    // A definition with no artwork installs cleanly and then renders nothing.
    // Published packs often name texture paths their archive lacks; the viewer then draws stock textures.
    if (writesDefinitions && items.length === 0 && !packageFileCount) {
      warnings.push(
        packageMounted
          ? 'None of this paint’s textures could be matched in the mounted package, so the pack carries its definitions only. The viewer is showing stock textures for the same reason: the paint’s texture paths and the archive’s layout do not line up.'
          : 'This pack carries the paint’s definitions but no textures. Replace its artwork in the Files tab, or mount the package its textures come from.',
      );
    }
    if (writesDefinitions && unresolvedTextureRefs?.length) {
      warnings.push(
        `${unresolvedTextureRefs.length} custom texture path${unresolvedTextureRefs.length === 1 ? '' : 's'} `
        + `named by this paint exist in neither the mounted package nor TF2's stock data `
        + `(for example ${unresolvedTextureRefs[0]}). The source package is incomplete.`,
      );
    }
    const total = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    return { files, warnings, total };
  }, [
    items,
    compression,
    textureMetadata,
    writesDefinitions,
    packageFileCount,
    packageMounted,
    unresolvedTextureRefs,
  ]);

  // Checked on pick, not at export, so a non-container file is reported while the picker is open.
  const adoptBaseContainer = async (file: File) => {
    setBaseError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const { parseProtoDefGroups } = await import('../../export/protoWrite');
      const groups = parseProtoDefGroups(bytes);
      if (!groups.some((group) => group.defType === 9 && group.payloads.length > 0)) {
        throw new Error('This file has no war paint definitions in it.');
      }
      setBaseContainer({ name: file.name, bytes });
    } catch (cause) {
      setBaseError(cause instanceof Error ? cause.message : 'That file could not be read as proto_defs.');
    }
  };

  // Must be answered before exporting; shown on the control and button, not thrown at build.
  const blocker = writesDefinitions && definitionsMode === 'overwrite' && !targetDefindex
    ? 'Choose the war paint this replaces'
    : '';

  if (items.length === 0 && !definitions?.isImported && !definitions?.packageFileCount) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center" data-slot="export-panel" data-status="empty">
        <EmptyState icon={<FileDown size={22} />} title="Nothing to export yet">
          <span className="text-11 leading-normal">
            This tab packs whatever the viewer is showing into a mod for TF2. Give
            it something to work with:
          </span>
          <span className="mt-0.5 flex flex-wrap justify-center gap-1.5">
            <Button variant="outline" size="compact" onClick={() => onGoToTab?.('files')}>Replace a texture</Button>
            <Button variant="outline" size="compact" onClick={() => onGoToTab?.('package')}>Mount an archive</Button>
          </span>
        </EmptyState>
      </div>
    );
  }

  const columnCount = 1 + Number(writesDefinitions) + Number(plan.files.length > 0);
  const hasNotes = plan.warnings.length > 0 || buildNotes.length > 0;
  const notes = (
    <div className="flex flex-col gap-1">
      {/* Cautions before exporting, then results from the last export. */}
      {plan.warnings.map((warning) => (
        <InlineNotice key={warning}>{warning}</InlineNotice>
      ))}
      {buildNotes.map((note) => (
        <p className="m-0 flex items-start gap-1 text-11 leading-[1.4] text-dim" key={note}>
          <Info className="mt-0.5 flex-none text-accent" size={12} />
          <span>{note}</span>
        </p>
      ))}
    </div>
  );

  return (
    // Decisions read across in columns, as the drawer is wide and short. The action bar never scrolls away.
    <div className="@container flex min-h-0 flex-1 flex-col" data-slot="export-panel">
      <div
        className={cn(
          'scrollbar-slim grid min-h-0 flex-auto items-start overflow-y-auto @max-[560px]:grid-cols-1',
          // A narrow stage cannot hold three columns: drop to two, then to one.
          columnCount === 2
            ? 'grid-cols-[minmax(180px,1fr)_minmax(210px,1fr)]'
            : 'grid-cols-[minmax(180px,1fr)_minmax(240px,1.4fr)_minmax(210px,1fr)] @max-[900px]:grid-cols-2',
        )}
        data-slot="export-grid"
      >
        {/* Beside the choices when there is a column to share, as the drawer is too short to stack them. */}
        {hasNotes && plan.files.length === 0 && (
          <div className="col-span-full border-b border-border px-3 py-2.5">{notes}</div>
        )}
        <section className={COL} aria-label="Pack">
          <h3 className={COL_TITLE}>Pack</h3>
          <label className={FIELD}>
            <ControlLabel>Name</ControlLabel>
            <TextField value={packName} onChange={setPackName} placeholder="my warpaint" />
          </label>
          <div className={FIELD}>
            <ControlLabel>Deliver as</ControlLabel>
            <ToggleGroup
              radio
              size="compact"
              value={container}
              onChange={setContainer}
              options={CONTAINER_OPTIONS}
              label="Delivery format"
            />
          </div>
          <div className={FIELD}>
            <ControlLabel>Textures</ControlLabel>
            <ToggleGroup
              radio
              size="compact"
              value={compression}
              onChange={setCompression}
              options={COMPRESSION_OPTIONS}
              label="Texture compression"
            />
          </div>
        </section>

        {writesDefinitions && definitions && (
          <section className={COL} aria-label="In game">
            <h3 className={COL_TITLE}>In game</h3>
            <div className={FIELD}>
              <ControlLabel>Install this paint by</ControlLabel>
              <ToggleGroup
                radio
                size="compact"
                value={definitionsMode}
                onChange={setDefinitionsMode}
                options={DEFINITIONS_OPTIONS}
                label="How the paint is installed"
              />
            </div>
            {definitionsMode === 'overwrite' ? (
              <div className={FIELD}>
                <ControlLabel>Paint to replace</ControlLabel>
                <PaintPicker
                  kits={definitions.builtInKits}
                  value={targetDefindex}
                  onChange={setTargetDefindex}
                />
                {blocker && <InlineNotice>{blocker}</InlineNotice>}
              </div>
            ) : (
              <p className="m-0 text-11 leading-normal text-dim">
                Nothing in the game owns a new paint, so equipping it needs the{' '}
                <a className={INLINE_LINK} href={WARPAINT_SERVER_PLUGIN_URL} target="_blank" rel="noreferrer">
                  tf2warpaints plugin
                </a>{' '}
                or similar tooling.
              </p>
            )}
            <label className={FIELD}>
              <ControlLabel>Name in game</ControlLabel>
              <TextField
                value={inGameName}
                onChange={setInGameName}
                placeholder={humanizePaintName(paintName) || 'War paint'}
              />
            </label>
            <div className="flex items-baseline gap-1.5 text-11">
              <ControlLabel className="flex-none">Built on</ControlLabel>
              <span
                className="min-w-0 flex-auto truncate text-text"
                title={baseContainer ? baseContainer.name : (gameBuild ? `TF2 build ${gameBuild}` : undefined)}
              >
                {baseContainer
                  ? `${baseContainer.name} (${formatSize(baseContainer.bytes.byteLength)})`
                  : snapshotLabel}
              </span>
              {baseContainer ? (
                <button type="button" className={BASE_ACTION} onClick={() => { setBaseContainer(null); setBaseError(''); }}>
                  Use ours
                </button>
              ) : (
                <label className={cn(BASE_ACTION, 'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent')}>
                  Use my own
                  <input
                    className="sr-only"
                    type="file"
                    accept=".vpd,.bin"
                    aria-label="Use my own proto_defs.vpd as the base definitions"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void adoptBaseContainer(file);
                    }}
                  />
                </label>
              )}
            </div>
            {baseError && <InlineNotice tone="error">{baseError}</InlineNotice>}
            <p className="m-0 mt-auto flex items-start gap-1.5 rounded-sm border border-border bg-panel-2 px-2 py-1.75 text-11 leading-normal text-dim">
              <Info className="mt-0.5 flex-none text-accent" size={12} />
              <span>
                Shipping definitions needs the{' '}
                <a className={INLINE_LINK} href={DEFINITIONS_PLUGIN_URL} target="_blank" rel="noreferrer">
                  custom_items_games plugin
                </a>{' '}
                and TF2 launched with <code className={cn('rounded-[3px] bg-text/12 px-0.75', PATH_TEXT)}>-insecure</code>. Without both, TF2
                rejects the unsigned definitions file at startup.
              </span>
            </p>
          </section>
        )}

        {plan.files.length > 0 && (
          <section className={cn(COL, 'min-h-0 @max-[900px]:col-span-full @max-[900px]:border-t @max-[900px]:border-r-0 @max-[560px]:border-t-0')} aria-label="Files">
            <h3 className={COL_TITLE}>
              {plan.files.length} file{plan.files.length === 1 ? '' : 's'}
              {plan.total > 0 ? ` · ~${formatSize(plan.total)}` : ''}
            </h3>
            {hasNotes && notes}
            <div className="scrollbar-slim flex min-h-0 flex-col gap-0.5 overflow-y-auto">
              {plan.files.map((file) => (
                <div className="flex items-baseline gap-2 rounded-sm bg-panel-2 px-1.5 py-1" key={file.ref}>
                  <span className={cn('min-w-0 flex-auto truncate text-text', PATH_TEXT)} title={file.path}>{file.path}</span>
                  <span className="flex-none text-11 text-dim">
                    {file.size ? `${file.size.width} x ${file.size.height}` : 'unknown size'}
                    {' · '}
                    {file.lossless ? 'lossless' : 'DXT'}
                  </span>
                  <span className="flex-none text-11 text-dim">{file.bytes ? `~${formatSize(file.bytes)}` : ''}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="flex flex-none items-center gap-2.5 border-t border-border px-3.5 py-2.25">
        <span className="min-w-0 flex-auto truncate text-11 text-dim">
          {container === 'vpk'
            ? `Extract the download, then drop ${sanitizePackName(packName)}.vpk into tf/custom/ and restart TF2.`
            : `Extract ${sanitizePackName(packName)} into tf/custom/, then restart TF2.`}
        </span>
        {error && (
          <InlineNotice tone="error" className="max-w-[40%] flex-none" role="alert">
            <span className="block truncate">{error}</span>
          </InlineNotice>
        )}
        {done && !error && (
          <span className="flex flex-none items-center gap-1.25 text-11 text-dim">
            <PackageCheck size={12} /> Exported {done}
          </span>
        )}
        <Button
          variant="primary"
          size="compact"
          disabled={busy || loading || Boolean(blocker)}
          title={blocker || undefined}
          onClick={() => void runExport()}
        >
          {busy ? <LoaderCircle className="animate-spin motion-reduce:animate-none" size={12} /> : <Download size={12} />}
          <span>{busy ? 'Building…' : loading ? 'Resolving assets…' : blocker || 'Export pack'}</span>
        </Button>
      </div>
    </div>
  );
}
