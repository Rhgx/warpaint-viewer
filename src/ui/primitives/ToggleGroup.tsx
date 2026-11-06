import { cva, type VariantProps } from 'class-variance-authority';
import type { ReactNode } from 'react';

import { cn } from './cn';

// The drawer's tabs, as in WorkbenchHeader. Hover stays weaker than selected, so only one tab ever reads as chosen.
const GROUP_TAB = 'gap-0.5 border-0';
const TAB = 'rounded-sm text-11 font-semibold text-dim not-last:border-r-0 not-data-pressed:hover:bg-panel-2 not-data-pressed:hover:text-text/75 data-pressed:bg-border data-pressed:text-text';

const groupVariants = cva('inline-flex overflow-hidden rounded-sm border border-border', {
  defaultVariants: { size: 'default' },
  variants: {
    size: {
      default: 'min-h-control w-full',
      sm: 'min-h-control w-full',
      compact: 'min-h-control w-full',
      icon: 'flex-none',
      inline: 'min-h-control flex-none',
      tool: `min-h-control w-full @max-[900px]:min-h-6.5 ${GROUP_TAB}`,
      tab: `min-h-6.5 flex-none ${GROUP_TAB}`,
    },
  },
});

const toggleVariants = cva(
  // Inset focus ring, as the group clips anything outside it. Unselected is always regular weight, so that it can never outweigh the selected choice.
  'flex-1 cursor-pointer border-0 border-border bg-panel font-normal text-text transition-fast focus-ring not-last:border-r hover:bg-panel-2 focus-visible:-outline-offset-2 data-pressed:bg-accent data-pressed:font-semibold data-pressed:text-accent-text',
  {
    defaultVariants: { size: 'default' },
    variants: {
      size: {
        default: 'px-2.5 py-1.25',
        sm: 'min-w-0 px-1.5 py-1 text-12',
        compact: 'min-w-0 px-2 py-1 text-11',
        icon: 'inline-flex size-6.5 flex-none items-center justify-center bg-panel-2 p-0 text-dim hover:text-text touch:size-9 [&_svg]:size-3 touch:[&_svg]:size-3.5',
        // Icon and label, only as wide as they are, beside other buttons in a header, so selected keeps the regular weight or the row would shift. It can be disabled while holding a choice, which must not read as live.
        inline: 'inline-flex flex-none items-center gap-1.25 px-2.25 text-10.5 whitespace-nowrap text-dim not-disabled:not-data-pressed:hover:text-text disabled:cursor-default disabled:opacity-45 disabled:hover:bg-panel data-pressed:font-normal disabled:data-pressed:bg-panel-2 disabled:data-pressed:text-text',
        // Switches the whole tool below it, so it stays quieter than the choices inside that tool. Narrow, it shrinks to fit a row.
        tool: `min-w-0 p-0 ${TAB} @max-[900px]:flex-none @max-[900px]:px-3`,
        tab: `flex-none px-3 ${TAB}`,
      },
    },
  },
);

/** A row of mutually exclusive buttons that sets one value. Pressing the selected option still calls onChange. `radio` exposes it as a radio group instead of pressed buttons. */
export function ToggleGroup<T extends string | number>({ label, value, options, onChange, size, radio = false }: {
  label: string;
  radio?: boolean;
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string; ariaLabel?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
} & VariantProps<typeof toggleVariants>) {
  return (
    <div className={cn(groupVariants({ size }))} data-slot="toggle-group" role={radio ? 'radiogroup' : 'group'} aria-label={label}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            className={cn(toggleVariants({ size }))}
            data-pressed={selected || undefined}
            role={radio ? 'radio' : undefined}
            aria-checked={radio ? selected : undefined}
            aria-pressed={radio ? undefined : selected}
            aria-label={option.ariaLabel}
            disabled={option.disabled}
            title={option.title}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
