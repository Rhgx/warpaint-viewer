import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn';

const buttonVariants = cva(
  'inline-flex cursor-pointer items-center justify-center rounded-sm border transition-fast focus-ring disabled:cursor-default disabled:opacity-45',
  {
    defaultVariants: { size: 'default', variant: 'default' },
    variants: {
      size: {
        default: 'h-control min-w-control gap-1.25 px-2 text-12',
        sm: 'min-h-6 min-w-control gap-1.25 px-1.5 text-11',
        // The workbench panels' one button size. Grows with the control token on touch.
        compact: 'min-h-control flex-none gap-1 px-2.25 text-11',
        // A dialog or toast action. Disabled here means it is working, not that it is unavailable.
        lg: 'min-h-8 gap-1.5 px-3 py-1.5 text-12 font-semibold disabled:cursor-wait disabled:opacity-62',
        icon: 'h-control w-control min-w-control p-0',
        'icon-sm': 'size-6 p-0',
        'icon-md': 'size-7 p-0',
        'icon-lg': 'size-8 p-0',
        // A small status control in a header row.
        chip: 'min-w-0 gap-1.25 px-2.25 py-1 text-10 whitespace-nowrap',
        // Sits in a line of text, so it takes that text's size and line height.
        inline: 'px-1.5 py-1 leading-[inherit]',
      },
      variant: {
        default: 'border-border bg-panel-2 text-dim not-disabled:hover:border-strong not-disabled:hover:text-text data-popup-open:border-strong data-popup-open:text-text',
        secondary: 'border-strong bg-panel-2 text-text not-disabled:hover:bg-panel',
        // A secondary action sitting on a raised surface, where bg-panel-2 would not stand out.
        outline: 'border-strong bg-panel text-text not-disabled:hover:bg-panel-2',
        // A destructive action waiting for its second click. Hovering must not make it read as disarmed.
        armed: 'border-fail-edge bg-fail-soft font-semibold text-fail-text',
        primary: 'border-accent bg-accent font-semibold text-accent-text not-disabled:hover:brightness-110',
        // Holds a choice on or off, drawn like the toolbar's pressed state. Hovering a pressed button must not make it read as unpressed.
        toggle: 'border-border bg-panel-2 text-text not-disabled:hover:border-strong aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-text not-disabled:aria-pressed:hover:border-accent not-disabled:aria-pressed:hover:brightness-110 disabled:aria-pressed:border-border disabled:aria-pressed:bg-panel-2 disabled:aria-pressed:text-text',
        accent: 'border-accent bg-panel-2 text-accent not-disabled:hover:border-strong not-disabled:hover:text-text',
        danger: 'border-border bg-panel-2 text-dim not-disabled:hover:border-fail not-disabled:hover:text-fail',
        destructive: 'border-fail bg-fail font-semibold text-white not-disabled:hover:brightness-90',
        ghost: 'border-0 bg-transparent text-dim not-disabled:hover:bg-panel-2 not-disabled:hover:text-text',
        // Hovering a pressed button must not make it read as unpressed.
        toolbar: 'border-0 bg-transparent text-dim not-disabled:not-aria-pressed:hover:bg-panel-2 not-disabled:not-aria-pressed:hover:text-text aria-expanded:bg-panel-2 aria-expanded:text-text aria-pressed:bg-accent aria-pressed:text-accent-text not-disabled:aria-pressed:hover:brightness-110 data-[feedback=error]:text-fail data-[feedback=success]:text-pass',
        link: 'border-0 bg-transparent font-semibold text-accent not-disabled:hover:underline',
        // Reads as loaded when it holds something. Selected, it is drawn as a selected tab, as it opens a panel just as a tab does.
        chip: 'border-border bg-transparent text-dim not-aria-pressed:hover:border-strong not-aria-pressed:hover:text-text/75 not-aria-pressed:data-loaded:border-accent-edge not-aria-pressed:data-loaded:bg-accent-soft not-aria-pressed:data-loaded:text-text aria-pressed:border-transparent aria-pressed:bg-panel-2 aria-pressed:text-text',
      },
    },
  },
);

type ButtonProps = useRender.ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, render, ...props }: ButtonProps) {
  const defaultProps = {
    className: cn(buttonVariants({ variant, size }), className),
    'data-slot': 'button',
    type: render ? undefined : ('button' as const),
  };
  return useRender({
    defaultTagName: 'button',
    render,
    props: mergeProps<'button'>(defaultProps, props),
  });
}

/** A button that opens a file picker. The input stays focusable, so the label draws its focus ring. Picking nothing calls nothing. */
export function FileButton({ label, accept, multiple, busy, onFiles, className, children, ...props }: Omit<ButtonProps, 'render' | 'onChange'> & {
  label: string;
  accept: string;
  multiple?: boolean;
  busy?: boolean;
  onFiles: (files: File[]) => void;
}) {
  return (
    <Button
      size="compact"
      render={<label />}
      className={cn('has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent data-busy:cursor-progress data-busy:opacity-60', className)}
      data-busy={busy || undefined}
      {...props}
    >
      {children}
      <input
        type="file"
        className="sr-only"
        accept={accept}
        multiple={multiple}
        disabled={busy}
        aria-label={label}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </Button>
  );
}
