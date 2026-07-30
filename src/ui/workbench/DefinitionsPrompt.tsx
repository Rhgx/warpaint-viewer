import { PackageSearch, X } from 'lucide-react';
import './DefinitionsPrompt.css';

/**
 * Asks whether the definitions found inside the mounted package should be
 * imported as well. Shown once per package: importing or dismissing answers
 * the question, and the Definitions tab keeps the same offer available after.
 */
export function DefinitionsPrompt({
  path,
  onImport,
  onDismiss,
}: {
  /** Package-relative path(s) the definitions were found at. */
  path: string;
  onImport: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="definitions-prompt" role="status">
      <PackageSearch size={15} />
      <div className="definitions-prompt-text">
        <strong>Import this package's war paint definitions too?</strong>
        <span className="definitions-prompt-path" title={path}>
          {path}
        </span>
      </div>
      <div className="definitions-prompt-actions">
        <button
          type="button"
          className="definitions-prompt-import"
          onClick={onImport}
        >
          Import
        </button>
        <button
          type="button"
          className="definitions-prompt-dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
