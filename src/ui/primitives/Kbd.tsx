import type { ComponentProps } from 'react';

import { cn } from './cn';

export function Kbd({ className, ...props }: ComponentProps<'kbd'>) {
  return (
    <kbd
      className={cn('inline-flex items-center justify-center rounded-[3px] border border-strong bg-panel-2 px-1.5 py-px font-[family-name:inherit] text-10 whitespace-nowrap text-dim', className)}
      data-slot="kbd"
      {...props}
    />
  );
}
