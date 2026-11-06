import { AlertCircle, AlertTriangle } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from './cn';

type NoticeTone = 'warning' | 'error';

const ICON = { warning: AlertTriangle, error: AlertCircle } as const;
const TONE_COLOUR = { warning: 'text-warn', error: 'text-fail' } as const;
const BLOCK_TONE = {
  warning: 'border-[color-mix(in_srgb,var(--warn)_55%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_10%,var(--panel))]',
  error: 'border-[color-mix(in_srgb,var(--fail)_55%,var(--border))] bg-[color-mix(in_srgb,var(--fail)_10%,var(--panel))]',
} as const;

/** A warning or error beside other content: an icon and text in the tone's own colour, with no box. */
export function InlineNotice({ tone = 'warning', className, children, ...props }: ComponentProps<'span'> & { tone?: NoticeTone }) {
  const Icon = ICON[tone];
  return (
    <span className={cn('inline-flex min-w-0 items-start gap-1 text-11 leading-[1.4]', TONE_COLOUR[tone], className)} data-slot="inline-notice" data-tone={tone} {...props}>
      <Icon className="mt-0.5 flex-none" size={12} aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** A warning or error that stands alone: a bordered callout. */
export function BlockNotice({ tone = 'warning', className, children, ...props }: ComponentProps<'div'> & { tone?: NoticeTone }) {
  const Icon = ICON[tone];
  return (
    <div className={cn('flex items-start gap-1.75 rounded-md border px-2.5 py-2 text-11.5 leading-[1.4] text-text', BLOCK_TONE[tone], className)} data-slot="block-notice" data-tone={tone} {...props}>
      <Icon className={cn('mt-px flex-none', TONE_COLOUR[tone])} size={14} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
