import type { ComponentProps, ReactNode } from 'react';

import { cn } from './cn';

/** A panel with nothing to show, centred in whatever room it has. */
export function EmptyState({ icon, title, className, children, ...props }: Omit<ComponentProps<'div'>, 'title'> & {
  icon: ReactNode;
  title: ReactNode;
}) {
  return (
    <div className={cn('mx-auto flex max-w-85 flex-[1_0_auto] flex-col items-center justify-center gap-2.5 px-4 py-5 text-center text-dim [&>svg]:opacity-80', className)} data-slot="empty-state" {...props}>
      {icon}
      <strong className="text-12 text-text">{title}</strong>
      {children}
    </div>
  );
}
