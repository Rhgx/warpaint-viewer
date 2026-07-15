import { Select } from '@base-ui/react/select';
import { Slider } from '@base-ui/react/slider';
import { NumberField } from '@base-ui/react/number-field';
import { Switch } from '@base-ui/react/switch';
import { Toggle } from '@base-ui/react/toggle';
import { Input } from '@base-ui/react/input';
import type { ReactNode } from 'react';

export interface Option {
  value: string;
  label: string;
}

// A labelled control row used throughout the controls bar.
export function Control({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="control">
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

export function SliderField({
  value,
  onChange,
  min,
  max,
  step,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <Slider.Root
      value={value}
      onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      min={min}
      max={max}
      step={step}
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

export function TeamToggle({ team, onChange }: { team: 'red' | 'blu'; onChange: (t: 'red' | 'blu') => void }) {
  return (
    <div className="ui-team-toggle" data-team={team}>
      <Toggle
        className="ui-team-btn"
        aria-label="RED team"
        pressed={team === 'red'}
        onPressedChange={() => onChange('red')}
        data-side="red"
      >
        RED
      </Toggle>
      <Toggle
        className="ui-team-btn"
        aria-label="BLU team"
        pressed={team === 'blu'}
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
