import { useEffect, useId, useState } from 'react';
import { AlertTriangle, ChevronDown, Info, LoaderCircle, Trash2, Upload } from 'lucide-react';
import type { SourceDiagnostic, SourcePackageFormat } from '../source/contracts';

export type { SourcePackageFormat } from '../source/contracts';
export type SourcePackageDiagnostic = SourceDiagnostic;

export interface SourcePackageSummary {
  name: string;
  format: SourcePackageFormat;
  /** Every indexed entry, including `models/` and other unconsumed directories. */
  entryCount: number;
  /** Indexed entries under `materials/`, grouped by extension. */
  materialsByExtension: { extension: string; count: number }[];
  /** Package files the current recipe has actually read so far. */
  usedCount: number;
  /** Recipe inputs the package did not provide, which fell back to built-ins. */
  fallbackCount: number;
}

export interface SourcePackageState {
  status: 'empty' | 'importing' | 'mounted';
  /** Present while importing and after a successful mount. */
  summary?: SourcePackageSummary;
  diagnostics: SourcePackageDiagnostic[];
  onImport: (files: File[]) => void;
  onRemove: () => void;
}

export const SOURCE_PACKAGE_ACCEPT = '.zip,.vpk';

const FORMAT_LABEL: Record<SourcePackageFormat, string> = { zip: 'ZIP', vpk: 'VPK' };

function countMaterials(summary: SourcePackageSummary): number {
  return summary.materialsByExtension.reduce((total, entry) => total + entry.count, 0);
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}

function ImportPicker({
  state,
  className,
  label,
}: {
  state: SourcePackageState;
  className: string;
  label: string;
}) {
  const busy = state.status === 'importing';
  return (
    <label className={className} data-busy={busy ? '' : undefined}>
      <Upload size={12} />
      <span>{label}</span>
      <input
        type="file"
        accept={SOURCE_PACKAGE_ACCEPT}
        // Multiple selection exists for multipart VPKs, where the `_dir.vpk`
        // and every numbered segment have to arrive together.
        multiple
        disabled={busy}
        aria-label="Import a Source asset package"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length) state.onImport(files);
        }}
      />
    </label>
  );
}

/**
 * Header-level entry point. It only occupies the toolbar while no package is
 * mounted; once one is, the bar below owns replacing and removing it, so there
 * is exactly one import control on screen in either state.
 */
export function SourcePackageImport({ state }: { state: SourcePackageState }) {
  if (state.status !== 'empty') return null;
  return <ImportPicker state={state} className="source-package-header-import" label="Source package" />;
}

/**
 * The active-package bar, directly under the workbench header. One package is
 * mounted at a time and it overrides matching recipe textures, so this is a
 * single row rather than a list. It also carries import diagnostics, which is
 * why it still renders after a failed import left nothing mounted.
 */
export function SourcePackagePanel({ state }: { state: SourcePackageState }) {
  const { status, summary, diagnostics, onRemove } = state;
  const [expanded, setExpanded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const detailsId = useId();

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  // A replaced or removed package invalidates whatever the details region was
  // describing; collapsing avoids showing a stale breakdown mid-transition.
  useEffect(() => {
    if (status !== 'mounted') setExpanded(false);
  }, [status]);

  if (status === 'empty' && diagnostics.length === 0) return null;

  return (
    <div className="source-package" data-status={status}>
      {status === 'mounted' && summary && (
        <div className="source-package-row">
          <span className="source-package-format" data-format={summary.format}>
            {FORMAT_LABEL[summary.format]}
          </span>
          <span className="source-package-name" title={summary.name}>{summary.name}</span>
          <span className="source-package-stats">
            <span>{plural(summary.entryCount, 'file')}</span>
            <span>{plural(countMaterials(summary), 'material')}</span>
            <span data-emphasis="">{summary.usedCount.toLocaleString()} used</span>
            {summary.fallbackCount > 0 && (
              <span title="Recipe inputs this package does not provide, which fall back to the viewer's built-in textures">
                {summary.fallbackCount.toLocaleString()} built-in
              </span>
            )}
          </span>
          <button
            type="button"
            className="source-package-btn"
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded((open) => !open)}
          >
            Details
            <ChevronDown size={12} />
          </button>
          <ImportPicker state={state} className="source-package-btn" label="Replace" />
          <button
            type="button"
            className="source-package-btn source-package-remove"
            data-confirm={confirmRemove ? '' : undefined}
            onClick={() => (confirmRemove ? onRemove() : setConfirmRemove(true))}
          >
            <Trash2 size={12} />
            {confirmRemove ? 'Remove it?' : 'Remove'}
          </button>
        </div>
      )}

      {status === 'importing' && (
        <div className="source-package-row">
          <LoaderCircle className="custom-workbench-spinner" size={13} />
          <span className="source-package-name">Reading {summary?.name ?? 'package'}...</span>
        </div>
      )}

      {status === 'mounted' && summary && expanded && (
        <div className="source-package-details" id={detailsId}>
          <span className="source-package-details-label">materials/</span>
          {summary.materialsByExtension.length === 0 ? (
            <span className="source-package-chip" data-empty="">no textures indexed</span>
          ) : (
            summary.materialsByExtension.map((entry) => (
              <span className="source-package-chip" key={entry.extension}>
                .{entry.extension}
                <b>{entry.count.toLocaleString()}</b>
              </span>
            ))
          )}
        </div>
      )}

      {diagnostics.length > 0 && (
        <ul className="source-package-diagnostics">
          {diagnostics.map((diagnostic) => (
            <li key={diagnostic.id} data-level={diagnostic.level}>
              {diagnostic.level === 'info' ? <Info size={11} /> : <AlertTriangle size={11} />}
              <span>
                {diagnostic.message}
                {diagnostic.detail && <code>{diagnostic.detail}</code>}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
