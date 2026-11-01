import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronDown, Copy, CopyPlus, Dices, Eye, EyeOff, HelpCircle, Search, FlipHorizontal2, GripVertical, ImageDown, PackageOpen, Redo2, RotateCcw, RotateCw,
  SlidersHorizontal, Trash2, Undo2, X,
} from 'lucide-react';
import type { RecipeNode, TextureResolver } from '../../compositor/types';
import type { Grade, Manifest, PaintkitEntry, TextureMetadata, WeaponEntry } from '../../data/types';
import { joinData } from '../../data/loader';
import {
  ShowcaseBoard, TILT_LIMIT, restingRoll, type BoardBackground, type FitProblem, type GridSize, type ShowcaseItem, type ShowcasePaint, type ShowcaseSnapshot,
} from '../../showcase/ShowcaseBoard';
import { TEAM_PAIR_LIMIT, boardLayouts, type BoardLayout, type LayoutRows } from '../../showcase/layouts';
import { POSE_RIGS, WEAPON_PARTS, defaultPose, isRigged, snapMarks, snapPose, type PoseControl } from '../../showcase/poseRigs';
import { IconSelectField, SelectField, SliderField, SwitchField, TeamToggle, TextField, WearSliderField, type IconOption } from '../common/controls';
import { downloadBlob } from '../common/download';
import { randomSeed } from '../../hooks/useBootData';
import { ShowcaseGizmo, ShowcasePoseHandles } from './ShowcaseGizmo';
import { ControlsHelpModal } from '../stage/ControlsHelpModal';
import './Showcase.css';

const EMPTY_SNAPSHOT: ShowcaseSnapshot = {
  items: [], selectedId: null, problems: {}, pending: null, dragging: false, canUndo: false, canRedo: false,
};
const VIEWMODEL_MODELS = `${import.meta.env.BASE_URL}data/viewmodels/models/`;
const OUTPUT_WIDTHS = [1280, 1920, 2560, 3840];
const TRAY_DRAG_THRESHOLD = 6;
const LAYER_ROW_HEIGHT = 36;
const SIZE_SLIDER = { min: 50, max: 150 };
/** Typed sizes may go past the slider. */
const SIZE_TYPED = { min: 10, max: 500 };

/** Board-wide settings; each panel section can return its part to these. */
interface ShowcaseSettings {
  snapToGrid: boolean;
  grid: GridSize;
  keepApart: boolean;
  spacing: number;
  keepInside: boolean;
  rotationSnap: number;
  showFootprints: boolean;
  lightAzimuth: number;
  lightElevation: number;
  shadows: boolean;
  shadow: number;
  background: BoardBackground;
  outputWidth: number;
  /** Drag handles on the moving parts of the selected weapon, next to the pose sliders. */
  poseHandles: boolean;
}

const DEFAULT_SETTINGS: ShowcaseSettings = {
  snapToGrid: true,
  grid: 'normal',
  keepApart: true,
  spacing: 1,
  keepInside: true,
  rotationSnap: 30,
  showFootprints: false,
  lightAzimuth: 125,
  lightElevation: 55,
  shadows: true,
  shadow: 60,
  background: 'framed',
  outputWidth: 1920,
  poseHandles: true,
};

const PLACEMENT_KEYS = ['snapToGrid', 'grid', 'keepApart', 'spacing', 'keepInside', 'rotationSnap', 'showFootprints'] as const;
const LOOK_KEYS = ['lightAzimuth', 'lightElevation', 'shadows', 'shadow', 'background'] as const;
const EXPORT_KEYS = ['outputWidth'] as const;
type SettingKeys = readonly (keyof ShowcaseSettings)[];

const SETTINGS_STORAGE_KEY = 'warpaint-viewer:showcase-settings';
const ROTATION_SNAPS = [45, 30, 15, 5, 0];
const ALLOWED_VALUES: Partial<Record<keyof ShowcaseSettings, readonly unknown[]>> = {
  grid: ['fine', 'normal', 'coarse'],
  background: ['framed', 'pegboard', 'transparent'],
  rotationSnap: ROTATION_SNAPS,
  outputWidth: OUTPUT_WIDTHS,
};

/** Saved settings, keeping only values that still match the current options. */
function loadSettings(): ShowcaseSettings {
  let saved: unknown = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) ?? 'null');
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!saved || typeof saved !== 'object') return DEFAULT_SETTINGS;
  const settings: ShowcaseSettings = { ...DEFAULT_SETTINGS };
  const record = saved as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof ShowcaseSettings)[]) {
    const value = record[key];
    const allowed = ALLOWED_VALUES[key];
    if (typeof value !== typeof DEFAULT_SETTINGS[key] || (allowed && !allowed.includes(value))) continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    Object.assign(settings, { [key]: value });
  }
  return settings;
}

function describeProblem(problem: FitProblem): string {
  if (!problem) return 'Fits on the board';
  return problem.kind === 'outside' ? 'Hangs off the board' : `Too close to the ${problem.otherName}`;
}

interface ShowcaseModeProps {
  manifest: Manifest;
  paintkits: readonly PaintkitEntry[];
  selectedKit: PaintkitEntry | null;
  team: 'red' | 'blu';
  wearIndex: number;
  seed: string;
  resolveRecipe: (kit: PaintkitEntry, weaponKey: string, team: 'red' | 'blu', wearIndex: number) => Promise<RecipeNode | null>;
  resolveTexture: TextureResolver;
  resolveCubemap: (ref: string) => Promise<string[] | null>;
  textureMetadataResolver: (ref: string) => Partial<TextureMetadata> | undefined;
  inspectorEl: HTMLElement | null;
  onClose: () => void;
}

export default function ShowcaseMode(props: ShowcaseModeProps) {
  const { manifest, selectedKit, inspectorEl, onClose } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [board, setBoard] = useState<ShowcaseBoard | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Private browsing without storage: settings last for the session.
    }
  }, [settings]);
  const rotationStep = settings.rotationSnap || 30;
  const rotationStepRef = useRef(rotationStep);
  useEffect(() => {
    rotationStepRef.current = rotationStep;
  }, [rotationStep]);
  // The board reads the latest paint inputs lazily, so it never needs rebuilding for them.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const instance = new ShowcaseBoard({
      canvas,
      weapons: manifest.weapons,
      modelUrl: (weapon, rigged) => (rigged ? `${VIEWMODEL_MODELS}${weapon.key}.glb` : joinData(weapon.model)),
      resolveTexture: (ref) => latest.current.resolveTexture(ref),
      textureMetadata: manifest.textures,
      textureMetadataResolver: (ref) => latest.current.textureMetadataResolver(ref),
      resolveCubemap: (ref) => latest.current.resolveCubemap(ref),
      // A paint can swap in its own material per weapon (the Macaw finishes).
      materialOverride: (weaponKey, kitId) => {
        const overrideId = latest.current.paintkits.find((kit) => kit.id === kitId)?.materialOverrides?.[weaponKey];
        return overrideId ? manifest.materials?.[overrideId] : undefined;
      },
      resolveRecipe: (kitId, weaponKey, team, wearIndex) => {
        const { paintkits, resolveRecipe } = latest.current;
        const kit = paintkits.find((entry) => entry.id === kitId);
        return kit ? resolveRecipe(kit, weaponKey, team, wearIndex) : Promise.resolve(null);
      },
    });
    setBoard(instance);
    if (import.meta.env.DEV) (window as unknown as { __showcase?: ShowcaseBoard }).__showcase = instance;
    return () => {
      instance.dispose();
      setBoard(null);
    };
  }, [manifest]);

  // One effect per setting, so changing one never re-measures for the others.
  useEffect(() => { board?.setSnap(settings.snapToGrid); }, [board, settings.snapToGrid]);
  useEffect(() => { board?.setGrid(settings.grid); }, [board, settings.grid]);
  useEffect(() => { board?.setKeepApart(settings.keepApart); }, [board, settings.keepApart]);
  useEffect(() => { board?.setSpacing(settings.spacing); }, [board, settings.spacing]);
  useEffect(() => { board?.setKeepInside(settings.keepInside); }, [board, settings.keepInside]);
  useEffect(() => { board?.setShowGrid(settings.showFootprints); }, [board, settings.showFootprints]);
  useEffect(() => { board?.setLight(settings.lightAzimuth, settings.lightElevation); }, [board, settings.lightAzimuth, settings.lightElevation]);
  useEffect(() => { board?.setShadows(settings.shadows); }, [board, settings.shadows]);
  useEffect(() => { board?.setShadowStrength(settings.shadow / 100); }, [board, settings.shadow]);
  useEffect(() => { board?.setBackground(settings.background); }, [board, settings.background]);

  const snapshot = useSyncExternalStore(board?.subscribe ?? noopSubscribe, board?.getSnapshot ?? emptySnapshot);

  // Picking another paint in the catalog repaints the selected weapon, when that paint covers it.
  const previousKitId = useRef(selectedKit?.id);
  useEffect(() => {
    if (!board || !selectedKit || previousKitId.current === selectedKit.id) return;
    previousKitId.current = selectedKit.id;
    const { selectedId, items } = board.getSnapshot();
    const item = items.find((entry) => entry.id === selectedId);
    if (!item || item.paint.kitId === selectedKit.id || !selectedKit.weapons.includes(item.weaponKey)) return;
    board.setPaint(item.id, { kitId: selectedKit.id, kitName: selectedKit.name });
  }, [board, selectedKit]);
  const selected = snapshot.items.find((item) => item.id === snapshot.selectedId) ?? null;

  useEffect(() => {
    if (!board) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.ctrlKey || event.metaKey || target?.closest('input, textarea, [role="slider"], [contenteditable="true"]')) return;
      // A dialog such as the controls reference owns the keyboard while open.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const held = board.heldId;
      const id = held ?? board.getSnapshot().selectedId;
      if (event.key === 'Escape' && !held) board.select(null);
      if (!id) return;
      const step = rotationStepRef.current;
      const key = event.key.toLowerCase();
      // E or R turns clockwise, Q or Shift+R counterclockwise, also while carrying.
      if (key === 'e' || key === 'q' || key === 'r') {
        board.rotateBy(id, key === 'q' || (key === 'r' && event.shiftKey) ? step : -step);
        event.preventDefault();
        return;
      }
      if (held) return;
      const handled = (() => {
        switch (event.key) {
          case 'f': case 'F': {
            const item = board.getSnapshot().items.find((entry) => entry.id === id);
            if (item) board.update(id, { flipped: !item.flipped });
            board.settle(id);
            return true;
          }
          case 'Delete': case 'Backspace': board.remove(id); return true;
          case 'ArrowLeft': board.nudge(id, -1, 0); return true;
          case 'ArrowRight': board.nudge(id, 1, 0); return true;
          case 'ArrowUp': board.nudge(id, 0, 1); return true;
          case 'ArrowDown': board.nudge(id, 0, -1); return true;
          default: return false;
        }
      })();
      if (handled) event.preventDefault();
    };
    // Capture phase: while the board is open its history owns these keys, so
    // the editor and lighting shortcuts underneath never see them.
    const onHistoryKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) board.undo();
      else if (key === 'y' || (key === 'z' && event.shiftKey)) board.redo();
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onHistoryKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onHistoryKey, { capture: true });
    };
  }, [board]);

  // Stable props keep the tray and the settings sections from re-rendering on
  // every frame of a drag or rotation.
  const trayWeapons = useMemo(() => (selectedKit
    ? selectedKit.weapons.map((key) => manifest.weapons.find((weapon) => weapon.key === key)).filter((weapon) => !!weapon)
    : []), [manifest, selectedKit]);
  const placedCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of snapshot.items) {
      if (item.paint.kitId === selectedKit?.id && !item.part) counts[item.weaponKey] = (counts[item.weaponKey] ?? 0) + 1;
    }
    return counts;
  }, [selectedKit, snapshot.items]);
  // New weapons start with the viewer's wear, team and seed, then keep their own.
  const trayPaint = useMemo<ShowcasePaint | null>(() => (selectedKit
    ? { kitId: selectedKit.id, kitName: selectedKit.name, team: props.team, wearIndex: props.wearIndex, seed: props.seed }
    : null), [selectedKit, props.team, props.wearIndex, props.seed]);
  const warning = snapshot.pending?.problem ? describeProblem(snapshot.pending.problem) : null;
  const outputWidth = settings.outputWidth;
  const exportPng = useCallback(async () => {
    if (board) downloadBlob(await board.exportPng(outputWidth), 'showcase.png');
  }, [board, outputWidth]);
  const copyPng = useCallback(async () => {
    if (!board) return;
    const blob = await board.exportPng(outputWidth);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }, [board, outputWidth]);
  const changeSettings = useCallback((patch: Partial<ShowcaseSettings>) => setSettings((current) => ({ ...current, ...patch })), []);

  return (
    <div className="showcase">
      <div className="showcase-stage">
        <canvas ref={canvasRef} className="showcase-canvas" />
        {board && selected && !snapshot.dragging && (
          <>
            <ShowcaseGizmo board={board} item={selected} snap={settings.rotationSnap} />
            {settings.poseHandles && <ShowcasePoseHandles board={board} item={selected} />}
          </>
        )}
        {warning && <div className="showcase-warning" role="status">{warning}</div>}
        <ShowcaseToolbar board={board} onClose={onClose} hasItems={snapshot.items.length > 0}
          canUndo={snapshot.canUndo} canRedo={snapshot.canRedo} onSave={exportPng} onCopy={copyPng} />
      </div>
      <ShowcaseTray board={board} paint={trayPaint} weapons={trayWeapons} placedCounts={placedCounts} />
      {inspectorEl && createPortal(
        <ShowcasePanel board={board} manifest={manifest} paintkits={props.paintkits} snapshot={snapshot} selected={selected}
          kit={selectedKit} paint={trayPaint}
          settings={settings} onSettingsChange={changeSettings}
          onSave={exportPng} onCopy={copyPng} rotationStep={rotationStep} />,
        inspectorEl,
      )}
    </div>
  );
}

const noopSubscribe = () => () => undefined;
const emptySnapshot = () => EMPTY_SNAPSHOT;

/** The weapons of the selected paint. */
const ShowcaseTray = memo(function ShowcaseTray({ board, paint, weapons, placedCounts }: {
  board: ShowcaseBoard | null;
  paint: ShowcasePaint | null;
  weapons: readonly WeaponEntry[];
  placedCounts: Readonly<Record<string, number>>;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? weapons.filter((weapon) => weapon.name.toLowerCase().includes(needle)) : weapons;
  }, [query, weapons]);

  const onCardPointerDown = (weapon: WeaponEntry) => (event: ReactPointerEvent<HTMLButtonElement>) => {
    const row = rowRef.current;
    if (!board || !paint || !row || event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY, scroll: row.scrollLeft };
    const trayTop = row.getBoundingClientRect().top;
    let mode: 'pending' | 'scroll' | 'place' = 'pending';
    const move = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - start.x;
      const dy = moveEvent.clientY - start.y;
      // Upward is a pick-up, sideways inside the row is a scroll, and a scroll
      // that leaves the row upward turns into a pick-up after all.
      const leftUpward = moveEvent.clientY < trayTop;
      if (mode !== 'place' && (leftUpward || (mode === 'pending' && dy <= -TRAY_DRAG_THRESHOLD && -dy >= Math.abs(dx) * 0.5))) {
        mode = 'place';
        void board.beginExternalDrag(weapon.key, paint, moveEvent.clientX, moveEvent.clientY);
        return;
      }
      if (mode === 'pending' && Math.abs(dx) >= TRAY_DRAG_THRESHOLD) mode = 'scroll';
      if (mode === 'scroll') row.scrollLeft = start.scroll - dx;
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (mode === 'pending') void board.addAt(weapon.key, paint);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="showcase-tray">
      <div className="search-field showcase-tray-search">
        <Search className="search-field-icon" size={14} />
        <TextField value={query} onChange={setQuery} placeholder="Search weapons"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) setQuery('');
          }} />
        {query.length > 0 && (
          <button type="button" className="search-clear-btn" title="Clear search" aria-label="Clear search" onClick={() => setQuery('')}>
            <X size={13} />
          </button>
        )}
      </div>
      <div
        ref={rowRef}
        className="showcase-tray-items"
        onWheel={(event) => {
          if (event.deltaY && rowRef.current) rowRef.current.scrollLeft += event.deltaY;
        }}
      >
        {shown.map((weapon) => {
          const count = placedCounts[weapon.key] ?? 0;
          return (
            <button
              key={weapon.key}
              type="button"
              className="showcase-tray-item"
              title={weapon.name}
              onPointerDown={onCardPointerDown(weapon)}
            >
              {weapon.icon ? <img src={joinData(weapon.icon)} alt="" draggable={false} /> : <span className="showcase-tray-noicon" />}
              <span className="showcase-tray-name">{weapon.name}</span>
              {isRigged(weapon.key) && <SlidersHorizontal size={11} className="showcase-tray-posable" aria-label="Has pose options" />}
              {count > 0 && <span className="showcase-tray-count">{count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
});


function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = (action: () => Promise<void>) => async () => {
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      console.error('[showcase] action failed', cause);
    } finally {
      setBusy(false);
    }
  };
  return [busy, run] as const;
}

function ShowcaseToolbar({ board, onClose, hasItems, canUndo, canRedo, onSave, onCopy }: {
  board: ShowcaseBoard | null;
  onClose: () => void;
  hasItems: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
}) {
  const [busy, run] = useBusy();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  return (
    <>
      <div className="stage-toolbar">
        <button type="button" className="stage-toolbar-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo}
          onClick={() => board?.undo()}>
          <Undo2 size={15} />
        </button>
        <button type="button" className="stage-toolbar-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!canRedo}
          onClick={() => board?.redo()}>
          <Redo2 size={15} />
        </button>
        <span className="stage-toolbar-divider" aria-hidden="true" />
        <button type="button" className="stage-toolbar-btn" title="Save PNG" aria-label="Save PNG" disabled={busy || !hasItems} onClick={run(onSave)}>
          <ImageDown size={15} />
        </button>
        <button type="button" className="stage-toolbar-btn" title="Copy image" aria-label="Copy image" disabled={busy || !hasItems} onClick={run(onCopy)}>
          <Copy size={15} />
        </button>
        <span className="stage-toolbar-divider" aria-hidden="true" />
        <button type="button" className="stage-toolbar-btn" title="Clear board" aria-label="Clear board" disabled={!hasItems}
          onClick={() => board?.clear()}>
          <Trash2 size={15} />
        </button>
        <span className="stage-toolbar-divider" aria-hidden="true" />
        <button ref={helpTriggerRef} type="button" className="stage-toolbar-btn stage-toolbar-help" title="Controls" aria-label="Open controls reference"
          aria-haspopup="dialog" aria-expanded={helpOpen} onClick={() => setHelpOpen(true)}>
          <HelpCircle size={15} />
        </button>
        <button type="button" className="stage-toolbar-btn" title="Back to the viewer" aria-label="Close showcase board" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      <ControlsHelpModal open={helpOpen} editingMode="showcase" onClose={closeHelp} returnFocusRef={helpTriggerRef} />
    </>
  );
}

/** A collapsible panel section, optionally with a button that returns its settings to the defaults. */
function Section({ title, children, onReset, canReset = false, aside, onClose }: {
  title: string;
  children: ReactNode;
  onReset?: () => void;
  canReset?: boolean;
  aside?: ReactNode;
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(true);
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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="showcase-row">
      <span className="showcase-row-label">{label}</span>
      <div className="showcase-row-control">{children}</div>
    </div>
  );
}

function SliderRow({ label, value, children }: { label: string; value: ReactNode; children: ReactNode }) {
  return (
    <div className="showcase-slider">
      <div className="showcase-slider-head">
        <span>{label}</span>
        <span className="showcase-slider-value">{value}</span>
      </div>
      {children}
    </div>
  );
}

/** A short set of choices as one row of buttons, styled like the viewer's team toggle. */
function Segmented<T extends string | number>({ label, value, options, onChange }: {
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

const ZERO_MARK = [0];
const HUNDRED_MARK = [100];

/** A slider row that only re-renders when its own value changes. */
const ValueSlider = memo(function ValueSlider({ label, display, value, min, max, step, markers, onChange, onCommit }: {
  label: string;
  display: string;
  value: number;
  min: number;
  max: number;
  step: number;
  markers?: readonly number[];
  onChange: (value: number) => void;
  onCommit?: (value: number) => void;
}) {
  return (
    <SliderRow label={label} value={display}>
      <SliderField value={value} min={min} max={max} step={step} ariaLabel={label} markers={markers} onChange={onChange} onCommit={onCommit} />
    </SliderRow>
  );
});

/** A percentage typed into a slider row. */
function PercentInput({ value, min, max, label, onCommit }: {
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
function LightPad({ azimuth, elevation, onChange }: { azimuth: number; elevation: number; onChange: (azimuth: number, elevation: number) => void }) {
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

/**
 * Placed weapons, front first like an image editor's layers. Once weapons may
 * overlap, dragging a row's handle changes what covers what; while they are
 * kept apart the order cannot show, so the list is just for picking and hiding.
 */
function LayerList({ board, manifest, items, selectedId, problems, reorderable, grades }: {
  board: ShowcaseBoard | null;
  manifest: Manifest;
  grades: ReadonlyMap<number, Grade | undefined>;
  items: readonly ShowcaseItem[];
  selectedId: string | null;
  problems: Readonly<Record<string, FitProblem>>;
  reorderable: boolean;
}) {
  const [drag, setDrag] = useState<{ id: string; from: number; to: number } | null>(null);
  // Front first: the last item on the board is drawn on top.
  const layers = useMemo(() => [...items].reverse(), [items]);
  const icons = useMemo(() => new Map(manifest.weapons.map((weapon) => [weapon.key, weapon.icon])), [manifest]);
  const countRef = useRef(layers.length);
  useEffect(() => {
    countRef.current = layers.length;
  }, [layers.length]);

  const onHandleDown = useCallback((id: string, from: number, event: ReactPointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startY = event.clientY;
    let to = from;
    setDrag({ id, from, to });
    const move = (moveEvent: PointerEvent) => {
      to = Math.max(0, Math.min(countRef.current - 1, from + Math.round((moveEvent.clientY - startY) / LAYER_ROW_HEIGHT)));
      setDrag({ id, from, to });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDrag(null);
      // Rows run front to back; the board stores back to front.
      if (to !== from) board?.reorder(id, countRef.current - 1 - to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [board]);

  if (!layers.length) return null;
  return (
    <ol className="showcase-layers" style={{ '--layer-h': `${LAYER_ROW_HEIGHT}px` } as CSSProperties}>
      {layers.map((item, index) => {
        const offset = drag?.id === item.id
          ? (drag.to - drag.from) * LAYER_ROW_HEIGHT
          : drag && index > drag.from && index <= drag.to ? -LAYER_ROW_HEIGHT
            : drag && index < drag.from && index >= drag.to ? LAYER_ROW_HEIGHT : 0;
        return (
          <LayerRow key={item.id} board={board} item={item} index={index} icon={icons.get(item.weaponKey)} grade={grades.get(item.paint.kitId)}
            selected={item.id === selectedId} problem={!!problems[item.id]} reorderable={reorderable}
            offset={offset} dragging={drag?.id === item.id} onHandleDown={onHandleDown} />
        );
      })}
    </ol>
  );
}

const GRIP_ICON = <GripVertical size={13} />;
const EYE_ICON = <Eye size={13} />;
const EYE_OFF_ICON = <EyeOff size={13} />;

/** One layer; rows whose weapon did not change skip re-rendering. */
const LayerRow = memo(function LayerRow({ board, item, index, icon, grade, selected, problem, reorderable, offset, dragging, onHandleDown }: {
  board: ShowcaseBoard | null;
  item: ShowcaseItem;
  index: number;
  icon: string | undefined;
  grade: Grade | undefined;
  selected: boolean;
  problem: boolean;
  reorderable: boolean;
  offset: number;
  dragging: boolean;
  onHandleDown: (id: string, from: number, event: ReactPointerEvent<HTMLSpanElement>) => void;
}) {
  return (
    <li
      className="showcase-layer"
      data-selected={selected || undefined}
      data-hidden={item.hidden || undefined}
      data-dragging={dragging || undefined}
      data-problem={problem || undefined}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
      onClick={() => !item.hidden && board?.select(item.id)}
    >
      {reorderable && (
        <span className="showcase-layer-handle" title="Drag to change the order" onPointerDown={(event) => onHandleDown(item.id, index, event)}>
          {GRIP_ICON}
        </span>
      )}
      {icon ? <img src={joinData(icon)} alt="" draggable={false} /> : <span className="showcase-layer-noicon" />}
      <span className="showcase-layer-text">
        <span className="showcase-layer-name">{item.weaponName}</span>
        <span className="showcase-layer-paint showcase-paint-name" data-grade={grade}>{item.paint.kitName}</span>
      </span>
      <button type="button" className="showcase-layer-eye" title={item.hidden ? 'Show' : 'Hide'}
        aria-label={item.hidden ? `Show ${item.weaponName}` : `Hide ${item.weaponName}`}
        onClick={(event) => {
          event.stopPropagation();
          board?.setHidden(item.id, !item.hidden);
        }}>
        {item.hidden ? EYE_OFF_ICON : EYE_ICON}
      </button>
    </li>
  );
});

const settingsChanged = (settings: ShowcaseSettings, keys: SettingKeys) => keys.some((key) => settings[key] !== DEFAULT_SETTINGS[key]);
const defaultsFor = (keys: SettingKeys): Partial<ShowcaseSettings> => Object.fromEntries(keys.map((key) => [key, DEFAULT_SETTINGS[key]]));

function ShowcasePanel({ board, manifest, paintkits, kit, paint, snapshot, selected, settings, onSettingsChange, onSave, onCopy, rotationStep }: {
  board: ShowcaseBoard | null;
  manifest: Manifest;
  paintkits: readonly PaintkitEntry[];
  kit: PaintkitEntry | null;
  paint: ShowcasePaint | null;
  snapshot: ShowcaseSnapshot;
  selected: ShowcaseItem | null;
  settings: ShowcaseSettings;
  onSettingsChange: (patch: Partial<ShowcaseSettings>) => void;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
  rotationStep: number;
}) {
  const problem = selected ? (snapshot.pending?.id === selected.id ? snapshot.pending.problem : snapshot.problems[selected.id]) : null;
  const setPoseHandles = useCallback((poseHandles: boolean) => onSettingsChange({ poseHandles }), [onSettingsChange]);
  const grades = useMemo(() => new Map(paintkits.map((entry) => [entry.id, entry.grade])), [paintkits]);
  // The weapon the wears and the RED and BLU pair show: the one picked, else
  // the first one placed in this paint.
  const [featured, setFeatured] = useState<string | null>(null);
  const [pairs, setPairs] = useState<readonly string[]>([]);
  const firstPlaced = snapshot.items.find((item) => item.paint.kitId === kit?.id && !item.part)?.weaponKey ?? null;
  const focus = featured && kit?.weapons.includes(featured) ? featured : firstPlaced;
  const wearCount = manifest.wearNames.length;
  const layouts = useMemo(() => (kit && paint ? boardLayouts(kit, paint, wearCount, focus, pairs) : []), [kit, paint, wearCount, focus, pairs]);
  // Picking weapons puts the layout showing them straight back on the board.
  const feature = useCallback((pick: FeaturePick, layoutId: string) => {
    const nextFocus = pick.weapon ?? focus;
    const nextPairs = pick.pairs ?? pairs;
    if (pick.weapon) setFeatured(pick.weapon);
    if (pick.pairs) setPairs(pick.pairs);
    return kit && paint ? boardLayouts(kit, paint, wearCount, nextFocus, nextPairs).find((layout) => layout.id === layoutId) : undefined;
  }, [kit, paint, wearCount, focus, pairs]);
  const featureOptions = useMemo(() => (kit?.weapons ?? []).flatMap((key) => {
    const weapon = manifest.weapons.find((entry) => entry.key === key);
    return weapon && key !== 'paintkit_tool' ? [{ value: key, label: weapon.name, icon: weapon.icon ? joinData(weapon.icon) : null }] : [];
  }), [kit, manifest]);
  return (
    <div className="showcase-panel">
      <LayersSection board={board} manifest={manifest} items={snapshot.items} selectedId={snapshot.selectedId}
        problems={snapshot.problems} reorderable={!settings.keepApart} grades={grades} />
      {selected && board && (
        <WeaponSection board={board} item={selected} problem={problem ?? null} rotationSnap={settings.rotationSnap} rotationStep={rotationStep}
          kit={paintkits.find((kit) => kit.id === selected.paint.kitId) ?? null} wearNames={manifest.wearNames}
          poseHandles={settings.poseHandles} onPoseHandlesChange={setPoseHandles} />
      )}
      {/* Board-wide settings step aside while a weapon is being edited. */}
      {!selected && (
        <>
          {board && layouts.length > 0 && <LayoutsSection board={board} layouts={layouts} featureOptions={featureOptions} onFeature={feature} />}
          <PlacementSection settings={settings} onChange={onSettingsChange} />
          <LookSection settings={settings} onChange={onSettingsChange} />
          <ExportSection board={board} settings={settings} onChange={onSettingsChange} hasItems={snapshot.items.length > 0}
            onSave={onSave} onCopy={onCopy} />
        </>
      )}
    </div>
  );
}

/** Ready-made arrangements of the current paint, each drawn as a small sketch. */
const LayoutsSection = memo(function LayoutsSection({ board, layouts, featureOptions, onFeature }: {
  board: ShowcaseBoard;
  layouts: readonly BoardLayout[];
  featureOptions: IconOption[];
  /** Feature other weapons; returns the layout `layoutId` becomes with them. */
  onFeature: (pick: FeaturePick, layoutId: string) => BoardLayout | undefined;
}) {
  const [busy, run] = useBusy();
  // The weapon picker belongs to the wears and the RED and BLU pair, so it
  // shows once one of those is on the board.
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const applied = appliedId && FEATURE_LAYOUTS.has(appliedId) ? layouts.find((layout) => layout.id === appliedId) : undefined;
  const featured = applied?.rows[0]?.[0]?.weaponKey;
  const reapply = (pick: FeaturePick) => {
    const layout = applied && onFeature(pick, applied.id);
    if (layout) void apply(layout)();
  };
  const apply = (layout: BoardLayout) => run(async () => {
    setAppliedId(layout.id);
    await board.applyLayout(layout.rows, layout.pack, layout.inward, layout.upright);
  });
  return (
    <Section title="Layouts">
      <div className="showcase-layouts">
        {layouts.map((layout) => (
          <button key={layout.id} type="button" className="showcase-layout" disabled={busy}
            title={`${layout.label}: replaces the board (Ctrl+Z brings it back)`}
            onPointerEnter={() => board.preload(layout.rows)} onFocus={() => board.preload(layout.rows)}
            onClick={apply(layout)}>
            <LayoutSketch rows={layout.rows} />
            <span>{layout.label}</span>
          </button>
        ))}
      </div>
      {applied?.id === 'wears' && featured && featureOptions.length > 1 && (
        <SliderRow label="Weapon for Wears" value={null}>
          <IconSelectField value={featured} options={featureOptions} ariaLabel="Weapon for Wears" searchPlaceholder="Filter weapons..."
            onChange={(weapon) => reapply({ weapon })} />
        </SliderRow>
      )}
      {applied?.id === 'teams' && featureOptions.length > 1 && (
        <PairPicker picked={applied.rows.map((row) => row[0].weaponKey)} options={featureOptions} onChange={(pairs) => reapply({ pairs })} />
      )}
    </Section>
  );
});

const FEATURE_LAYOUTS = new Set(['wears', 'teams']);

/** A new weapon for the wears, or the weapons RED and BLU pair up. */
type FeaturePick = { weapon?: string; pairs?: readonly string[] };

/** Up to three weapons for RED and BLU, each shown as a pair. */
function PairPicker({ picked, options, onChange }: {
  picked: readonly string[];
  options: IconOption[];
  onChange: (pairs: readonly string[]) => void;
}) {
  const choices = (current: string | null) => options.filter((option) => option.value === current || !picked.includes(option.value));
  return (
    <SliderRow label="Weapons for RED and BLU" value={`${picked.length} of ${TEAM_PAIR_LIMIT}`}>
      <div className="showcase-pairs">
        {picked.map((weaponKey, index) => (
          <div key={weaponKey} className="showcase-pair">
            <IconSelectField value={weaponKey} options={choices(weaponKey)} ariaLabel={`RED and BLU weapon ${index + 1}`} searchPlaceholder="Filter weapons..."
              onChange={(next) => onChange(picked.map((key, at) => (at === index ? next : key)))} />
            {picked.length > 1 && (
              <button type="button" className="showcase-btn" title="Remove" aria-label={`Remove ${options.find((option) => option.value === weaponKey)?.label ?? 'weapon'}`}
                onClick={() => onChange(picked.filter((_, at) => at !== index))}>
                <X size={13} />
              </button>
            )}
          </div>
        ))}
        {picked.length < TEAM_PAIR_LIMIT && (
          <IconSelectField value="" placeholder="Add weapon" options={choices(null)} ariaLabel="Add a RED and BLU weapon" searchPlaceholder="Filter weapons..."
            onChange={(next) => onChange([...picked, next])} />
        )}
      </div>
    </SliderRow>
  );
}
const SKETCH = { width: 64, height: 36 };

function LayoutSketch({ rows }: { rows: LayoutRows }) {
  const mixedTeams = rows.some((row) => row.some((entry) => entry.paint.team !== rows[0][0]?.paint.team));
  return (
    <svg viewBox={`0 0 ${SKETCH.width} ${SKETCH.height}`} aria-hidden="true">
      {rows.flatMap((row, rowIndex) => {
        const y = (SKETCH.height * (rowIndex + 1)) / (rows.length + 1);
        const pitch = SKETCH.width / row.length;
        return row.map((slot, index) => {
          const length = Math.min(pitch * 0.7, SKETCH.width * 0.6);
          const thickness = Math.min(4, (SKETCH.height / (rows.length + 1)) * 0.55);
          const x = pitch * (index + 0.5);
          const team = mixedTeams ? slot.paint.team : null;
          return (
            <rect key={`${rowIndex}-${index}`} x={x - length / 2} y={y - thickness / 2} width={length} height={thickness} rx={1}
              data-team={team ?? undefined} />
          );
        });
      })}
    </svg>
  );
}

const LayersSection = memo(function LayersSection({ board, manifest, items, selectedId, problems, reorderable, grades }: {
  board: ShowcaseBoard | null;
  manifest: Manifest;
  items: readonly ShowcaseItem[];
  selectedId: string | null;
  problems: Readonly<Record<string, FitProblem>>;
  reorderable: boolean;
  grades: ReadonlyMap<number, Grade | undefined>;
}) {
  return (
    <Section title={reorderable ? 'Layers' : 'Weapons'} aside={<span className="showcase-section-count">{items.length}</span>}>
      <LayerList board={board} manifest={manifest} items={items} selectedId={selectedId} problems={problems} reorderable={reorderable} grades={grades} />
    </Section>
  );
});

const ROTATE_CCW_ICON = <RotateCcw size={13} />;
const ROTATE_CW_ICON = <RotateCw size={13} />;
const FLIP_ICON = <FlipHorizontal2 size={13} />;
const DUPLICATE_ICON = <CopyPlus size={13} />;
const REMOVE_ICON = <Trash2 size={13} />;

const WeaponSection = memo(function WeaponSection({ board, item, problem, rotationSnap, rotationStep, poseHandles, onPoseHandlesChange, kit, wearNames }: {
  board: ShowcaseBoard;
  item: ShowcaseItem;
  kit: PaintkitEntry | null;
  wearNames: readonly string[];
  problem: FitProblem;
  rotationSnap: number;
  rotationStep: number;
  poseHandles: boolean;
  onPoseHandlesChange: (shown: boolean) => void;
}) {
  const { id } = item;
  // Handlers depend only on the weapon's id, so a rotation re-renders just the
  // slider whose value moved.
  const poseRef = useRef(item.pose);
  useEffect(() => {
    poseRef.current = item.pose;
  }, [item.pose]);
  const settle = useCallback(() => board.settle(id), [board, id]);
  const setRoll = useCallback((roll: number) => board.update(id, { roll }), [board, id]);
  const setTilt = useCallback((tilt: number) => board.update(id, { tilt }), [board, id]);
  const setTurn = useCallback((turn: number) => board.update(id, { turn }), [board, id]);
  const setSize = useCallback((value: number) => board.update(id, { scale: value / 100 }), [board, id]);
  const typeSize = useCallback((value: number) => { board.update(id, { scale: value / 100 }); board.settle(id); }, [board, id]);
  const setPose = useCallback((key: string, value: number) => board.update(id, { pose: { ...poseRef.current, [key]: value } }), [board, id]);
  const rig = item.part ? undefined : POSE_RIGS[item.weaponKey];
  const parts = item.part ? [] : WEAPON_PARTS[item.weaponKey] ?? [];
  const size = Math.round(item.scale * 100);
  const restPose = item.part ? {} : defaultPose(item.weaponKey);
  const restRoll = restingRoll(item.weaponKey, item.part);
  const changed = item.roll !== restRoll || item.tilt !== 0 || item.turn !== 0 || item.flipped || item.scale !== 1
    || JSON.stringify(item.pose) !== JSON.stringify(restPose);
  return (
    <Section
      // The highlighted layer row already shows the name and paint; the header
      // keeps the name in view when that list is collapsed or scrolled away.
      title={item.weaponName}
      onClose={() => board.select(null)}
      canReset={changed}
      onReset={() => {
        board.update(id, { roll: restRoll, tilt: 0, turn: 0, flipped: false, scale: 1, pose: restPose });
        board.settle(id);
      }}
    >
      {problem && <span className="showcase-fit">{describeProblem(problem)}</span>}
      <PaintRows board={board} id={id} paint={item.paint} kit={kit} wearNames={wearNames} />
      <div className="showcase-subheading">Transform</div>
      <ValueSlider label="Roll" display={`${item.roll}°`} value={item.roll} min={-180} max={180} step={rotationSnap || 1}
        markers={ZERO_MARK} onChange={setRoll} onCommit={settle} />
      <ValueSlider label="Tilt" display={`${item.tilt}°`} value={item.tilt} min={-TILT_LIMIT} max={TILT_LIMIT} step={1}
        markers={ZERO_MARK} onChange={setTilt} onCommit={settle} />
      <ValueSlider label="Turn" display={`${item.turn}°`} value={item.turn} min={-TILT_LIMIT} max={TILT_LIMIT} step={1}
        markers={ZERO_MARK} onChange={setTurn} onCommit={settle} />
      <SizeSlider size={size} onChange={setSize} onCommit={settle} onType={typeSize} />
      {rig && (
        <>
          <div className="showcase-subheading">Pose</div>
          {rig.controls.map((control) => (
            <PoseSlider key={control.id} control={control} value={item.pose[control.id] ?? control.defaultValue} onPose={setPose} onCommit={settle} />
          ))}
          {rig.controls.some((control) => control.handle) && (
            <Row label="Handles on the weapon">
              <SwitchField checked={poseHandles} onChange={onPoseHandlesChange} ariaLabel="Handles on the weapon" />
            </Row>
          )}
        </>
      )}
      {parts.length > 0 && (
        <>
          <div className="showcase-subheading">Parts</div>
          {parts.map((part) => {
            const shown = !part.loose && !item.hiddenParts.includes(part.id);
            return (
              <div key={part.id} className="showcase-part">
                <span className="showcase-part-name">{part.label}</span>
                {!part.loose && (
                  <button type="button" className="showcase-layer-eye" aria-pressed={shown}
                    title={shown ? `Leave the ${part.label.toLowerCase()} out` : `Put the ${part.label.toLowerCase()} back`}
                    onClick={() => board.setPartShown(id, part.id, !shown)}>
                    {shown ? EYE_ICON : EYE_OFF_ICON}
                  </button>
                )}
                <button type="button" className="showcase-btn" title={`Place the ${part.label.toLowerCase()} on the board by itself`}
                  onClick={() => void board.pullOutPart(id, part.id)}>
                  <PackageOpen size={13} /> Take out
                </button>
              </div>
            );
          })}
        </>
      )}
      <div className="showcase-actions">
        <button type="button" className="showcase-btn" title={`Rotate ${rotationStep}° counterclockwise (Q)`}
          onClick={() => board.rotateBy(id, rotationStep)}>{ROTATE_CCW_ICON}</button>
        <button type="button" className="showcase-btn" title={`Rotate ${rotationStep}° clockwise (E)`}
          onClick={() => board.rotateBy(id, -rotationStep)}>{ROTATE_CW_ICON}</button>
        <button type="button" className="showcase-btn" title="Show the other side (F)"
          onClick={() => { board.update(id, { flipped: !item.flipped }); board.settle(id); }}>{FLIP_ICON}</button>
        <button type="button" className="showcase-btn" title="Duplicate" onClick={() => void board.duplicate(id)}>{DUPLICATE_ICON}</button>
        <span className="showcase-actions-spacer" />
        <button type="button" className="showcase-btn showcase-btn-danger" title="Remove (Delete)" onClick={() => board.remove(id)}>{REMOVE_ICON}</button>
      </div>
    </Section>
  );
});

/** Wear, team and pattern seed of one weapon; only the ones its paint varies by. */
const PaintRows = memo(function PaintRows({ board, id, paint, kit, wearNames }: {
  board: ShowcaseBoard;
  id: string;
  paint: ShowcasePaint;
  kit: PaintkitEntry | null;
  wearNames: readonly string[];
}) {
  const [seedDraft, setSeedDraft] = useState<string | null>(null);
  const commitSeed = () => {
    const seed = (seedDraft ?? '').trim();
    setSeedDraft(null);
    // Seeds are unsigned 64-bit integers, as in the viewer.
    if (/^\d+$/.test(seed) && BigInt(seed) < 2n ** 64n && seed !== paint.seed) board.setPaint(id, { seed: BigInt(seed).toString() });
  };
  return (
    <>
      {kit?.perWear && (
        <SliderRow label="Wear" value={wearNames[paint.wearIndex]}>
          <WearSliderField value={paint.wearIndex} names={wearNames}
            onChange={(wearIndex) => { if (wearIndex !== paint.wearIndex) board.setPaint(id, { wearIndex }); }} />
        </SliderRow>
      )}
      {kit?.hasTeamTextures && (
        <SliderRow label="Team" value={null}>
          <TeamToggle team={paint.team} onChange={(team) => { if (team !== paint.team) board.setPaint(id, { team }); }} />
        </SliderRow>
      )}
      <Row label="Seed">
        <span className="showcase-seed">
          <input
            className="ui-input showcase-seed-input"
            inputMode="numeric"
            aria-label="Pattern seed"
            value={seedDraft ?? paint.seed}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setSeedDraft(event.currentTarget.value.replace(/\D/g, ''))}
            onBlur={commitSeed}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') {
                setSeedDraft(null);
                event.currentTarget.blur();
              }
            }}
          />
          <button type="button" className="showcase-btn" title="Random seed" aria-label="Random seed"
            onClick={() => board.setPaint(id, { seed: randomSeed() })}>
            <Dices size={13} />
          </button>
        </span>
      </Row>
    </>
  );
});

const SizeSlider = memo(function SizeSlider({ size, onChange, onCommit, onType }: {
  size: number;
  onChange: (value: number) => void;
  onCommit: () => void;
  onType: (value: number) => void;
}) {
  return (
    <SliderRow label="Size" value={<PercentInput value={size} min={SIZE_TYPED.min} max={SIZE_TYPED.max} label="Size in percent" onCommit={onType} />}>
      <SliderField value={Math.min(SIZE_SLIDER.max, Math.max(SIZE_SLIDER.min, size))} min={SIZE_SLIDER.min} max={SIZE_SLIDER.max}
        step={5} ariaLabel="Size" markers={HUNDRED_MARK} onChange={onChange} onCommit={onCommit} />
    </SliderRow>
  );
});

const PoseSlider = memo(function PoseSlider({ control, value, onPose, onCommit }: {
  control: PoseControl;
  value: number;
  onPose: (key: string, value: number) => void;
  onCommit: () => void;
}) {
  const onChange = useCallback((next: number) => onPose(control.id, snapPose(control, next)), [control, onPose]);
  const marks = useMemo(() => snapMarks(control), [control]);
  return (
    <ValueSlider label={control.label} display={`${value}${control.unit}`} value={value} min={control.min} max={control.max}
      step={control.step} markers={marks} onChange={onChange} onCommit={onCommit} />
  );
});

type SettingsSectionProps = { settings: ShowcaseSettings; onChange: (patch: Partial<ShowcaseSettings>) => void };

const PlacementSection = memo(function PlacementSection({ settings, onChange: set }: SettingsSectionProps) {
  return (
    <Section title="Placement" canReset={settingsChanged(settings, PLACEMENT_KEYS)} onReset={() => set(defaultsFor(PLACEMENT_KEYS))}>
      <Row label="Snap to grid">
        <SwitchField checked={settings.snapToGrid} onChange={(snapToGrid) => set({ snapToGrid })} ariaLabel="Snap to grid" />
      </Row>
      {settings.snapToGrid && (
        <SliderRow label="Grid size" value={null}>
          <Segmented label="Grid size" value={settings.grid} onChange={(grid) => set({ grid })}
            options={[{ value: 'fine', label: 'Fine' }, { value: 'normal', label: 'Normal' }, { value: 'coarse', label: 'Coarse' }]} />
        </SliderRow>
      )}
      <Row label="Keep weapons apart">
        <SwitchField checked={settings.keepApart} onChange={(keepApart) => set({ keepApart })} ariaLabel="Keep weapons apart" />
      </Row>
      {settings.keepApart && (
        <SliderRow label="Spacing" value={`${settings.spacing} ${settings.spacing === 1 ? 'cell' : 'cells'}`}>
          <SliderField value={settings.spacing} min={0} max={4} step={1} ariaLabel="Spacing" onChange={(spacing) => set({ spacing })} />
        </SliderRow>
      )}
      <Row label="Keep inside the board">
        <SwitchField checked={settings.keepInside} onChange={(keepInside) => set({ keepInside })} ariaLabel="Keep inside the board" />
      </Row>
      <SliderRow label="Rotation snap" value={null}>
        <Segmented label="Rotation snap" value={settings.rotationSnap} onChange={(rotationSnap) => set({ rotationSnap })}
          options={ROTATION_SNAPS.map((degrees) => ({ value: degrees, label: degrees ? `${degrees}°` : 'Free' }))} />
      </SliderRow>
      <Row label="Show footprints">
        <SwitchField checked={settings.showFootprints} onChange={(showFootprints) => set({ showFootprints })} ariaLabel="Show footprints" />
      </Row>
    </Section>
  );
});

const LookSection = memo(function LookSection({ settings, onChange: set }: SettingsSectionProps) {
  return (
    <Section title="Look" canReset={settingsChanged(settings, LOOK_KEYS)} onReset={() => set(defaultsFor(LOOK_KEYS))}>
      <Row label="Light">
        <LightPad azimuth={settings.lightAzimuth} elevation={settings.lightElevation}
          onChange={(lightAzimuth, lightElevation) => set({ lightAzimuth, lightElevation })} />
      </Row>
      <Row label="Shadows">
        <SwitchField checked={settings.shadows} onChange={(shadows) => set({ shadows })} ariaLabel="Shadows" />
      </Row>
      {settings.shadows && (
        <SliderRow label="Shadow strength" value={`${settings.shadow}%`}>
          <SliderField value={settings.shadow} min={0} max={100} step={5} ariaLabel="Shadow strength" onChange={(shadow) => set({ shadow })} />
        </SliderRow>
      )}
      <SliderRow label="Background" value={null}>
        <Segmented label="Background" value={settings.background} onChange={(background) => set({ background })}
          options={[
            { value: 'framed', label: 'Framed' },
            { value: 'pegboard', label: 'Pegboard' },
            { value: 'transparent', label: 'Transparent' },
          ]} />
      </SliderRow>
    </Section>
  );
});

const ExportSection = memo(function ExportSection({ board, settings, onChange: set, hasItems, onSave, onCopy }: SettingsSectionProps & {
  board: ShowcaseBoard | null;
  hasItems: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
}) {
  const [busy, run] = useBusy();
  return (
    <Section title="Export" canReset={settingsChanged(settings, EXPORT_KEYS)} onReset={() => set(defaultsFor(EXPORT_KEYS))}>
      <Row label="Resolution">
        <SelectField value={String(settings.outputWidth)} onChange={(value) => set({ outputWidth: Number(value) })}
          options={OUTPUT_WIDTHS.map((width) => {
            const size = board?.outputSize(width) ?? { width, height: Math.round(width * 9 / 16) };
            return { value: String(width), label: `${size.width} × ${size.height}` };
          })} />
      </Row>
      <div className="showcase-export-actions">
        <button type="button" className="showcase-btn showcase-btn-primary" disabled={busy || !hasItems} onClick={run(onSave)}>
          <ImageDown size={13} /> Save PNG
        </button>
        <button type="button" className="showcase-btn" disabled={busy || !hasItems} onClick={run(onCopy)}>
          <Copy size={13} /> Copy
        </button>
      </div>
    </Section>
  );
});
