import { PackageSearch, X } from 'lucide-react';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { PATH_TEXT } from '../primitives/textStyles';

/** Offers the definitions found in a mounted package, once per package; the Definitions tab keeps the offer after. */
export function DefinitionsPrompt({
  path,
  onImport,
  onDismiss,
}: {
  /** Package-relative path the definitions were found at. */
  path: string;
  onImport: () => void;
  onDismiss: () => void;
}) {
  return (
    // Bottom-center over the stage: the Definitions tab sits behind a usually closed drawer, so this is the only on-screen offer.
    <div
      className="absolute bottom-2.5 left-1/2 z-3 flex max-w-[min(480px,calc(100%-20px))] -translate-x-1/2 animate-definitions-prompt items-center gap-2.5 rounded-lg border border-accent-edge bg-panel/92 py-2 pr-2 pl-3 shadow-pop backdrop-blur-[8px] motion-reduce:animate-none"
      data-slot="definitions-prompt"
      role="status"
    >
      <PackageSearch className="flex-none text-accent" size={15} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <strong className="text-11 font-[650] text-text">Import this package's war paint definitions too?</strong>
        <span className={cn('truncate text-dim', PATH_TEXT)} title={path}>
          {path}
        </span>
      </div>
      <div className="ml-auto flex flex-none items-center gap-1">
        <Button variant="primary" size="compact" onClick={onImport}>
          Import
        </Button>
        <Button variant="ghost" size="icon" aria-label="Dismiss" onClick={onDismiss}>
          <X size={13} />
        </Button>
      </div>
    </div>
  );
}
