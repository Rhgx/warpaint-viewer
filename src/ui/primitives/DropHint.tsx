import type { ComponentProps } from 'react';

import { cn } from './cn';

/** Dims what is under a dragged file and says what dropping it will do. The caller positions it. */
export function DropHint({ className, children, ...props }: ComponentProps<'div'>) {
  return (
    <div className={cn('pointer-events-none grid bg-bg/85 p-1', className)} {...props}>
      <div className="grid place-items-center rounded-md border-2 border-dashed border-accent">
        <span className="rounded-sm border border-border bg-panel px-3 py-2 text-14 font-semibold text-text">{children}</span>
      </div>
    </div>
  );
}
