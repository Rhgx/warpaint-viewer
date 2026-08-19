import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { CircleDot, Lightbulb, Sun } from 'lucide-react';
import { SliderField } from '../common/controls';
import type { CustomLightType, FrameVector } from '../../viewer/customLighting';
import { AXES, TYPE_LABELS, clampScalar, formatScalar } from './lightingRig';

/**
 * One glyph per light type. Three types is a small enough set to recognise at a
 * glance, which is faster than reading the word in a dense list, so the two are
 * shown together and the glyph alone carries the badge when space is tight.
 */
export function LightIcon({ type, size = 12 }: { type: CustomLightType; size?: number }) {
  if (type === 'directional') return <Sun size={size} aria-hidden="true" />;
  if (type === 'spot') return <Lightbulb size={size} aria-hidden="true" />;
  return <CircleDot size={size} aria-hidden="true" />;
}

/** Glyph plus word, as used by the light list rows. */
export function LightTypeBadge({ type }: { type: CustomLightType }) {
  return (
    <span className="lighting-list-type">
      <LightIcon type={type} />
      {TYPE_LABELS[type]}
    </span>
  );
}

/**
 * The numeric half of every scalar control. The slider owns the coarse gesture
 * and this keeps exact entry available: while focused it holds a free-typed
 * draft so the field can be cleared and retyped, and it only commits on Enter
 * or blur. An out-of-range or unparseable draft reverts to the live value.
 */
export function NumberReadout({
  value,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(() => formatScalar(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(formatScalar(value));
  }, [value, focused]);

  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(parsed)) onChange(clampScalar(parsed, min, max));
    else setDraft(formatScalar(value));
  };

  return (
    <input
      className="lighting-readout"
      inputMode="decimal"
      spellCheck={false}
      aria-label={ariaLabel}
      value={draft}
      onFocus={() => setFocused(true)}
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

/** Label, drag track and exact readout on one 22px row. */
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
    <div className="lighting-scalar">
      <span className="lighting-scalar-label" title={title}>{label}</span>
      {/* The shared slider's root carries no class of its own, so the row needs
          an element it can actually stretch. */}
      <span className="lighting-scalar-track">
        <SliderField
          value={value}
          min={min}
          max={max}
          step={step}
          ariaLabel={title ?? label}
          onChange={onPreviewChange ?? onChange}
          onCommit={onPreviewChange ? onChange : undefined}
        />
      </span>
      <NumberReadout value={value} min={min} max={max} ariaLabel={`${title ?? label} value`} onChange={onChange} />
      {trailing}
    </div>
  );
}

/**
 * X/Y/Z entry for a light's source or aim point. The axis letters carry the
 * same three colors as the viewport gizmo arrows, so a number here and an arrow
 * out there are visibly the same axis.
 */
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
    <div className="lighting-vector">
      <span className="lighting-scalar-label">{label}</span>
      {AXES.map((axis, index) => (
        <span key={axis} className="lighting-axis" data-axis={axis.toLowerCase()}>
          <span className="lighting-axis-letter" aria-hidden="true">{axis}</span>
          <NumberReadout
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
    </div>
  );
}

/**
 * Swatch plus hex entry; the hex only commits once it parses. The swatch scrubs
 * through preview updates and commits on blur, the same split the sliders use:
 * the native picker fires an input event per pointer move, so committing each
 * one would land a separate undo entry for a single colour pick.
 */
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
  useEffect(() => setDraft(value), [value]);

  const apply = (next: string, commit: boolean) => {
    setDraft(next);
    if (!/^#[0-9a-f]{6}$/i.test(next)) return;
    const hex = next.toLowerCase();
    if (commit || !onPreviewChange) onChange(hex);
    else onPreviewChange(hex);
  };

  return (
    <div className="lighting-scalar lighting-color-row">
      <span className="lighting-scalar-label">Color</span>
      <input
        className="lighting-color-swatch"
        type="color"
        value={value}
        aria-label="Light color picker"
        onChange={(event) => apply(event.currentTarget.value, false)}
        onBlur={(event) => apply(event.currentTarget.value, true)}
      />
      <input
        className="lighting-readout lighting-color-hex"
        value={draft}
        maxLength={7}
        spellCheck={false}
        aria-label="Light color hex"
        onChange={(event) => apply(event.currentTarget.value, true)}
        onBlur={() => {
          if (!/^#[0-9a-f]{6}$/i.test(draft)) setDraft(value);
        }}
      />
    </div>
  );
}
