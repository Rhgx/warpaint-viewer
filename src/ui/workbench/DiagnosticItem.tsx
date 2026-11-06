import { useEffect, useRef } from 'react';
import { AlertCircle, AlertTriangle, ChevronRight } from 'lucide-react';
import type { SourceDiagnostic, SourceDiagnosticLevel } from '../../source/contracts';
import { cn } from '../primitives/cn';
import { PATH_TEXT } from '../primitives/textStyles';

const LEVEL_ICON = {
  error: AlertCircle,
  warning: AlertTriangle,
} as const satisfies Record<Exclude<SourceDiagnosticLevel, 'info'>, unknown>;

/* Screen-reader text only: sighted users see circle and triangle icons instead. */
const LEVEL_LABEL = {
  error: 'Error',
  warning: 'Warning',
} as const satisfies Record<Exclude<SourceDiagnosticLevel, 'info'>, string>;

/** A diagnostic the list renders; informational entries are filtered out before rendering. */
type ProblemDiagnostic = SourceDiagnostic & { level: Exclude<SourceDiagnosticLevel, 'info'> };

/** Shared rendering contract for user, support, and developer error layers. */
function DiagnosticItem({ diagnostic }: { diagnostic: ProblemDiagnostic }) {
  const Icon = LEVEL_ICON[diagnostic.level];

  return (
    <li
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-1.75 gap-y-0.75 rounded-sm border border-[color-mix(in_srgb,var(--tone)_38%,var(--border))] bg-[color-mix(in_srgb,var(--tone)_9%,var(--panel))] pt-1.75 pr-2 pb-2 pl-2.25 text-11 leading-[1.45] text-text [--tone:var(--warn)] data-[level=error]:[--tone:var(--fail)]"
      data-slot="diagnostic"
      data-level={diagnostic.level}
    >
      <Icon className="col-start-1 mt-px text-(color:--tone)" size={14} aria-hidden="true" />
      <p className="col-start-2 m-0 font-semibold wrap-anywhere">
        <span className="sr-only">{LEVEL_LABEL[diagnostic.level]}: </span>
        {diagnostic.message}
      </p>
      {(diagnostic.code || diagnostic.detail || diagnostic.location) && (
        <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-1.25">
          {diagnostic.code && (
            <span className="flex-none rounded-sm bg-[color-mix(in_srgb,var(--tone)_16%,transparent)] px-1.25 font-mono text-9.5 font-bold tracking-[0.3px] whitespace-nowrap text-[color-mix(in_srgb,var(--tone)_80%,var(--text))]">{diagnostic.code}</span>
          )}
          {diagnostic.detail && (
            <span className={cn('min-w-0 truncate text-dim', PATH_TEXT)} title={diagnostic.detail}>
              {diagnostic.detail}
            </span>
          )}
          {diagnostic.location && (
            <span className={cn('flex-none whitespace-nowrap text-dim', PATH_TEXT)}>
              Line {diagnostic.location.line}, column {diagnostic.location.column}
            </span>
          )}
        </div>
      )}
      {diagnostic.technicalDetail && (
        <details className="group col-start-2 mt-px" data-slot="diagnostic-technical">
          <summary className="inline-flex w-fit cursor-pointer list-none items-center gap-0.75 rounded-sm py-px pr-1.5 pl-0.75 text-10 font-semibold text-dim focus-ring hover:bg-panel-2 hover:text-text [&::-webkit-details-marker]:hidden">
            <ChevronRight className="flex-none transition-transform duration-[140ms] group-open:rotate-90 motion-reduce:transition-none" size={11} aria-hidden="true" />
            Technical details
          </summary>
          <pre className={cn('scrollbar-slim mx-0 mt-1 mb-0 max-h-40 overflow-auto rounded-sm border border-border bg-panel-2 px-2 py-1.5 leading-normal wrap-anywhere whitespace-pre-wrap text-dim', PATH_TEXT)}>{diagnostic.technicalDetail}</pre>
        </details>
      )}
    </li>
  );
}

/** Shared visible diagnostics for import panels. The caller supplies the gutter and any height limit. */
export function DiagnosticsList({
  diagnostics,
  className,
}: {
  diagnostics: SourceDiagnostic[];
  className?: string;
}) {
  const problems = diagnostics.filter(
    (diagnostic): diagnostic is ProblemDiagnostic => diagnostic.level !== 'info',
  );
  const listRef = useRef<HTMLUListElement>(null);
  const newestId = problems.at(-1)?.id;

  useEffect(() => {
    if (!newestId) return;
    listRef.current?.scrollIntoView({ block: 'nearest' });
  }, [newestId]);

  return (
    <ul className={cn('m-0 flex list-none flex-col gap-1.5 p-0 not-empty:mt-2', className)} data-slot="diagnostics" ref={listRef} aria-live="polite">
      {problems.map((diagnostic) => (
        <DiagnosticItem key={diagnostic.id} diagnostic={diagnostic} />
      ))}
    </ul>
  );
}
