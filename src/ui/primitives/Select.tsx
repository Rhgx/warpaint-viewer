import { Input as InputPrimitive } from '@base-ui/react/input';
import { Select as SelectPrimitive } from '@base-ui/react/select';
import { Check, ChevronDown, Search } from 'lucide-react';

import { cn } from './cn';

export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;
export const SelectItemText = SelectPrimitive.ItemText;

export function SelectTrigger({ className, children, ...props }: SelectPrimitive.Trigger.Props) {
  return (
    <SelectPrimitive.Trigger
      className={cn('inline-flex min-h-control w-full min-w-37.5 cursor-pointer items-center justify-between gap-2 rounded-sm border border-border bg-panel px-2 py-1.25 transition-fast focus-ring not-disabled:hover:border-strong disabled:cursor-default disabled:opacity-45', className)}
      data-slot="select-trigger"
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex text-10 text-dim"><ChevronDown size={12} aria-hidden="true" /></SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectPopup({ className, ...props }: SelectPrimitive.Popup.Props) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner className="z-1100" data-slot="select-positioner" align="start" sideOffset={4} alignItemWithTrigger={false}>
        <SelectPrimitive.Popup
          className={cn('scrollbar-slim max-h-80 w-max min-w-(--anchor-width) max-w-(--available-width) overflow-auto rounded-md border border-strong bg-panel p-1 shadow-pop', className)}
          data-slot="select-popup"
          {...props}
        />
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      // group: a description inside an item follows the item's highlight.
      className={cn('group flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.25 outline-none transition-fast select-none data-filtered:hidden data-highlighted:bg-accent data-highlighted:text-accent-text touch:min-h-10', className)}
      data-slot="select-item"
      {...props}
    >
      {children}
      <SelectPrimitive.ItemIndicator className="flex text-11"><Check size={12} aria-hidden="true" /></SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectSearch({ placeholder, value, onChange }: {
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="sticky -top-1 z-1 -mx-1 -mt-1 mb-1 flex items-center gap-1.5 border-b border-border bg-panel px-2.5 py-2 text-dim" data-slot="select-search">
      <Search size={13} aria-hidden="true" />
      <InputPrimitive
        autoFocus
        className="w-full min-w-0 border-0 bg-transparent [font-family:inherit] text-11 text-text outline-none touch:text-16"
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          // Escape is left to the Select so it can close the popup; text entry stays out of its typeahead.
          if (event.key !== 'Escape') event.stopPropagation();
        }}
      />
    </label>
  );
}
