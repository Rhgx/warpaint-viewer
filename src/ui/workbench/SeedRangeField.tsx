import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { Flag, RotateCcw } from 'lucide-react';
import './SeedRangeField.css';

export type SeedRangeMode = 'fixed' | 'varies';

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
  /** Proto default, drives the revert affordance. */
  readonly defaultValue: SeedRangeValue;
  readonly divergence?: SeedRangeDivergence;
  readonly disabled?: boolean;
  readonly onChange: (value: SeedRangeValue) => void;
  readonly onPushToAll?: () => void;
  readonly onInteractionStart?: () => void;
  readonly onInteractionEnd?: () => void;
}

type Bound = 'min' | 'max';
type DragBound = Bound | 'pending';

const GESTURE_DEBOUNCE_MS = 450;
const LIVE_PREVIEW_MIN_INTERVAL_MS = 1000 / 30;
const CLOSE_THUMBS_PX = 10;
const DIRECTION_LOCK_PX = 2;
const STEP_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

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

/**
 * A small non-zero range around the current value: switching to Varies must
 * always leave something to drag, and must never spill past the bounds.
 */
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
 * A dual-range field for one authored quantity that can vary across seeds.
 * "Fixed / Varies" is the primary decision; the numbers below follow from it.
 * "Lock" is deliberately never used here, it stays reserved for the sticker
 * editor's aspect link so the two ideas do not blur together.
 */
export function SeedRangeField({
  label,
  unit,
  bounds,
  step,
  decimals,
  value,
  currentSeedValue,
  defaultValue,
  divergence,
  disabled = false,
  onChange,
  onPushToAll,
  onInteractionStart,
  onInteractionEnd,
}: SeedRangeFieldProps) {
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
  const popoverRef = useRef<HTMLDivElement>(null);
  const divergeButtonRef = useRef<HTMLButtonElement>(null);
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
  /**
   * A burst of typing or arrow-key stepping is one undoable gesture, closed
   * once input goes quiet. Mirrors StickerPlacementEditor's noteTyping so a
   * drag and a burst of keystrokes both collapse to a single history entry.
   */
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
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setPopoverOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || divergeButtonRef.current?.contains(target)) return;
      setPopoverOpen(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
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
    // Crossing thumbs swaps roles rather than clamping, matching every other
    // dual-range control people have used.
    if (nextMin > nextMax) { const swap = nextMin; nextMin = nextMax; nextMax = swap; }
    onChange({ mode: 'varies', min: nextMin, max: nextMax });
  };

  const handleRangeInput = (bound: Bound, raw: string) => {
    // Pointer drags are owned by the track handlers below. Chromium can also
    // emit a native range change from the thumb during that same gesture. That
    // event is based on the last rendered prop and can briefly overwrite the
    // newer dragValueRef preview, which makes the thumb appear to roll back.
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
    if (disabled || event.button !== 0) return;
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
    // Valve parses these fields as unrestricted numeric ranges. The bounds
    // describe the useful slider span, but typed authoring must remain able to
    // represent stock and custom values outside that span.
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
    if (nextMode === value.mode || disabled) return;
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

  const revertToDefault = () => {
    if (disabled) return;
    onInteractionStart?.();
    onChange(defaultValue);
    onInteractionEnd?.();
  };

  const displayValue = dragValue ?? value;
  const isDirty = !sameValue(value, defaultValue);
  const isVaries = displayValue.mode === 'varies';
  const lo = Math.min(displayValue.min, displayValue.max);
  const hi = Math.max(displayValue.min, displayValue.max);
  const span = bounds[1] - bounds[0] || 1;
  const pct = (raw: number) => ((clamp(raw, bounds) - bounds[0]) / span) * 100;

  return (
    <div
      className="seed-range-field"
      data-mode={displayValue.mode}
      data-dirty={isDirty ? '' : undefined}
    >
      <div className="seed-range-field-head">
        <span className="seed-range-field-expand">
          <span className="seed-range-field-name">{label}</span>
        </span>
        {divergence ? (
          <div className="seed-range-field-diverge-wrap">
            <button
              ref={divergeButtonRef}
              type="button"
              className="seed-range-field-diverge"
              aria-haspopup="dialog"
              aria-expanded={popoverOpen}
              disabled={disabled}
              onClick={() => setPopoverOpen((open) => !open)}
            >
              <Flag size={11} aria-hidden="true" />
              {divergence.count}
            </button>
            {popoverOpen ? (
              <div
                className="seed-range-field-popover"
                ref={popoverRef}
                role="dialog"
                aria-label={`${label} divergence`}
              >
                <h4>{label} differs on {divergence.count} {divergence.count === 1 ? 'weapon' : 'weapons'}</h4>
                <ul>
                  {divergence.weapons.map((weapon) => <li key={weapon}>{weapon}</li>)}
                </ul>
                <button
                  type="button"
                  disabled={disabled || !onPushToAll}
                  onClick={() => { onPushToAll?.(); setPopoverOpen(false); }}
                >
                  Push this value to all weapons
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
        <span className="seed-range-field-head-spacer" />
        <select
          className="seed-range-field-mode"
          aria-label={`${label} variation`}
          value={displayValue.mode}
          disabled={disabled}
          onChange={(event) => setMode(event.target.value as SeedRangeMode)}
        >
          <option value="fixed">Fixed</option>
          <option value="varies">Varies</option>
        </select>
        {isDirty ? (
          <button
            type="button"
            className="seed-range-field-revert"
            title={`Reset ${label} to its default`}
            aria-label={`Reset ${label} to its default`}
            disabled={disabled}
            onClick={revertToDefault}
          >
            <RotateCcw size={12} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="seed-range-field-body">
        <div className="seed-range-field-track-wrap">
          <div
            className="seed-range-field-track"
            onPointerDown={beginSliderDrag}
            onPointerMove={moveSliderDrag}
            onPointerUp={finishSliderDrag}
            onPointerCancel={finishSliderDrag}
          >
            <span className="seed-range-field-rail" />
            <span
              className="seed-range-field-fill"
              style={{ left: `${pct(lo)}%`, width: `${Math.max(pct(hi) - pct(lo), 0)}%` }}
            />
            {displayValue.mode === 'varies' && currentSeedValue !== undefined && Number.isFinite(currentSeedValue) ? (
              <span
                className="seed-range-field-current-seed"
                style={{ left: `${pct(currentSeedValue)}%` }}
                title={`Current seed: ${format(currentSeedValue)}${unit ?? ''}`}
                aria-hidden="true"
              />
            ) : null}
            <input
              type="range"
              data-bound="min"
              aria-label={`${label} minimum`}
              min={bounds[0]}
              max={bounds[1]}
              step={step}
              value={displayValue.min}
              disabled={disabled}
              onKeyDown={(event) => handleRangeKeyDown('min', event)}
              onChange={(event) => handleRangeInput('min', event.target.value)}
            />
            {isVaries ? (
              <input
                type="range"
                data-bound="max"
                aria-label={`${label} maximum`}
                min={bounds[0]}
                max={bounds[1]}
                step={step}
                value={displayValue.max}
                disabled={disabled}
                onKeyDown={(event) => handleRangeKeyDown('max', event)}
                onChange={(event) => handleRangeInput('max', event.target.value)}
              />
            ) : null}
          </div>
        </div>

        <div className="seed-range-field-nums">
          <input
            className="seed-range-field-num"
            type="number"
            aria-label={`${label} minimum value`}
            min={bounds[0]}
            max={bounds[1]}
            step={step}
            value={editing?.field === 'min' ? editing.text : format(displayValue.min)}
            disabled={disabled}
            onFocus={() => { cancelNumberBlurRef.current = false; }}
            onChange={(event) => handleNumberChange('min', event.target.value)}
            onBlur={(event) => finishNumberEditing('min', event.target.value)}
            onKeyDown={handleNumberKeyDown}
          />
          {isVaries ? (
            <>
              <span className="seed-range-field-sep">…</span>
              <input
                className="seed-range-field-num"
                type="number"
                aria-label={`${label} maximum value`}
                min={bounds[0]}
                max={bounds[1]}
                step={step}
                value={editing?.field === 'max' ? editing.text : format(displayValue.max)}
                disabled={disabled}
                onFocus={() => { cancelNumberBlurRef.current = false; }}
                onChange={(event) => handleNumberChange('max', event.target.value)}
                onBlur={(event) => finishNumberEditing('max', event.target.value)}
                onKeyDown={handleNumberKeyDown}
              />
            </>
          ) : null}
          {unit ? <span className="seed-range-field-unit">{unit}</span> : null}
        </div>
      </div>
    </div>
  );
}
