import { Input as InputPrimitive } from '@base-ui/react/input';
import { Search, X } from 'lucide-react';
import type { ComponentProps } from 'react';

import { Button } from './Button';
import { cn } from './cn';

/** Touch gets 16px text, so that iOS does not zoom on focus. */
export function Input({ className, ...props }: ComponentProps<typeof InputPrimitive>) {
  return (
    <InputPrimitive
      className={cn('min-h-control w-full rounded-sm border border-border bg-panel px-2 py-1.25 text-inherit outline-none transition-fast focus-ring hover:border-strong touch:text-16', className)}
      data-slot="input"
      {...props}
    />
  );
}

/** Goes on a container: the text size of inputs in the workbench panels' forms. Touch stays at 16px, as on Input. */
export const COMPACT_INPUTS = '[&_input]:text-11 touch:[&_input]:text-16';

/** A filter box: Escape or the clear button empties it. */
export function SearchField({ value, onChange, placeholder, label, disabled, className, ...props }: Omit<ComponentProps<'div'>, 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div className={cn('relative flex items-center', className)} data-slot="search-field" {...props}>
      <Search className="pointer-events-none absolute left-2 text-dim" size={14} />
      <Input
        className="pr-6 pl-6.5 touch:pr-9.5"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        onValueChange={(next) => onChange(next)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) onChange('');
        }}
      />
      {value.length > 0 && (
        <Button variant="ghost" size="icon-sm" className="absolute right-1.5 size-4.5 touch:right-0 touch:size-9" title="Clear search" aria-label="Clear search" onClick={() => onChange('')}>
          <X size={13} />
        </Button>
      )}
    </div>
  );
}
