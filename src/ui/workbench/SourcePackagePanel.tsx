import {
  LoaderCircle,
  PackageOpen,
  Trash2,
  Upload,
} from 'lucide-react';
import { useArmedConfirm } from '../../hooks/useArmedConfirm';
import { Button, FileButton } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { InlineNotice } from '../primitives/Notice';
import { PATH_TEXT } from '../primitives/textStyles';
import { DiagnosticsList } from './DiagnosticItem';
import type {
  SourcePackageFormat,
  SourcePackageState,
  SourcePackageSummary,
} from '../../source/contracts';

const SOURCE_PACKAGE_ACCEPT = '.zip,.vpk';

const PACKAGE_NAME = 'min-w-0 truncate text-11 font-[650] text-text';
const CHIP = cn('flex items-center gap-1 rounded-sm bg-panel-2 px-1.5 py-px', PATH_TEXT);

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
  label,
}: {
  state: SourcePackageState;
  label: string;
}) {
  return (
    <FileButton
      variant="primary"
      label="Import a Source asset package"
      accept={SOURCE_PACKAGE_ACCEPT}
      // Multipart VPKs need the _dir.vpk and every numbered segment together.
      multiple
      busy={state.status === 'importing'}
      onFiles={state.onImport}
    >
      <Upload size={12} />
      <span>{label}</span>
    </FileButton>
  );
}

/** Package tab content for every state; import diagnostics show in all of them, since a failed import may mount nothing. */
export function SourcePackagePanel({ state }: { state: SourcePackageState }) {
  const { status, summary, diagnostics, onRemove } = state;
  const [confirmRemove, armRemove] = useArmedConfirm();
  const hasProblems = diagnostics.some((diagnostic) => diagnostic.level !== 'info');

  return (
    <div
      className="scrollbar-slim flex min-h-0 flex-1 flex-col overflow-auto px-3 py-2.5 text-11 text-dim"
      data-slot="source-package"
      data-status={status}
    >
      {status === 'empty' && (
        // A failed import takes priority over the pitch, so the pitch shrinks to leave room for its diagnostics.
        <div className={cn('mx-auto flex max-w-80 flex-[1_0_auto] flex-col items-center justify-center gap-2.5 px-4 py-5 text-center text-11 leading-normal', hasProblems && 'flex-none gap-1.75 pt-1.5 pb-0.5')}>
          <PackageOpen className="opacity-80" size={22} />
          <span>
            An archive supplies the textures a recipe asks for, in place of the
            viewer's built-ins.
          </span>
          <ImportPicker state={state} label="Mount an archive" />
        </div>
      )}

      {status === 'importing' && (
        <div className="flex min-h-6.25 items-center gap-1.75">
          <LoaderCircle className="animate-spin motion-reduce:animate-none" size={13} />
          <span className={PACKAGE_NAME}>
            Reading {summary?.name ?? 'package'}...
          </span>
        </div>
      )}

      {status === 'mounted' && summary && (
        <div className="flex min-h-6.25 items-center gap-1.75">
          <span className="flex-none rounded-[3px] bg-accent px-1.25 py-0.5 text-10 font-bold tracking-[0.5px] text-accent-text" data-format={summary.format}>
            {FORMAT_LABEL[summary.format]}
          </span>
          <span className={PACKAGE_NAME} title={summary.name}>
            {summary.name}
          </span>
          {/* Separator dots, not badges, so the counts read as one sentence about the package. */}
          <span className="flex min-w-0 flex-auto items-center gap-1.25 overflow-hidden whitespace-nowrap tabular-nums [&>[data-emphasis]]:font-semibold [&>[data-emphasis]]:text-text [&>span+span]:before:mr-1.25 [&>span+span]:before:opacity-55 [&>span+span]:before:content-['·']">
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
              <InlineNotice title="Several files in this package share these names, so the viewer did not guess which one to use and kept its built-in texture">
                {summary.ambiguousNameCount.toLocaleString()} ambiguous
              </InlineNotice>
            )}
          </span>
          <ImportPicker state={state} label="Replace" />
          <Button
            variant={confirmRemove ? 'armed' : 'outline'}
            size="compact"
            data-slot="package-remove"
            onClick={() =>
              confirmRemove ? onRemove() : armRemove()
            }
          >
            <Trash2 size={12} />
            {confirmRemove ? 'Remove it?' : 'Remove'}
          </Button>
        </div>
      )}

      {status === 'mounted' && summary && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t border-border/70 pt-1.5">
          <span className={cn('mr-0.5', PATH_TEXT)}>materials/</span>
          {summary.materialsByExtension.length === 0 ? (
            <span className={cn(CHIP, 'italic opacity-70')}>
              no textures indexed
            </span>
          ) : (
            summary.materialsByExtension.map((entry) => (
              <span className={CHIP} key={entry.extension}>
                .{entry.extension}
                <span className="text-text tabular-nums">{entry.count.toLocaleString()}</span>
              </span>
            ))
          )}
        </div>
      )}

      <DiagnosticsList className="flex-none" diagnostics={diagnostics} />
    </div>
  );
}
