import { useState } from 'react';
import type { ReactNode } from 'react';
import { CircleDot, Lightbulb, Sun } from 'lucide-react';
import { ControlLabel } from '../common/controls';
import { cn } from '../primitives/cn';
import { Input } from '../primitives/Input';
import { Slider } from '../primitives/Slider';
import type { CustomLightType, FrameVector } from '../../viewer/lighting/customLighting';
import { AXES, TYPE_LABELS, clampScalar, formatScalar } from './lightingRig';

/** One glyph per light type, shown with its word. The glyph alone serves as the badge when space is tight. */
export function LightIcon({ type, size = 12 }: { type: CustomLightType; size?: number }) {
  if (type === 'directional') return <Sun size={size} aria-hidden="true" />;
  if (type === 'spot') return <Lightbulb size={size} aria-hidden="true" />;
  return <CircleDot size={size} aria-hidden="true" />;
}

/** The light's own colour, faded when it is off. */
export function LightDot({ color, off }: { color: string; off: boolean }) {
  return (
    <span
      className="size-2.25 flex-none rounded-full border border-black/30 data-off:opacity-28"
      style={{ backgroundColor: color }}
      data-off={off || undefined}
      aria-hidden="true"
    />
  );
}

/** A label in a fixed column, so the controls of neighbouring rows line up, with its control to the right. */
export function FieldRow({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-5.5 items-center gap-1.5 touch:min-h-9">
      <ControlLabel className="w-12.5 flex-none" title={title}>{label}</ControlLabel>
      {children}
    </div>
  );
}

/** Glyph plus word, as used by the light list rows. */
export function LightTypeBadge({ type }: { type: CustomLightType }) {
  return (
    <span className="inline-flex flex-none items-center gap-0.75 text-10.5 text-dim [&_svg]:flex-none [&_svg]:opacity-85">
      <LightIcon type={type} />
      {TYPE_LABELS[type]}
    </span>
  );
}

const READOUT = 'h-5 min-h-0 w-11 flex-none px-1.25 py-0 [font-family:inherit] text-10.5 text-text tabular-nums focus:border-accent touch:h-8 touch:w-15';

/** Exact entry for a scalar control. The slider keeps the coarse gesture; invalid drafts revert. */
function NumberReadout({
  value,
  min,
  max,
  ariaLabel,
  onChange,
  className,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(() => formatScalar(value));
  const [focused, setFocused] = useState(false);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(parsed)) onChange(clampScalar(parsed, min, max));
  };

  return (
    <Input
      className={cn(READOUT, 'text-right', className)}
      inputMode="decimal"
      spellCheck={false}
      aria-label={ariaLabel}
      value={focused ? draft : formatScalar(value)}
      onFocus={() => {
        setDraft(formatScalar(value));
        setFocused(true);
      }}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={() => {
        commit();
        setFocused(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** Label left and exact readout right, over the drag track, like the Inspector's slider rows. */
export function ScalarRow({
  label,
  title,
  value,
  min,
  max,
  step,
  onChange,
  onPreviewChange,
  trailing,
}: {
  label: string;
  title?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onPreviewChange?: (value: number) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex min-h-5.5 items-center justify-between gap-1.5 touch:min-h-9">
        <ControlLabel title={title}>{label}</ControlLabel>
        <span className="flex flex-none items-center gap-1.5">
          <NumberReadout value={value} min={min} max={max} ariaLabel={`${title ?? label} value`} onChange={onChange} />
          {trailing}
        </span>
      </div>
      <Slider
        value={value}
        min={min}
        max={max}
        step={step}
        ariaLabel={title ?? label}
        onChange={onPreviewChange ?? onChange}
        onCommit={onPreviewChange ? onChange : undefined}
      />
    </div>
  );
}

const AXIS_LETTER: Record<(typeof AXES)[number], string> = { X: 'text-red', Y: 'text-pass', Z: 'text-blu' };

/** X/Y/Z entry for a light point. The axis letters use the viewport gizmo colors. */
export function VectorRow({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: FrameVector;
  min: number;
  max: number;
  onChange: (value: FrameVector) => void;
}) {
  return (
    <FieldRow label={label}>
      {AXES.map((axis, index) => (
        <span key={axis} className="flex min-w-0 flex-1 items-center gap-0.5 rounded-sm border border-border bg-panel pl-1 transition-fast focus-within:border-accent hover:border-strong">
          <span className={cn('flex-none text-9 font-bold tracking-[0.4px]', AXIS_LETTER[axis])} aria-hidden="true">{axis}</span>
          <NumberReadout
            className="h-4.5 w-auto min-w-0 flex-1 border-0 bg-transparent px-0.75 touch:h-7.5 touch:w-auto"
            value={value[index]}
            min={min}
            max={max}
            ariaLabel={`${label} ${axis}`}
            onChange={(next) => {
              const updated: [number, number, number] = [value[0], value[1], value[2]];
              updated[index] = next;
              onChange(updated);
            }}
          />
        </span>
      ))}
    </FieldRow>
  );
}

/** Swatch plus hex entry. The swatch previews while dragging and commits on blur, one undo entry per pick. */
export function ColorRow({
  value,
  onChange,
  onPreviewChange,
}: {
  value: string;
  onChange: (value: string) => void;
  onPreviewChange?: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    setSyncedValue(value);
    setDraft(value);
  }

  const apply = (next: string, commit: boolean) => {
    setDraft(next);
    if (!/^#[0-9a-f]{6}$/i.test(next)) return;
    const hex = next.toLowerCase();
    if (commit || !onPreviewChange) onChange(hex);
    else onPreviewChange(hex);
  };

  return (
    <FieldRow label="Color">
      <input
        className="h-5 min-w-0 flex-1 cursor-pointer rounded-sm border border-border bg-panel p-0.5 focus-ring touch:h-8"
        type="color"
        value={value}
        aria-label="Light color picker"
        onChange={(event) => apply(event.currentTarget.value, false)}
        onBlur={(event) => apply(event.currentTarget.value, true)}
      />
      <Input
        className={cn(READOUT, 'w-16.5 font-mono font-light touch:w-22')}
        value={draft}
        maxLength={7}
        spellCheck={false}
        aria-label="Light color hex"
        onChange={(event) => apply(event.currentTarget.value, true)}
        onBlur={() => {
          if (!/^#[0-9a-f]{6}$/i.test(draft)) setDraft(value);
        }}
      />
    </FieldRow>
  );
}
