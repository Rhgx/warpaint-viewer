import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  LoaderCircle,
  PackageOpen,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  SourceDiagnostic,
  SourcePackageFormat,
} from '../source/contracts';

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
  /**
   * Refs bound by file name because this package has no materials/ tree to
   * place them under, and refs left unbound because their file name was not
   * unique. Both stay zero for a package with a real materials/ root.
   */
  nameMatchedCount: number;
  ambiguousNameCount: number;
  /** `.vmt` files under materials/, whether or not any weapon uses them. */
  materialCount: number;
  /** Package paths of the materials standing in for a weapon's built-in one. */
  appliedMaterialPaths: string[];
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

const FORMAT_LABEL: Record<SourcePackageFormat, string> = {
  zip: 'ZIP',
  vpk: 'VPK',
};

function countMaterials(summary: SourcePackageSummary): number {
  return summary.materialsByExtension.reduce(
    (total, entry) => total + entry.count,
    0,
  );
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
 * The Package tab's full content: an empty state explaining what a package is
 * for, a mounted summary row with its materials breakdown always visible (no
 * more expander now that the tab has room), or an importing spinner. Import
 * diagnostics render in every state since a failed import can still leave
 * nothing mounted.
 */
export function SourcePackagePanel({ state }: { state: SourcePackageState }) {
  const { status, summary, diagnostics, onRemove } = state;
  // Successful normalization and archive-safety observations are useful to
  // developers, but give users nothing to act on. Keep them in package state
  // while reserving the visible diagnostics area for problems.
  const visibleDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.level !== 'info',
  );
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = window.setTimeout(() => setConfirmRemove(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmRemove]);

  return (
    <div className="source-package" data-status={status}>
      {status === 'empty' && (
        <div className="source-package-empty">
          <PackageOpen size={22} />
          <span>
            A Source package supplies the textures a recipe asks for, in place
            of the viewer's built-ins.
          </span>
          <ImportPicker
            state={state}
            className="source-package-btn source-package-btn-primary"
            label="Source package"
          />
        </div>
      )}

      {status === 'importing' && (
        <div className="source-package-row">
          <LoaderCircle className="custom-workbench-spinner" size={13} />
          <span className="source-package-name">
            Reading {summary?.name ?? 'package'}...
          </span>
        </div>
      )}

      {status === 'mounted' && summary && (
        <div className="source-package-row">
          <span className="source-package-format" data-format={summary.format}>
            {FORMAT_LABEL[summary.format]}
          </span>
          <span className="source-package-name" title={summary.name}>
            {summary.name}
          </span>
          <span className="source-package-stats">
            <span>{plural(summary.entryCount, 'file')}</span>
            <span>{plural(countMaterials(summary), 'material')}</span>
            <span data-emphasis="">
              {summary.usedCount.toLocaleString()} used
            </span>
            {summary.appliedMaterialPaths.length > 0 ? (
              <span
                data-emphasis=""
                title={`This package's material replaces the viewer's built-in one: ${summary.appliedMaterialPaths.join(', ')}`}
              >
                {summary.appliedMaterialPaths.length.toLocaleString()} VMT applied
              </span>
            ) : summary.materialCount > 0 && (
              <span title="This package ships materials, but none of them is named for a weapon the viewer can show yet. Pick the weapon the material was authored for.">
                {plural(summary.materialCount, 'VMT')}
              </span>
            )}
            {summary.fallbackCount > 0 && (
              <span title="Recipe inputs this package does not provide, which fall back to the viewer's built-in textures">
                {summary.fallbackCount.toLocaleString()} built-in
              </span>
            )}
            {summary.nameMatchedCount > 0 && (
              <span title="This package has no materials/ directory, so these inputs were matched by file name instead of by path">
                {summary.nameMatchedCount.toLocaleString()} by name
              </span>
            )}
            {summary.ambiguousNameCount > 0 && (
              <span
                data-warn=""
                title="Several files in this package share these names, so the viewer did not guess which one to use and kept its built-in texture"
              >
                {summary.ambiguousNameCount.toLocaleString()} ambiguous
              </span>
            )}
          </span>
          <ImportPicker
            state={state}
            className="source-package-btn"
            label="Replace"
          />
          <button
            type="button"
            className="source-package-btn source-package-remove"
            data-confirm={confirmRemove ? '' : undefined}
            onClick={() =>
              confirmRemove ? onRemove() : setConfirmRemove(true)
            }
          >
            <Trash2 size={12} />
            {confirmRemove ? 'Remove it?' : 'Remove'}
          </button>
        </div>
      )}

      {status === 'mounted' && summary && (
        <div className="source-package-details">
          <span className="source-package-details-label">materials/</span>
          {summary.materialsByExtension.length === 0 ? (
            <span className="source-package-chip" data-empty="">
              no textures indexed
            </span>
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

      {visibleDiagnostics.length > 0 && (
        <ul className="source-package-diagnostics">
          {visibleDiagnostics.map((diagnostic) => (
            <li key={diagnostic.id} data-level={diagnostic.level}>
              <AlertTriangle size={11} />
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
