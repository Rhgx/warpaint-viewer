import { Select } from '@base-ui/react/select';
import { Slider } from '@base-ui/react/slider';
import { NumberField } from '@base-ui/react/number-field';
import { Switch } from '@base-ui/react/switch';
import { Toggle } from '@base-ui/react/toggle';
import { Input } from '@base-ui/react/input';
import type { CSSProperties, ReactNode } from 'react';

export interface Option {
  value: string;
  label: string;
}

export interface IconOption extends Option {
  icon?: string | null;
}

export interface SwatchOption extends Option {
  color?: string | null; // CSS color; missing/null renders a hollow swatch
}

// Small image with a graceful text-only fallback: manifest icons are not
// guaranteed (mock mode has none, a couple of collections have none), so a
// broken/missing src just collapses to an empty slot instead of a broken icon.
export function AssetIcon({
  src,
  size = 24,
  className,
  loading = 'lazy',
  fetchPriority = 'auto',
}: {
  src?: string | null;
  size?: number;
  className?: string;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
}) {
  if (!src) return <span className={`asset-icon-empty${className ? ` ${className}` : ''}`} style={{ width: size, height: size }} />;
  return (
    <img
      className={`asset-icon${className ? ` ${className}` : ''}`}
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

// A labelled control row used throughout the inspector panel. `label` accepts
// a leading icon plus text (see Inspector) as well as a plain string.
export function Control({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`control${className ? ` ${className}` : ''}`}>
      <span className="control-label">{label}</span>
      {children}
    </label>
  );
}

export function SelectField({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
}) {
  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as string)}>
      <Select.Trigger className="ui-select-trigger">
        <Select.Value>
          {(v: string) => options.find((o) => o.value === v)?.label ?? placeholder ?? 'Select'}
        </Select.Value>
        <Select.Icon className="ui-select-icon">v</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="ui-select-positioner" sideOffset={4} alignItemWithTrigger={false}>
          <Select.Popup className="ui-select-popup">
            {options.map((o) => (
              <Select.Item key={o.value} value={o.value} className="ui-select-item">
                <Select.ItemText>{o.label}</Select.ItemText>
                <Select.ItemIndicator className="ui-select-indicator">*</Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

// Same as SelectField, but each option (and the closed trigger) can show a
// small icon, e.g. a weapon's backpack icon.
export function IconSelectField({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: IconOption[];
  placeholder?: string;
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as string)}>
      <Select.Trigger className="ui-select-trigger ui-select-trigger-icon">
        <span className="ui-icon-option">
          <AssetIcon src={selected?.icon} size={20} />
          <Select.Value>{() => selected?.label ?? placeholder ?? 'Select'}</Select.Value>
        </span>
        <Select.Icon className="ui-select-icon">v</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="ui-select-positioner" sideOffset={4} alignItemWithTrigger={false}>
          <Select.Popup className="ui-select-popup">
            {options.map((o) => (
              <Select.Item key={o.value} value={o.value} className="ui-select-item">
                <span className="ui-icon-option">
                  <AssetIcon src={o.icon} size={24} />
                  <Select.ItemText>{o.label}</Select.ItemText>
                </span>
                <Select.ItemIndicator className="ui-select-indicator">*</Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

// Same as SelectField, but each option (and the closed trigger) shows a
// small round color swatch, e.g. a killstreak sheen tint. A missing/null
// color (e.g. the 'none' option) renders as a hollow swatch.
export function SwatchSelectField({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: SwatchOption[];
  placeholder?: string;
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <Select.Root value={value} onValueChange={(v) => onChange(v as string)}>
      <Select.Trigger className="ui-select-trigger ui-select-trigger-icon">
        <span className="ui-icon-option">
          <span className="ui-swatch" data-empty={!selected?.color || undefined} style={selected?.color ? { backgroundColor: selected.color } : undefined} />
          <Select.Value>{() => selected?.label ?? placeholder ?? 'Select'}</Select.Value>
        </span>
        <Select.Icon className="ui-select-icon">v</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner className="ui-select-positioner" sideOffset={4} alignItemWithTrigger={false}>
          <Select.Popup className="ui-select-popup">
            {options.map((o) => (
              <Select.Item key={o.value} value={o.value} className="ui-select-item">
                <span className="ui-icon-option">
                  <span className="ui-swatch" data-empty={!o.color || undefined} style={o.color ? { backgroundColor: o.color } : undefined} />
                  <Select.ItemText>{o.label}</Select.ItemText>
                </span>
                <Select.ItemIndicator className="ui-select-indicator">*</Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

export function SliderField({
  value,
  onChange,
  min,
  max,
  step,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel?: string;
}) {
  return (
    <Slider.Root
      value={value}
      onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
    >
      <Slider.Control className="ui-slider-control">
        <Slider.Track className="ui-slider-track">
          <Slider.Indicator className="ui-slider-indicator" />
          <Slider.Thumb className="ui-slider-thumb" />
        </Slider.Track>
      </Slider.Control>
    </Slider.Root>
  );
}

const WEAR_COLORS = ['#4a7d12', '#82b461', '#dcb259', '#bb6454', '#84453b'] as const;
const WEAR_SHORT = ['FN', 'MW', 'FT', 'WW', 'BS'] as const;

export function WearSliderField({
  value,
  names,
  onChange,
}: {
  value: number;
  names: string[];
  onChange: (v: number) => void;
}) {
  const selected = Math.max(0, Math.min(4, Math.round(value)));
  return (
    <div className="wear-slider" style={{ '--wear-color': WEAR_COLORS[selected] } as CSSProperties}>
      <Slider.Root
        value={selected}
        onValueChange={(v) => onChange(Math.round(Array.isArray(v) ? v[0] : v))}
        min={0}
        max={4}
        step={1}
        aria-label="Weapon wear"
        aria-valuetext={names[selected] ?? WEAR_SHORT[selected]}
      >
        <Slider.Control className="wear-slider-control">
          <Slider.Track className="wear-slider-track">
            <Slider.Indicator className="wear-slider-fill" />
            {WEAR_COLORS.map((color, index) => (
              <span
                key={color}
                className="wear-slider-stop"
                data-selected={index === selected || undefined}
                data-reached={index <= selected || undefined}
                style={{ left: `${index * 25}%`, backgroundColor: color }}
              />
            ))}
            <Slider.Thumb className="wear-slider-thumb" />
          </Slider.Track>
        </Slider.Control>
      </Slider.Root>
      <div className="wear-slider-labels">
        {WEAR_SHORT.map((label, index) => (
          <button
            type="button"
            key={label}
            data-selected={index === selected || undefined}
            title={names[index] ?? label}
            aria-label={names[index] ?? label}
            onClick={() => onChange(index)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function NumberFieldControl({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <NumberField.Root
      value={value}
      onValueChange={(v) => onChange(v ?? 0)}
      min={min}
      max={max}
      step={step ?? 1}
      // Plain integer digits, no locale grouping/decimal separators (a seed is
      // an id, not a quantity).
      format={{ useGrouping: false, maximumFractionDigits: 0 }}
      locale="en-US"
    >
      <NumberField.Group className="ui-numfield">
        <NumberField.Decrement className="ui-num-btn">-</NumberField.Decrement>
        <NumberField.Input className="ui-num-input" />
        <NumberField.Increment className="ui-num-btn">+</NumberField.Increment>
      </NumberField.Group>
    </NumberField.Root>
  );
}

export function TeamToggle({
  team,
  onChange,
  disabled = false,
}: {
  team: 'red' | 'blu';
  onChange: (t: 'red' | 'blu') => void;
  disabled?: boolean;
}) {
  return (
    <div className="ui-team-toggle" data-team={team} data-fixed={disabled || undefined}>
      <Toggle
        className="ui-team-btn"
        aria-label="RED team"
        pressed={disabled || team === 'red'}
        disabled={disabled}
        onPressedChange={() => onChange('red')}
        data-side="red"
      >
        RED
      </Toggle>
      <Toggle
        className="ui-team-btn"
        aria-label="BLU team"
        pressed={disabled || team === 'blu'}
        disabled={disabled}
        onPressedChange={() => onChange('blu')}
        data-side="blu"
      >
        BLU
      </Toggle>
    </div>
  );
}

export function SwitchField({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch.Root className="ui-switch" checked={checked} onCheckedChange={onChange}>
      <Switch.Thumb className="ui-switch-thumb" />
    </Switch.Root>
  );
}

export function TextField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <Input
      className="ui-input"
      value={value}
      placeholder={placeholder}
      onValueChange={(v) => onChange(v)}
    />
  );
}
