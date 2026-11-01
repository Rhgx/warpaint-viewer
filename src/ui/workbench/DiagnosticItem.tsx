import { useEffect, useRef } from 'react';
import { AlertTriangle, ChevronRight, OctagonAlert } from 'lucide-react';
import type { SourceDiagnostic, SourceDiagnosticLevel } from '../../source/contracts';
import './DiagnosticItem.css';

const LEVEL_ICON = {
  error: OctagonAlert,
  warning: AlertTriangle,
} as const satisfies Record<Exclude<SourceDiagnosticLevel, 'info'>, unknown>;

/* Screen-reader text only: sighted users see octagon and triangle icons instead. */
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
    <li className="diagnostic" data-level={diagnostic.level}>
      <Icon className="diagnostic-icon" size={14} aria-hidden="true" />
      <p className="diagnostic-message">
        <span className="diagnostic-sr">{LEVEL_LABEL[diagnostic.level]}: </span>
        {diagnostic.message}
      </p>
      {(diagnostic.code || diagnostic.detail || diagnostic.location) && (
        <div className="diagnostic-meta">
          {diagnostic.code && (
            <span className="diagnostic-code">{diagnostic.code}</span>
          )}
          {diagnostic.detail && (
            <span className="diagnostic-source" title={diagnostic.detail}>
              {diagnostic.detail}
            </span>
          )}
          {diagnostic.location && (
            <span className="diagnostic-location">
              Line {diagnostic.location.line}, column {diagnostic.location.column}
            </span>
          )}
        </div>
      )}
      {diagnostic.technicalDetail && (
        <details className="diagnostic-technical">
          <summary>
            <ChevronRight size={11} aria-hidden="true" />
            Technical details
          </summary>
          <pre>{diagnostic.technicalDetail}</pre>
        </details>
      )}
    </li>
  );
}

/** Shared visible diagnostics for import panels. */
export function DiagnosticsList({
  diagnostics,
}: {
  diagnostics: SourceDiagnostic[];
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
    <ul className="diagnostics" ref={listRef} aria-live="polite">
      {problems.map((diagnostic) => (
        <DiagnosticItem key={diagnostic.id} diagnostic={diagnostic} />
      ))}
    </ul>
  );
}
