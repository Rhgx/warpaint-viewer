import { Popover } from '@base-ui/react/popover';
import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

import { ControlLabel } from '../common/controls';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { Input } from '../primitives/Input';
import { Select, SelectItem, SelectItemText, SelectPopup, SelectTrigger, SelectValue } from '../primitives/Select';

type SeedRangeMode = 'fixed' | 'varies';

export interface SeedRangeValue {
  readonly mode: SeedRangeMode;
  readonly min: number;
  readonly max: number;
}

export interface SeedRangeDivergence {
  readonly count: number;
  readonly weapons: readonly string[];
}

export interface SeedRangeFieldProps {
  readonly label: string;
  readonly unit?: string;
  readonly bounds: readonly [number, number];
  readonly step: number;
  readonly decimals: number;
  readonly value: SeedRangeValue;
  /** Resolved value for the active paint seed, shown as one track marker. */
  readonly currentSeedValue?: number;
  /** Value present when the editor session loaded, used by the reset affordance. */
  readonly originalValue: SeedRangeValue;
  readonly divergence?: SeedRangeDivergence;
  readonly disabled?: boolean;
  /** Locks the value controls only; the divergence button and its push action stay available. */
  readonly valueDisabled?: boolean;
  readonly onChange: (value: SeedRangeValue) => void;
  readonly onPushToAll?: () => void;
  readonly onInteractionStart?: () => void;
  readonly onInteractionEnd?: () => void;
}

type Bound = 'min' | 'max';
type DragBound = Bound | 'pending';

const GESTURE_DEBOUNCE_MS = 450;
// Each base-texture preview needs a GPU composition, and faster requests starve the latest-only queue.
// Keep the control responsive locally and request composed frames at 10 FPS.
const LIVE_PREVIEW_MIN_INTERVAL_MS = 1000 / 10;
const CLOSE_THUMBS_PX = 10;
const DIRECTION_LOCK_PX = 2;
const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);
const RANGE_INPUT = 'range-handle absolute inset-0 m-0 h-7 w-full';
const NUMBER_INPUT = 'w-15.5 px-1.75 py-0 text-right tabular-nums [appearance:textfield] disabled:cursor-default [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none';

function clamp(value: number, bounds: readonly [number, number]): number {
  return Math.min(bounds[1], Math.max(bounds[0], value));
}

function parseTyped(text: string): number | null {
  if (!text.trim()) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameValue(a: SeedRangeValue, b: SeedRangeValue): boolean {
  return a.mode === b.mode && a.min === b.min && a.max === b.max;
}

/** A small non-zero range around the value, so switching to Varies leaves something to drag within bounds. */
function openVariesRange(min: number, bounds: readonly [number, number]): [number, number] {
  const span = bounds[1] - bounds[0];
  const nudge = span * 0.06;
  let lo = min;
  let hi = Math.min(bounds[1], min + nudge);
  if (hi <= lo) {
    lo = Math.max(bounds[0], min - nudge);
    hi = min;
  }
  return [lo, hi];
}

/**
 * Dual-range field for an authored quantity that can vary across seeds.
 * Fixed / Varies is the primary decision. Lock is reserved for the sticker aspect link.
 */
export function SeedRangeField({
  label,
  unit,
  bounds,
  step,
  decimals,
  value,
  currentSeedValue,
  originalValue,
  divergence,
  disabled = false,
  valueDisabled = false,
  onChange,
  onPushToAll,
  onInteractionStart,
  onInteractionEnd,
}: SeedRangeFieldProps) {
  const valueLocked = disabled || valueDisabled;
  const [editing, setEditing] = useState<{ field: Bound; text: string } | null>(null);
  const [dragValue, setDragValue] = useState<SeedRangeValue | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const gestureOpenRef = useRef(false);
  const debounceRef = useRef<number | null>(null);
  const previewFrameRef = useRef<number | null>(null);
  const previewTimerRef = useRef<number | null>(null);
  const lastPreviewAtRef = useRef(0);
  const pendingPreviewRef = useRef<SeedRangeValue | null>(null);
  const emittedPreviewRef = useRef<SeedRangeValue | null>(null);
  const cancelNumberBlurRef = useRef(false);
  const dragBoundRef = useRef<DragBound | null>(null);
  const dragValueRef = useRef<SeedRangeValue | null>(null);
  const dragStartRef = useRef<{ clientX: number; raw: number } | null>(null);
  const lastDragBoundRef = useRef<Bound>('min');

  const startGesture = () => {
    if (gestureOpenRef.current) return;
    gestureOpenRef.current = true;
    onInteractionStart?.();
  };
  const endGesture = () => {
    if (!gestureOpenRef.current) return;
    gestureOpenRef.current = false;
    onInteractionEnd?.();
  };
  /** Typing and arrow stepping share one history entry, like a drag, closed once input goes quiet. */
  const noteGesture = () => {
    startGesture();
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = null;
      endGesture();
    }, GESTURE_DEBOUNCE_MS);
  };

  useEffect(() => () => {
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    if (previewTimerRef.current !== null) window.clearTimeout(previewTimerRef.current);
    if (previewFrameRef.current !== null) window.cancelAnimationFrame(previewFrameRef.current);
    endGesture();
    // Only ever runs on unmount, to close a history entry left open by typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!popoverOpen) return;
    // Marked handled in the capture phase, so that the same key does not also close the drawer.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setPopoverOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [popoverOpen]);

  const format = (raw: number) => raw.toFixed(decimals);

  const commitBound = (bound: Bound, raw: number, clampToSlider = true) => {
    const nextValue = clampToSlider ? clamp(raw, bounds) : raw;
    if (value.mode === 'fixed') {
      onChange({ mode: 'fixed', min: nextValue, max: nextValue });
      return;
    }
    let nextMin = value.min;
    let nextMax = value.max;
    if (bound === 'min') nextMin = nextValue; else nextMax = nextValue;
    // Crossing thumbs swaps roles rather than clamping.
    if (nextMin > nextMax) { const swap = nextMin; nextMin = nextMax; nextMax = swap; }
    onChange({ mode: 'varies', min: nextMin, max: nextMax });
  };

  const handleRangeInput = (bound: Bound, raw: string) => {
    // Pointer drags are owned by the track handlers. Chromium can also emit a native change
    // mid-drag, based on the last rendered prop, which would roll the thumb back.
    if (dragBoundRef.current !== null) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    commitBound(bound, parsed);
  };

  const sliderPointerPosition = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    const raw = bounds[0] + Math.min(1, Math.max(0, ratio)) * span;
    return {
      raw: Math.round(raw / step) * step,
      x: Math.min(rect.width, Math.max(0, event.clientX - rect.left)),
      width: rect.width,
    };
  };

  const previewSliderBound = (bound: Bound, raw: number) => {
    const clamped = clamp(raw, bounds);
    const base = dragValueRef.current ?? value;
    let next: SeedRangeValue;
    if (base.mode === 'fixed') {
      next = { mode: 'fixed', min: clamped, max: clamped };
    } else if (bound === 'min') {
      next = { mode: 'varies', min: Math.min(clamped, base.max), max: base.max };
    } else {
      next = { mode: 'varies', min: base.min, max: Math.max(clamped, base.min) };
    }
    dragValueRef.current = next;
    setDragValue(next);
    pendingPreviewRef.current = next;
    if (previewFrameRef.current === null && previewTimerRef.current === null) {
      const requestPreviewFrame = () => {
        previewTimerRef.current = null;
        previewFrameRef.current = window.requestAnimationFrame(() => {
          previewFrameRef.current = null;
          const pending = pendingPreviewRef.current;
          pendingPreviewRef.current = null;
          if (!pending || sameValue(pending, emittedPreviewRef.current ?? value)) return;
          emittedPreviewRef.current = pending;
          lastPreviewAtRef.current = performance.now();
          onChange(pending);
        });
      };
      const remaining = LIVE_PREVIEW_MIN_INTERVAL_MS - (performance.now() - lastPreviewAtRef.current);
      if (remaining > 0) {
        previewTimerRef.current = window.setTimeout(requestPreviewFrame, remaining);
      } else {
        requestPreviewFrame();
      }
    }
  };

  const finishSliderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragBoundRef.current === null) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (dragBoundRef.current === 'pending' && dragStartRef.current) {
      previewSliderBound(lastDragBoundRef.current, dragStartRef.current.raw);
    }
    const committed = dragValueRef.current;
    if (previewFrameRef.current !== null) {
      window.cancelAnimationFrame(previewFrameRef.current);
      previewFrameRef.current = null;
    }
    if (previewTimerRef.current !== null) {
      window.clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    pendingPreviewRef.current = null;
    dragBoundRef.current = null;
    dragValueRef.current = null;
    dragStartRef.current = null;
    setDragValue(null);
    if (committed && !sameValue(committed, emittedPreviewRef.current ?? value)) onChange(committed);
    emittedPreviewRef.current = null;
    lastPreviewAtRef.current = 0;
    endGesture();
  };

  const beginSliderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (valueLocked || event.button !== 0) return;
    event.preventDefault();
    const pointer = sliderPointerPosition(event);
    let bound: DragBound = 'min';
    if (isVaries) {
      const minX = pct(value.min) / 100 * pointer.width;
      const maxX = pct(value.max) / 100 * pointer.width;
      bound = Math.abs(maxX - minX) <= CLOSE_THUMBS_PX
        ? 'pending'
        : Math.abs(pointer.x - minX) <= Math.abs(pointer.x - maxX) ? 'min' : 'max';
    }
    dragBoundRef.current = bound;
    dragValueRef.current = value;
    dragStartRef.current = { clientX: event.clientX, raw: pointer.raw };
    emittedPreviewRef.current = value;
    setDragValue(value);
    event.currentTarget.setPointerCapture(event.pointerId);
    startGesture();
    if (bound !== 'pending') {
      lastDragBoundRef.current = bound;
      previewSliderBound(bound, pointer.raw);
    }
  };

  const moveSliderDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    let bound = dragBoundRef.current;
    if (bound === null) return;
    const pointer = sliderPointerPosition(event);
    if (bound === 'pending') {
      const start = dragStartRef.current;
      if (!start || Math.abs(event.clientX - start.clientX) < DIRECTION_LOCK_PX) return;
      bound = event.clientX < start.clientX ? 'min' : 'max';
      dragBoundRef.current = bound;
      lastDragBoundRef.current = bound;
    }
    previewSliderBound(bound, pointer.raw);
  };

  const handleRangeKeyDown = (bound: Bound, event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!STEP_KEYS.has(event.key)) return;
    event.preventDefault();
    const current = bound === 'min' ? value.min : value.max;
    const pageStep = step * 10;
    let next = current;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown': next -= step; break;
      case 'ArrowRight':
      case 'ArrowUp': next += step; break;
      case 'PageDown': next -= pageStep; break;
      case 'PageUp': next += pageStep; break;
      case 'Home': next = bounds[0]; break;
      case 'End': next = bounds[1]; break;
      default: return;
    }
    noteGesture();
    commitBound(bound, Number(next.toFixed(Math.max(decimals, 8))));
  };

  const handleNumberChange = (field: Bound, raw: string) => {
    setEditing({ field, text: raw });
  };

  const finishNumberEditing = (field: Bound, raw: string) => {
    if (cancelNumberBlurRef.current) {
      cancelNumberBlurRef.current = false;
      setEditing(null);
      return;
    }
    const parsed = parseTyped(raw);
    setEditing(null);
    if (parsed === null) return;
    onInteractionStart?.();
    // Typed values may exceed the slider bounds; Valve parses these fields as unrestricted ranges.
    commitBound(field, parsed, false);
    onInteractionEnd?.();
  };

  const handleNumberKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelNumberBlurRef.current = true;
      setEditing(null);
      event.currentTarget.blur();
    }
  };

  const setMode = (nextMode: SeedRangeMode) => {
    if (nextMode === value.mode || valueLocked) return;
    const next: SeedRangeValue = nextMode === 'fixed'
      ? { mode: 'fixed', min: value.min, max: value.min }
      : (() => {
        const [lo, hi] = openVariesRange(value.min, bounds);
        return { mode: 'varies', min: lo, max: hi };
      })();
    onInteractionStart?.();
    onChange(next);
    onInteractionEnd?.();
  };

  const revertToOriginal = () => {
    if (valueLocked) return;
    onInteractionStart?.();
    onChange(originalValue);
    onInteractionEnd?.();
  };

  const displayValue = dragValue ?? value;
  const isDirty = !sameValue(value, originalValue);
  const isVaries = displayValue.mode === 'varies';
  const lo = Math.min(displayValue.min, displayValue.max);
  const hi = Math.max(displayValue.min, displayValue.max);
  // A shared value cannot be edited from this scope, but it is still a real value and stays readable. Only a disabled panel holds none.
  const numberInput = cn(NUMBER_INPUT, disabled && 'disabled:opacity-65');
  const span = bounds[1] - bounds[0] || 1;
  const pct = (raw: number) => ((clamp(raw, bounds) - bounds[0]) / span) * 100;

  return (
    <div className="bg-panel px-2.5 pt-1.75 pb-2">
      <div className="flex min-h-control items-center gap-1.5">
        <ControlLabel>{label}</ControlLabel>
        {divergence ? (
          <Popover.Root open={popoverOpen} onOpenChange={setPopoverOpen}>
            <Popover.Trigger
              className="inline-flex min-h-6 min-w-6.75 cursor-pointer items-center justify-center gap-1 rounded-sm border-0 bg-transparent px-1 text-11 text-warn transition-fast focus-ring not-disabled:hover:bg-panel-2 disabled:cursor-default disabled:opacity-45"
              data-slot="seed-range-diverge"
              disabled={disabled}
            >
              <AlertTriangle className="flex-none" size={12} aria-hidden="true" />
              {divergence.count}
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Positioner className="z-1100" align="start" sideOffset={5} collisionPadding={8}>
                <Popover.Popup
                  className="w-60 rounded-md border border-strong bg-panel p-2.5 text-text shadow-pop outline-none forced-colors:border-[CanvasText]"
                  data-slot="seed-range-popover"
                  aria-label={`${label} divergence`}
                >
                  <h4 className="m-0 mb-1.75 text-11.5">{label} differs on {divergence.count} {divergence.count === 1 ? 'weapon' : 'weapons'}</h4>
                  <ul className="scrollbar-slim m-0 mb-2 max-h-27.5 list-disc overflow-auto pl-4.5 text-10.5 text-dim">
                    {divergence.weapons.map((weapon) => <li key={weapon}>{weapon}</li>)}
                  </ul>
                  <Button
                    variant="primary"
                    size="sm"
                    className="min-h-6.5 px-2 text-10.5"
                    disabled={disabled || !onPushToAll}
                    onClick={() => { onPushToAll?.(); setPopoverOpen(false); }}
                  >
                    Push this value to all weapons
                  </Button>
                </Popover.Popup>
              </Popover.Positioner>
            </Popover.Portal>
          </Popover.Root>
        ) : null}
        <span className="flex-1" />
        <Select
          value={displayValue.mode}
          disabled={valueLocked}
          onValueChange={(next) => {
            if (next === 'fixed' || next === 'varies') setMode(next);
          }}
        >
          <SelectTrigger
            className={cn('w-19 min-w-0 gap-1.5 py-0', disabled ? 'disabled:opacity-65' : 'disabled:opacity-100', isVaries ? 'text-text' : 'text-dim', isVaries && !valueLocked && 'border-accent-edge bg-accent-soft')}
            aria-label={`${label} variation`}
          >
            <SelectValue>{() => (isVaries ? 'Varies' : 'Fixed')}</SelectValue>
          </SelectTrigger>
          <SelectPopup className="text-11">
            <SelectItem value="fixed"><SelectItemText>Fixed</SelectItemText></SelectItem>
            <SelectItem value="varies"><SelectItemText>Varies</SelectItemText></SelectItem>
          </SelectPopup>
        </Select>
        {isDirty ? (
          <Button
            size="icon"
            className="flex-none"
            title={`Reset ${label} to its original value`}
            aria-label={`Reset ${label} to its original value`}
            disabled={valueLocked}
            onClick={revertToOriginal}
          >
            <RotateCcw size={12} aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <div className="flex min-w-0 items-center gap-2.5 pt-0.75 pb-px max-[900px]:flex-wrap">
        <div className="min-w-30 flex-1 max-[900px]:min-w-45">
          <div
            className="relative h-7 cursor-pointer touch-none"
            data-slot="seed-range-track"
            onPointerDown={beginSliderDrag}
            onPointerMove={moveSliderDrag}
            onPointerUp={finishSliderDrag}
            onPointerCancel={finishSliderDrag}
          >
            <span className="pointer-events-none absolute inset-x-0 top-3.25 h-0.75 rounded-full bg-strong" />
            <span
              className={cn('pointer-events-none absolute top-3.25 h-0.75 rounded-full', valueLocked ? 'bg-dim/50' : 'bg-accent')}
              // A range fills between its two handles. A fixed value fills from the start, as every other slider does.
              style={isVaries ? { left: `${pct(lo)}%`, width: `${Math.max(pct(hi) - pct(lo), 0)}%` } : { left: 0, width: `${pct(hi)}%` }}
            />
            {isVaries && currentSeedValue !== undefined && Number.isFinite(currentSeedValue) ? (
              <span
                className="pointer-events-none absolute top-2 z-2 h-3 w-0.75 -translate-x-1/2 rounded-[1px] border border-[color-mix(in_srgb,var(--text)_48%,var(--border))] bg-[color-mix(in_srgb,var(--text-dim)_72%,var(--panel))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--panel)_75%,transparent)]"
                // The handle travels inset by half its 14px width, so the marker uses the same range to line up with it.
                style={{ left: `calc(7px + (100% - 14px) * ${pct(currentSeedValue) / 100})` }}
                title={`Current seed: ${format(currentSeedValue)}${unit ?? ''}`}
                aria-hidden="true"
              />
            ) : null}
            <input
              type="range"
              className={RANGE_INPUT}
              aria-label={`${label} minimum`}
              min={bounds[0]}
              max={bounds[1]}
              step={step}
              value={displayValue.min}
              disabled={valueLocked}
              onKeyDown={(event) => handleRangeKeyDown('min', event)}
              onChange={(event) => handleRangeInput('min', event.target.value)}
            />
            {isVaries ? (
              <input
                type="range"
                className={RANGE_INPUT}
                aria-label={`${label} maximum`}
                min={bounds[0]}
                max={bounds[1]}
                step={step}
                value={displayValue.max}
                disabled={valueLocked}
                onKeyDown={(event) => handleRangeKeyDown('max', event)}
                onChange={(event) => handleRangeInput('max', event.target.value)}
              />
            ) : null}
          </div>
        </div>

        <div className="flex flex-none items-center gap-1 max-[900px]:ml-auto">
          <Input
            className={numberInput}
            type="number"
            aria-label={`${label} minimum value`}
            min={bounds[0]}
            max={bounds[1]}
            step={step}
            value={editing?.field === 'min' ? editing.text : format(displayValue.min)}
            disabled={valueLocked}
            onFocus={() => { cancelNumberBlurRef.current = false; }}
            onChange={(event) => handleNumberChange('min', event.target.value)}
            onBlur={(event) => finishNumberEditing('min', event.target.value)}
            onKeyDown={handleNumberKeyDown}
          />
          {isVaries ? (
            <>
              <span className="text-10 text-dim">…</span>
              <Input
                className={numberInput}
                type="number"
                aria-label={`${label} maximum value`}
                min={bounds[0]}
                max={bounds[1]}
                step={step}
                value={editing?.field === 'max' ? editing.text : format(displayValue.max)}
                disabled={valueLocked}
                onFocus={() => { cancelNumberBlurRef.current = false; }}
                onChange={(event) => handleNumberChange('max', event.target.value)}
                onBlur={(event) => finishNumberEditing('max', event.target.value)}
                onKeyDown={handleNumberKeyDown}
              />
            </>
          ) : null}
          {/* Held open when empty, so that the number fields of every row line up. */}
          <span className="w-3 text-10.5 text-dim">{unit}</span>
        </div>
      </div>
    </div>
  );
}
