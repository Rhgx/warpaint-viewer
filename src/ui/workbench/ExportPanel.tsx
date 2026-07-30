import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Download,
  FileDown,
  Info,
  LoaderCircle,
  PackageCheck,
  Search,
} from 'lucide-react';
import type { TextureMetadata } from '../../data/types';
import type { ExportCompression } from '../../export/plan';
import { estimateBytes, exportPathFor, sanitizePackName, warningsFor } from '../../export/plan';
import { useWarpaintExport } from '../../hooks/useWarpaintExport';
import type {
  ExportDefinitionsContext,
  ExportItem,
} from '../../workbench/exportTypes';
import { TextField } from '../common/controls';
import './ExportPanel.css';

export type { ExportDefinitionsContext, ExportItem } from '../../workbench/exportTypes';

export interface ExportPanelProps {
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
  /**
   * Lets the empty state send people to the tab that fills it. Only the two
   * tabs that act on the paint already selected: importing definitions adds
   * catalog entries instead, so it does not fill this tab on its own.
   */
  onGoToTab?: (tab: 'files' | 'package') => void;
}

const CONTAINER_OPTIONS = [
  { value: 'vpk', label: 'VPK' },
  { value: 'zip', label: 'Folder' },
];

const COMPRESSION_OPTIONS = [
  { value: 'auto', label: 'Match the game (DXT)' },
  { value: 'lossless', label: 'Lossless (larger)' },
];

const DEFINITIONS_OPTIONS = [
  { value: 'overwrite', label: 'Replace a war paint I own' },
  { value: 'append', label: 'Add as a new war paint' },
];

const DEFINITIONS_PLUGIN_URL = 'https://github.com/ficool2/custom_items_games/releases/latest';
const WARPAINT_SERVER_PLUGIN_URL = 'https://github.com/Mince1844/tf2warpaints';

/**
 * Two-option choices read better as one visible pair than as a dropdown that
 * hides the alternative, and this drawer is short enough that saving a click
 * and a popup matters.
 */
function Segmented({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <div className="export-segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className="export-segment"
          data-active={value === option.value ? '' : undefined}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Choosing which of 250 war paints to take over is a search problem, not a
 * dropdown problem: nobody scrolls an alphabetical list to find the one they
 * happen to own. Filtering in place also keeps the choice and its result on
 * screen together, which a popup would cover.
 */
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
  const matches = trimmed
    ? kits.filter((kit) => kit.name.toLowerCase().includes(trimmed))
    : kits;
  const selected = kits.find((kit) => String(kit.defindex) === value);

  return (
    <div className="export-picker">
      <div className="export-picker-search">
        <Search size={12} />
        <TextField
          value={query}
          onChange={setQuery}
          placeholder={selected ? selected.name : 'Search war paints'}
        />
      </div>
      <div className="export-picker-list" role="listbox" aria-label="War paint to replace">
        {matches.length === 0 ? (
          <p className="export-picker-empty">No war paint matches “{query.trim()}”.</p>
        ) : (
          matches.map((kit) => (
            <button
              key={kit.defindex}
              type="button"
              role="option"
              aria-selected={String(kit.defindex) === value}
              className="export-picker-option"
              data-selected={String(kit.defindex) === value ? '' : undefined}
              onClick={() => onChange(String(kit.defindex))}
            >
              {kit.name}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * "TF2 build 10828683" means nothing to most people; "17 Jul 2026" answers the
 * only question they have, which is whether this is older than their game. The
 * build number stays on hover for anyone who does want to match it exactly.
 */
function formatSnapshotDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  // Fixed to en-GB rather than the browser locale: the rest of this interface
  // is English, and a localized month inside an English sentence reads as a
  // glitch rather than as a courtesy.
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Definitions carry an authoring name (`flak_furnished`), which is not a thing
 * to put in front of a player. Title-case it for the in-game name field, where
 * whatever is typed becomes the paint's actual label.
 */
function humanizePaintName(name: string | undefined): string {
  if (!name) return '';
  return name
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[a-z]/g, (character) => character.toUpperCase());
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
  const [container, setContainer] = useState('vpk');
  const [compression, setCompression] = useState('auto');
  const [definitionsMode, setDefinitionsMode] = useState('overwrite');
  const [targetDefindex, setTargetDefindex] = useState('');
  const [inGameName, setInGameName] = useState(() => humanizePaintName(paintName));
  // Null means the shipped snapshot, which is the case for almost everyone.
  const [baseContainer, setBaseContainer] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [baseError, setBaseError] = useState('');

  // The app already knows which of the two situations it is in, so it does not
  // ask. A paint from imported definitions has to carry them or it cannot show
  // up in game at all; a stock paint already exists there and only needs its
  // textures replaced. There is nothing to splice in the second case, so the
  // whole section stays out of the way.
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

  const plan = useMemo(() => {
    const files = items.map((item) => ({
      ref: item.ref,
      path: exportPathFor(item.ref),
      lossless: compression === 'lossless' || item.kind === 'mask' || item.kind === 'sticker-mask',
      bytes: item.size
        ? estimateBytes(item.kind, compression as ExportCompression, item.size.width, item.size.height)
        : undefined,
      size: item.size,
    }));
    const warnings = items.flatMap((item) =>
      warningsFor(item.ref, item.size?.width, item.size?.height, textureMetadata?.[item.ref]),
    );
    // A definition with no artwork behind it installs cleanly and then renders
    // nothing. The two ways to get here need different advice, and the second
    // is common: several published packs name texture paths their own archive
    // does not use, so the viewer is already drawing stock textures and the
    // export has nothing of the author's to carry.
    if (writesDefinitions && items.length === 0 && !definitions?.packageFileCount) {
      warnings.push(
        definitions?.packageMounted
          ? 'None of this paint’s textures could be matched in the mounted package, so the pack carries its definitions only. The viewer is showing stock textures for the same reason: the paint’s texture paths and the archive’s layout do not line up.'
          : 'This pack carries the paint’s definitions but no textures. Replace its artwork in the Files tab, or mount the package its textures come from.',
      );
    }
    if (writesDefinitions && definitions?.unresolvedTextureRefs.length) {
      warnings.push(
        `${definitions.unresolvedTextureRefs.length} custom texture path${definitions.unresolvedTextureRefs.length === 1 ? '' : 's'} `
        + `named by this paint exist in neither the mounted package nor TF2's stock data `
        + `(for example ${definitions.unresolvedTextureRefs[0]}). The source package is incomplete.`,
      );
    }
    const total = files.reduce((sum, file) => sum + (file.bytes ?? 0), 0);
    return { files, warnings, total };
  }, [
    items,
    compression,
    textureMetadata,
    writesDefinitions,
    definitions?.packageFileCount,
    definitions?.packageMounted,
    definitions?.unresolvedTextureRefs,
  ]);

  // Checked when it is picked, not when the export runs: a file that turns out
  // not to be a container should say so while the person still has the file
  // picker in mind.
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

  // The one thing that must be answered before exporting. Surfaced on the
  // control and on the button rather than thrown when the build runs.
  const blocker = writesDefinitions && definitionsMode === 'overwrite' && !targetDefindex
    ? 'Choose the war paint this replaces'
    : '';

  if (items.length === 0 && !definitions?.isImported && !definitions?.packageFileCount) {
    return (
      <div className="export-panel" data-status="empty">
        <div className="definitions-empty">
          <FileDown size={22} />
          <strong>Nothing to export yet</strong>
          <span>
            This tab packs whatever the viewer is showing into a mod for TF2. Give
            it something to work with:
          </span>
          <span className="export-empty-routes">
            <button type="button" onClick={() => onGoToTab?.('files')}>Replace a texture</button>
            <button type="button" onClick={() => onGoToTab?.('package')}>Mount an archive</button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="export-panel">
      <div className="export-grid">
        <section className="export-col" aria-label="Pack">
          <h3 className="export-col-title">Pack</h3>
          <label className="export-field">
            <span>Name</span>
            <TextField value={packName} onChange={setPackName} placeholder="my warpaint" />
          </label>
          <div className="export-field">
            <span>Deliver as</span>
            <Segmented
              value={container}
              onChange={setContainer}
              options={CONTAINER_OPTIONS}
              label="Delivery format"
            />
          </div>
          <div className="export-field">
            <span>Textures</span>
            <Segmented
              value={compression}
              onChange={setCompression}
              options={COMPRESSION_OPTIONS}
              label="Texture compression"
            />
          </div>
        </section>

        {writesDefinitions && definitions && (
          <section className="export-col" aria-label="In game">
            <h3 className="export-col-title">In game</h3>
            <div className="export-field">
              <span>Install this paint by</span>
              <Segmented
                value={definitionsMode}
                onChange={setDefinitionsMode}
                options={DEFINITIONS_OPTIONS}
                label="How the paint is installed"
              />
            </div>
            {definitionsMode === 'overwrite' ? (
              <div className="export-field">
                <span>Paint to replace</span>
                <PaintPicker
                  kits={definitions.builtInKits}
                  value={targetDefindex}
                  onChange={setTargetDefindex}
                />
                {blocker && <em className="export-field-hint">{blocker}</em>}
              </div>
            ) : (
              <p className="export-note">
                Nothing in the game owns a new paint, so equipping it needs the{' '}
                <a href={WARPAINT_SERVER_PLUGIN_URL} target="_blank" rel="noreferrer">
                  tf2warpaints plugin
                </a>{' '}
                or similar tooling.
              </p>
            )}
            <label className="export-field">
              <span>Name in game</span>
              <TextField
                value={inGameName}
                onChange={setInGameName}
                placeholder={humanizePaintName(paintName) || 'War paint'}
              />
            </label>
            <div className="export-base">
              <span className="export-base-label">Built on</span>
              <span
                className="export-base-value"
                title={baseContainer ? baseContainer.name : (gameBuild ? `TF2 build ${gameBuild}` : undefined)}
              >
                {baseContainer
                  ? `${baseContainer.name} (${formatSize(baseContainer.bytes.byteLength)})`
                  : snapshotLabel}
              </span>
              {baseContainer ? (
                <button type="button" className="export-base-action" onClick={() => { setBaseContainer(null); setBaseError(''); }}>
                  Use ours
                </button>
              ) : (
                <label className="export-base-action">
                  Use my own
                  <input
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
            {baseError && <em className="export-field-hint">{baseError}</em>}
            <p className="export-callout">
              <Info size={11} />
              <span>
                Shipping definitions needs the{' '}
                <a href={DEFINITIONS_PLUGIN_URL} target="_blank" rel="noreferrer">
                  custom_items_games plugin
                </a>{' '}
                and TF2 launched with <code>-insecure</code>. Without both, TF2
                rejects the unsigned definitions file at startup.
              </span>
            </p>
          </section>
        )}

        {plan.files.length > 0 && (
          <section className="export-col export-col-files" aria-label="Files">
            <h3 className="export-col-title">
              {plan.files.length} file{plan.files.length === 1 ? '' : 's'}
              {plan.total > 0 ? ` · ~${formatSize(plan.total)}` : ''}
            </h3>
            <div className="export-list">
              {plan.files.map((file) => (
                <div className="export-row" key={file.ref}>
                  <span className="export-row-path" title={file.path}>{file.path}</span>
                  <span className="export-row-meta">
                    {file.size ? `${file.size.width} x ${file.size.height}` : 'unknown size'}
                    {' · '}
                    {file.lossless ? 'lossless' : 'DXT'}
                  </span>
                  <span className="export-row-size">{file.bytes ? `~${formatSize(file.bytes)}` : ''}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {(plan.warnings.length > 0 || buildNotes.length > 0) && (
        <div className="export-messages">
          {/* Things to know before exporting, then what happened during the
              last export. They read as one list today, which makes a note
              about the finished pack look like a problem with the next one. */}
          {plan.warnings.map((warning) => (
            <p className="export-message" data-kind="caution" key={warning}>
              <AlertTriangle size={11} />
              <span>{warning}</span>
            </p>
          ))}
          {buildNotes.map((note) => (
            <p className="export-message" data-kind="result" key={note}>
              <Info size={11} />
              <span>{note}</span>
            </p>
          ))}
        </div>
      )}

      <div className="export-footer">
        <span className="export-total">
          {container === 'vpk'
            ? `Extract the download, then drop ${sanitizePackName(packName)}.vpk into tf/custom/ and restart TF2.`
            : `Extract ${sanitizePackName(packName)} into tf/custom/, then restart TF2.`}
        </span>
        {error && <span className="export-error" role="alert">{error}</span>}
        {done && !error && (
          <span className="export-done">
            <PackageCheck size={12} /> Exported {done}
          </span>
        )}
        <button
          type="button"
          className="definitions-btn definitions-btn-primary export-action"
          disabled={busy || loading || Boolean(blocker)}
          title={blocker || undefined}
          onClick={() => void runExport()}
        >
          {busy ? <LoaderCircle className="custom-workbench-spinner" size={12} /> : <Download size={12} />}
          <span>{busy ? 'Building…' : loading ? 'Resolving assets…' : blocker || 'Export pack'}</span>
        </button>
      </div>
    </div>
  );
}
