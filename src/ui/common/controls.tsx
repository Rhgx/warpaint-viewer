import { Slider } from '@base-ui/react/slider';
import { Toggle } from '@base-ui/react/toggle';
import { ChevronLeft, ChevronRight, Dices, Undo2 } from 'lucide-react';
import { useId, useState } from 'react';
import type { ComponentProps, CSSProperties, KeyboardEvent, ReactNode } from 'react';

import { preloadIntent, type PreloadIntent } from '../../hooks/useIntentPreload';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { Input } from '../primitives/Input';
import { Select, SelectItem, SelectItemText, SelectPopup, SelectSearch, SelectTrigger, SelectValue } from '../primitives/Select';

export interface Option {
  value: string;
  label: string;
  /** One short line under the label in the open list; keep it unwrapped. */
  description?: string;
}

export interface IconOption extends Option {
  icon?: string | null;
}

export interface SwatchOption extends Option {
  color?: string | null; // CSS color; missing/null renders a hollow swatch
  secondaryColor?: string | null; // Optional second half, used by team-dependent colors
}

const ICON_OPTION = 'flex items-center gap-2 overflow-hidden [&>:last-child]:truncate';

function OptionSwatch({ option }: { option?: SwatchOption }) {
  const split = option?.color && option.secondaryColor;
  const style = split
    ? { background: `linear-gradient(45deg, ${option.color} 0 49%, ${option.secondaryColor} 51% 100%)` }
    : option?.color ? { backgroundColor: option.color } : undefined;
  return (
    <span
      className="size-4 flex-none rounded-full border border-strong bg-panel shadow-[inset_0_0_0_0.5px_rgb(255_255_255/12%)] data-empty:bg-transparent data-empty:shadow-none data-split:border-[color-mix(in_srgb,var(--border-strong)_70%,white_30%)]"
      data-empty={!option?.color || undefined}
      data-split={split || undefined}
      style={style}
    />
  );
}

// Small image. A missing or broken src leaves the slot empty, since manifest icons are optional.
export function AssetIcon({
  src,
  size = 24,
  loading = 'lazy',
  fetchPriority = 'auto',
}: {
  src?: string | null;
  size?: number;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
}) {
  if (!src) return <span className="flex-none" style={{ width: size, height: size }} />;
  return (
    <img
      className="flex-none object-contain"
      src={src}
      alt=""
      loading={loading}
      fetchPriority={fetchPriority}
      style={{ width: size, height: size }}
      onError={(e) => {
        // Keep the reserved slot (no layout shift) but drop the broken image.
        e.currentTarget.style.visibility = 'hidden';
      }}
    />
  );
}

export const CONTROL = 'flex flex-col gap-1.5';

export function ControlLabel({ className, ...props }: ComponentProps<'span'>) {
  return <span className={cn('inline-flex items-center gap-1 text-11 text-dim', className)} {...props} />;
}

// A labelled control row used throughout the inspector.
export function Control({ label, children, className, group = false }: { label: ReactNode; children: ReactNode; className?: string; group?: boolean }) {
  const labelId = useId();
  const Container = group ? 'div' : 'label';
  return (
    <Container className={cn(CONTROL, className)} data-slot="control" role={group ? 'group' : undefined} aria-labelledby={group ? labelId : undefined}>
      <ControlLabel id={labelId}>{label}</ControlLabel>
      {children}
    </Container>
  );
}

export function SelectField({
  value,
  onChange,
  options,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  className?: string;
}) {
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
    >
      <SelectTrigger className={className}>
        <SelectValue>
          {(v: string) => options.find((o) => o.value === v)?.label ?? 'Select'}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.description ? (
              <span className="flex min-w-0 flex-col gap-px">
                <SelectItemText>{o.label}</SelectItemText>
                <span className="text-11 whitespace-nowrap text-dim group-data-highlighted:text-inherit group-data-highlighted:opacity-80">{o.description}</span>
              </span>
            ) : <SelectItemText>{o.label}</SelectItemText>}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

// SelectField with a small icon on each option and on the closed trigger.
export function IconSelectField({
  onPreload,
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  stepLabels,
  searchPlaceholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: IconOption[];
  onPreload?: PreloadIntent;
  placeholder?: string;
  ariaLabel?: string;
  /** Adds previous/next buttons beside the trigger for stepping the list. */
  stepLabels?: { previous: string; next: string };
  /** Adds a filter box to the popup. Long lists are slow to scroll through. */
  searchPlaceholder?: string;
}) {
  const selected = options.find((o) => o.value === value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matchesQuery = (option: IconOption) => !needle || option.label.toLowerCase().includes(needle);
  const visibleCount = options.filter(matchesQuery).length;

  const stepValue = (delta: number) => {
    if (options.length === 0) return;
    const current = options.findIndex((o) => o.value === value);
    // Wrapping is the point: walk the whole list without stopping at either end.
    const next = current < 0
      ? delta < 0 ? options.length - 1 : 0
      : ((current + delta) % options.length + options.length) % options.length;
    return options[next].value;
  };

  const step = (delta: number) => {
    const next = stepValue(delta);
    if (next !== undefined) onChange(next);
  };

  const trigger = (
    <SelectTrigger className={stepLabels ? 'min-w-0 flex-1' : 'min-w-47.5'} aria-label={ariaLabel}>
      <span className={ICON_OPTION}>
        <AssetIcon src={selected?.icon} size={20} />
        <SelectValue>{() => selected?.label ?? placeholder ?? 'Select'}</SelectValue>
      </span>
    </SelectTrigger>
  );

  return (
    <Select
      value={value}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
    >
      {stepLabels ? (
        <div className="flex min-w-0 items-center gap-1">
          <Button
            size="icon"
            className="flex-none bg-panel"
            aria-label={stepLabels.previous}
            title={stepLabels.previous}
            disabled={options.length < 2}
            {...preloadIntent(`weapon:${stepValue(-1) ?? value}`, onPreload)}
            onClick={() => step(-1)}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </Button>
          {trigger}
          <Button
            size="icon"
            className="flex-none bg-panel"
            aria-label={stepLabels.next}
            title={stepLabels.next}
            disabled={options.length < 2}
            {...preloadIntent(`weapon:${stepValue(1) ?? value}`, onPreload)}
            onClick={() => step(1)}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </Button>
        </div>
      ) : trigger}
      <SelectPopup className={searchPlaceholder ? 'w-60' : undefined}>
        {searchPlaceholder ? (
          <SelectSearch placeholder={searchPlaceholder} value={query} onChange={setQuery} />
        ) : null}
        {options.map((o) => (
          <SelectItem
            key={o.value}
            value={o.value}
            {...preloadIntent(`weapon:${o.value}`, onPreload)}
            data-filtered={!matchesQuery(o) ? '' : undefined}
            aria-hidden={!matchesQuery(o) || undefined}
          >
            <span className={ICON_OPTION}>
              <AssetIcon src={o.icon} size={24} />
              <SelectItemText>{o.label}</SelectItemText>
            </span>
          </SelectItem>
        ))}
        {visibleCount === 0 ? <p className="m-0 p-2.5 text-center text-11 text-dim" role="status">No matching weapons</p> : null}
      </SelectPopup>
    </Select>
  );
}

// SelectField with a round color swatch per option. A null color renders as a hollow swatch.
export function SwatchSelectField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SwatchOption[];
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <Select
      value={value}
      onValueChange={(v) => {
        if (v !== null) onChange(v);
      }}
    >
      <SelectTrigger className="min-w-47.5">
        <span className={ICON_OPTION}>
          <OptionSwatch option={selected} />
          <SelectValue>{() => selected?.label ?? 'Select'}</SelectValue>
        </span>
      </SelectTrigger>
      <SelectPopup>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            <span className={ICON_OPTION}>
              <OptionSwatch option={o} />
              <SelectItemText>{o.label}</SelectItemText>
            </span>
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const WEAR_COLORS = ['#4a7d12', '#82b461', '#dcb259', '#bb6454', '#84453b'] as const;
const WEAR_SHORT = ['FN', 'MW', 'FT', 'WW', 'BS'] as const;
// The end columns are half width, reaching one stop to the midpoint of the next. They also take in the slider's side padding, so an end label centres on its stop and stays inside the control.
const WEAR_LABEL_EDGE = ['-ml-1.75 justify-start', 'justify-center', 'justify-center', 'justify-center', '-mr-1.75 justify-end'] as const;

export function WearSliderField({
  value,
  names,
  onChange,
}: {
  value: number;
  names: readonly string[];
  onChange: (v: number) => void;
}) {
  const selected = Math.max(0, Math.min(4, Math.round(value)));
  return (
    <div className="w-full px-1.75 pt-px" data-slot="wear-slider" style={{ '--wear-color': WEAR_COLORS[selected] } as CSSProperties}>
      <Slider.Root
        value={selected}
        onValueChange={(v) => onChange(Math.round(Array.isArray(v) ? v[0] : v))}
        min={0}
        max={4}
        step={1}
        aria-label="Weapon wear"
        aria-valuetext={names[selected] ?? WEAR_SHORT[selected]}
      >
        <Slider.Control className="flex h-5.5 cursor-pointer touch-none items-center">
          <Slider.Track className="relative h-1 w-full rounded-xs bg-border">
            {/* The fill takes the wear color of the current stop. */}
            <Slider.Indicator className="h-full rounded-xs bg-(--wear-color) [transition:width_140ms_ease,background-color_140ms_ease]" />
            {WEAR_COLORS.map((color, index) => (
              <span
                key={color}
                className="absolute top-1/2 size-2.75 -translate-1/2 rounded-full border-2 border-panel shadow-[0_0_0_1px_color-mix(in_srgb,currentColor_32%,transparent)] [transition:scale_120ms_ease,box-shadow_120ms_ease,opacity_120ms_ease] not-data-reached:opacity-55 data-selected:scale-112 data-selected:shadow-[0_0_0_2px_var(--text),0_0_0_4px_var(--panel)]"
                data-slot="wear-stop"
                data-selected={index === selected || undefined}
                data-reached={index <= selected || undefined}
                style={{ left: `${index * 25}%`, backgroundColor: color }}
              />
            ))}
            {/* The input inside the thumb takes the focus. */}
            <Slider.Thumb
              className="size-4 rounded-full border-2 border-panel bg-(--wear-color) shadow-[0_0_0_2px_var(--text)] outline-none [transition:background-color_140ms_ease] has-focus-visible:shadow-[0_0_0_2px_var(--text),0_0_0_5px_color-mix(in_srgb,var(--wear-color)_48%,transparent)]"
              aria-label="Weapon wear"
              aria-valuetext={names[selected] ?? WEAR_SHORT[selected]}
            />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <div className="mt-0.75 grid grid-cols-[1fr_2fr_2fr_2fr_1fr]">
        {WEAR_SHORT.map((label, index) => (
          <button
            type="button"
            key={label}
            className={cn('flex cursor-pointer rounded-[3px] border-0 bg-transparent px-0 py-0.5 text-9 tracking-[0.3px] text-dim tabular-nums hover:text-text focus-visible:outline focus-visible:-outline-offset-1 focus-visible:outline-accent data-selected:font-bold data-selected:text-text', WEAR_LABEL_EDGE[index])}
            data-selected={index === selected || undefined}
            title={names[index] ?? label}
            aria-label={names[index] ?? label}
            onClick={() => onChange(index)}
          >
            <span className="flex w-3.5 justify-center">{label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Inset focus ring, as the toggle clips anything outside it. Unselected matches ToggleGroup. Locked, both sides keep their team colour, greyed out.
const TEAM_BUTTON = 'flex-[1_1_0] cursor-pointer border-0 bg-panel px-3 py-1.25 font-normal tracking-[0.5px] text-text transition-fast focus-ring focus-visible:-outline-offset-2 not-disabled:not-data-pressed:hover:bg-panel-2 not-disabled:data-pressed:font-semibold not-disabled:data-pressed:text-white disabled:cursor-not-allowed disabled:font-semibold disabled:opacity-66 disabled:saturate-38';

// Finger-sized on touch-only devices.
const SEED_ACTION = 'size-5.5 touch:size-9';

/** The seed's input with its actions inside the field. Room for both actions is always kept, so that the value sits in the same place with or without undo. */
export function SeedInput({ className, randomizeLabel, onRandomize, onUndo, canUndo = false, ...props }: ComponentProps<typeof Input> & {
  randomizeLabel: string;
  onRandomize: () => void;
  onUndo?: () => void;
  canUndo?: boolean;
}) {
  return (
    <div className="relative flex items-center">
      <Input className={cn('pr-13 text-center touch:pr-19', className)} inputMode="numeric" {...props} />
      <div className="absolute right-0.75 flex gap-0.5 touch:right-0">
        <Button variant="ghost" size="icon-sm" className={SEED_ACTION} title={randomizeLabel} aria-label={randomizeLabel} onClick={onRandomize}>
          <Dices size={15} />
        </Button>
        {onUndo && (
          <Button variant="ghost" size="icon-sm" className={SEED_ACTION} title="Previous seed" aria-label="Previous seed" disabled={!canUndo} onClick={onUndo}>
            <Undo2 size={15} />
          </Button>
        )}
      </div>
    </div>
  );
}

export function TeamToggle({
  team,
  onChange,
  disabled = false,
  disabledReason,
  describedBy,
}: {
  team: 'red' | 'blu';
  onChange: (t: 'red' | 'blu') => void;
  disabled?: boolean;
  disabledReason?: string;
  /** The id of a visible note saying why it is locked. */
  describedBy?: string;
}) {
  return (
    <div
      className="inline-flex min-h-control w-full overflow-hidden rounded-sm border border-border"
      data-team={team}
      title={disabled ? disabledReason : undefined}
    >
      <Toggle
        className={cn(TEAM_BUTTON, 'border-r border-border not-disabled:data-pressed:bg-red disabled:bg-[color-mix(in_srgb,var(--red)_56%,var(--panel))]')}
        aria-label="RED team"
        pressed={disabled || team === 'red'}
        disabled={disabled}
        onPressedChange={() => onChange('red')}
        aria-describedby={describedBy}
        data-side="red"
      >
        RED
      </Toggle>
      <Toggle
        className={cn(TEAM_BUTTON, 'not-disabled:data-pressed:bg-blu disabled:bg-[color-mix(in_srgb,var(--blu)_56%,var(--panel))]')}
        aria-label="BLU team"
        pressed={disabled || team === 'blu'}
        disabled={disabled}
        onPressedChange={() => onChange('blu')}
        aria-describedby={describedBy}
        data-side="blu"
      >
        BLU
      </Toggle>
    </div>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
  onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}) {
  return (
    <Input
      value={value}
      placeholder={placeholder}
      onValueChange={(v) => onChange(v)}
      onKeyDown={onKeyDown}
    />
  );
}
