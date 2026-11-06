import { memo, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Eye, EyeOff, HelpCircle, RotateCcw, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { CONTROL, ControlLabel } from '../common/controls';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { PanelSection, PanelSectionHeader } from '../primitives/PanelSection';
import { Slider } from '../primitives/Slider';
import { ToggleGroup } from '../primitives/ToggleGroup';
import { TOOLTIP_SURFACE } from '../primitives/Tooltip';

// Panel building blocks shared by the showcase sections.

const SECTION_ACTION = 'size-5.5 flex-none';

/** A collapsible panel section, optionally with a button that returns its settings to the defaults. */
export function Section({ title, icon, children, onReset, canReset = false, aside, onClose, open: controlledOpen, onOpenChange }: {
  title: string;
  icon: LucideIcon;
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
  const hasActions = onReset || onClose;
  // Contained, so a slider moving inside one section does not re-lay out the others.
  return (
    <PanelSection data-slot="board-section" className="[contain:layout_style]">
      <div className="relative">
        <PanelSectionHeader open={open} icon={icon} onClick={() => setOpen((value) => !value)}>
          {/* Weapon names title their section, and a taken-out part's can run long. The margin keeps it clear of the buttons below. */}
          <span className={cn('min-w-0 truncate', hasActions && 'mr-12')}>{title}</span>
          {aside}
        </PanelSectionHeader>
        {/* Laid over the header, not beside it, so that every section's chevron lands in the same place. */}
        {hasActions && (
          <div className="absolute inset-y-0 right-5 flex items-center gap-0.5">
            {onReset && (
              <Button variant="ghost" size="icon-sm" className={SECTION_ACTION} title={`Reset ${title.toLowerCase()} to defaults`}
                aria-label={`Reset ${title.toLowerCase()} to defaults`} disabled={!canReset} onClick={onReset}>
                <RotateCcw size={12} />
              </Button>
            )}
            {onClose && (
              <Button variant="ghost" size="icon-sm" className={SECTION_ACTION} title="Deselect (Esc)" aria-label="Deselect" onClick={onClose}>
                <X size={12} />
              </Button>
            )}
          </div>
        )}
      </div>
      {open && <div className="flex flex-col gap-2.5 px-0.5 pt-2 pb-2.5">{children}</div>}
    </PanelSection>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-control items-center justify-between gap-2.5">
      <ControlLabel>{label}</ControlLabel>
      <div className="flex min-w-0 justify-end">{children}</div>
    </div>
  );
}

/** Opens on hover for a mouse and on tap for touch, like the paint details card. */
function HintButton({ label, hint }: { label: string; hint: string }) {
  return (
    <Popover.Root>
      <Popover.Trigger openOnHover delay={150} data-slot="board-hint" aria-label={`What ${label} does`}
        className="grid size-4 cursor-help place-items-center rounded-full border-0 bg-transparent p-0 text-dim focus-ring hover:text-text data-popup-open:text-text">
        <HelpCircle size={12} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={6} collisionPadding={10} className="z-1100">
          <Popover.Popup data-slot="board-hint-popup" className={TOOLTIP_SURFACE}>{hint}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function SliderRow({ label, value, children, hint }: { label: string; value: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <div className={CONTROL}>
      <div className="flex items-center justify-between gap-2">
        <ControlLabel>
          {label}
          {hint && <HintButton label={label} hint={hint} />}
        </ControlLabel>
        <span className="text-10 text-text tabular-nums">{value}</span>
      </div>
      {children}
    </div>
  );
}

/** A short set of choices as one row of buttons. */
export function Segmented<T extends string | number>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup size="sm" label={label} value={value} options={options} onChange={(next) => { if (next !== value) onChange(next); }} />
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
      <Slider value={value} min={min} max={max} step={step} ariaLabel={label} markers={markers} onChange={onChange} onCommit={onCommit} />
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
    <span className="inline-flex items-center gap-px text-dim">
      <input
        className="h-5 w-10 rounded-sm border border-border bg-panel px-1 text-right [font-family:inherit] text-12 text-text tabular-nums outline-none transition-fast focus-ring hover:border-strong focus:border-accent"
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
      className="relative flex-none cursor-crosshair touch-none rounded-full border border-border bg-[radial-gradient(circle,var(--panel-2)_0_30%,var(--panel)_75%)]"
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
      <span className="absolute inset-x-[24%] inset-y-[34%] rounded-xs border border-strong bg-board-wood" />
      <span className="pointer-events-none absolute -mt-1.75 -ml-1.75 size-3.5 rounded-full border-2 border-accent-text bg-board-light" style={{ left: dot.x, top: dot.y }} />
    </div>
  );
}

export const EYE_ICON = <Eye size={13} />;
export const EYE_OFF_ICON = <EyeOff size={13} />;
