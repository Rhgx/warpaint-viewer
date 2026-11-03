import { memo, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { ChevronDown, Eye, EyeOff, HelpCircle, RotateCcw, X } from 'lucide-react';

import { SliderField } from '../common/controls';

// Panel building blocks shared by the showcase sections.

/** A collapsible panel section, optionally with a button that returns its settings to the defaults. */
export function Section({ title, children, onReset, canReset = false, aside, onClose, open: controlledOpen, onOpenChange }: {
  title: string;
  children: ReactNode;
  onReset?: () => void;
  canReset?: boolean;
  aside?: ReactNode;
  onClose?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(true);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (update: (value: boolean) => boolean) => {
    if (onOpenChange) onOpenChange(update(open));
    else setOwnOpen(update);
  };
  return (
    <div className="inspector-section showcase-section">
      <div className="showcase-section-header">
        <button type="button" className="inspector-section-header" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          <span>{title}</span>
          {aside}
          <ChevronDown size={14} className="inspector-section-chevron" data-collapsed={!open || undefined} />
        </button>
        {onReset && (
          <button type="button" className="showcase-section-reset" title={`Reset ${title.toLowerCase()} to defaults`}
            aria-label={`Reset ${title.toLowerCase()} to defaults`} disabled={!canReset} onClick={onReset}>
            <RotateCcw size={12} />
          </button>
        )}
        {onClose && (
          <button type="button" className="showcase-section-reset" title="Deselect (Esc)" aria-label="Deselect" onClick={onClose}>
            <X size={12} />
          </button>
        )}
      </div>
      {open && <div className="showcase-section-body">{children}</div>}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="showcase-row">
      <span className="showcase-row-label">{label}</span>
      <div className="showcase-row-control">{children}</div>
    </div>
  );
}

/** Opens on hover for a mouse and on tap for touch, like the paint details card. */
function HintButton({ label, hint }: { label: string; hint: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger openOnHover delay={150} className="showcase-hint" aria-label={`What ${label} does`}>
        <HelpCircle size={12} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={10} className="showcase-hint-positioner">
          <Popover.Popup className="showcase-hint-popup">{hint}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function SliderRow({ label, value, children, hint }: { label: string; value: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <div className="showcase-slider">
      <div className="showcase-slider-head">
        <span className="showcase-slider-label">
          {label}
          {hint && <HintButton label={label} hint={hint} />}
        </span>
        <span className="showcase-slider-value">{value}</span>
      </div>
      {children}
    </div>
  );
}

/** A short set of choices as one row of buttons, styled like the viewer's team toggle. */
export function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="showcase-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" aria-pressed={option.value === value}
          onClick={() => { if (option.value !== value) onChange(option.value); }}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A slider row that only re-renders when its own value changes. */
export const ValueSlider = memo(function ValueSlider({ label, display, value, min, max, step, markers, onChange, onCommit, hint }: {
  label: string;
  display: string;
  value: number;
  min: number;
  max: number;
  step: number;
  markers?: readonly number[];
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
  hint?: string;
}) {
  return (
    <SliderRow label={label} value={display} hint={hint}>
      <SliderField value={value} min={min} max={max} step={step} ariaLabel={label} markers={markers} onChange={onChange} onCommit={onCommit} />
    </SliderRow>
  );
});

/** A percentage typed into a slider row. */
export function PercentInput({ value, min, max, label, onCommit }: {
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const parsed = Number.parseFloat(draft ?? '');
    setDraft(null);
    if (Number.isFinite(parsed)) onCommit(Math.min(max, Math.max(min, Math.round(parsed))));
  };
  return (
    <span className="showcase-percent">
      <input
        className="showcase-percent-input"
        inputMode="numeric"
        aria-label={label}
        value={draft ?? String(value)}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.currentTarget.value.replace(/[^\d.]/g, ''))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
      />
      %
    </span>
  );
}

/** Drag the dot to where the light comes from; nearer the middle means higher overhead. */
export function LightPad({ azimuth, elevation, onChange }: { azimuth: number; elevation: number; onChange: (azimuth: number, elevation: number) => void }) {
  const size = 96;
  const half = size / 2;
  const reach = half - 9;
  const distance = ((89 - elevation) / (89 - 15)) * reach;
  const rad = (azimuth * Math.PI) / 180;
  const dot = { x: half + Math.cos(rad) * distance, y: half - Math.sin(rad) * distance };
  const fromPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - rect.left - half;
    const dy = -(event.clientY - rect.top - half);
    const length = Math.min(Math.hypot(dx, dy), reach);
    onChange(Math.round((Math.atan2(dy, dx) * 180) / Math.PI), Math.round(89 - (length / reach) * (89 - 15)));
  };
  return (
    <div
      className="showcase-lightpad"
      style={{ width: size, height: size }}
      role="slider"
      aria-label="Light direction"
      aria-valuetext={`From ${azimuth}°, ${elevation}° high`}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        fromPointer(event);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
      }}
    >
      <span className="showcase-lightpad-board" />
      <span className="showcase-lightpad-dot" style={{ left: dot.x, top: dot.y }} />
    </div>
  );
}

export const EYE_ICON = <Eye size={13} />;
export const EYE_OFF_ICON = <EyeOff size={13} />;
