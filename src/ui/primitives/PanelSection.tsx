import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from './cn';
import { SECTION_TITLE } from './textStyles';

export function PanelSection({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('not-first:mt-1 not-first:border-t not-first:border-border not-first:pt-1', className)} data-slot="panel-section" {...props} />;
}

/** A section carries the icon, and the fields inside it stay plain text. */
export function PanelSectionHeader({ open, icon: Icon, className, children, ...props }: ComponentProps<'button'> & { open: boolean; icon: LucideIcon }) {
  return (
    <button
      type="button"
      className={cn('flex w-full cursor-pointer items-center gap-1.5 rounded-sm border-0 bg-transparent px-0.5 py-1.5 transition-fast focus-ring hover:bg-panel-2', SECTION_TITLE, className)}
      data-slot="panel-section-header"
      aria-expanded={open}
      {...props}
    >
      <Icon size={14} className="flex-none text-dim" aria-hidden="true" />
      {children}
      <ChevronDown size={14} className="ml-auto flex-none text-dim [transition:rotate_140ms_ease] data-collapsed:-rotate-90" data-collapsed={!open || undefined} />
    </button>
  );
}
