import { Slider as SliderPrimitive } from '@base-ui/react/slider';

export function Slider({ value, onChange, onCommit, min, max, step, ariaLabel, markers, disabled }: {
  value: number;
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  min: number;
  max: number;
  step: number;
  ariaLabel?: string;
  markers?: readonly number[];
  disabled?: boolean;
}) {
  return (
    <SliderPrimitive.Root
      value={value}
      onValueChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
      onValueCommitted={onCommit ? (next) => onCommit(Array.isArray(next) ? next[0] : next) : undefined}
      min={min}
      max={max}
      step={step}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      <SliderPrimitive.Control className="flex h-4.5 w-full items-center data-disabled:opacity-45" data-slot="slider-control">
        <SliderPrimitive.Track className="relative h-1 w-full rounded-xs bg-border">
          <SliderPrimitive.Indicator className="absolute h-full rounded-xs bg-accent data-disabled:bg-strong" />
          {markers?.map((marker) => (
            <span key={marker} className="pointer-events-none absolute -top-0.5 h-2 w-px -translate-x-1/2 bg-dim" aria-hidden="true"
              style={{ left: `${(marker - min) / (max - min) * 100}%` }} title={`${marker}°`} />
          ))}
          {/* The input inside the thumb takes the focus. On touch the ::before is a finger-sized grab. */}
          <SliderPrimitive.Thumb className="z-1 size-3.25 data-disabled:hidden rounded-full border border-strong bg-panel outline-accent hover:border-accent has-focus-visible:outline-2 has-focus-visible:outline-offset-2 touch:before:absolute touch:before:-inset-[10.5px]" aria-label={ariaLabel} />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
