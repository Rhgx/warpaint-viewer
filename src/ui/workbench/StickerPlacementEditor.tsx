import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Braces, Copy, Expand, Eye, EyeOff, Link2, Magnet, Minus, MoreHorizontal, Move, Plus, RotateCw, Unlink2 } from 'lucide-react';
import {
  clampStickerPlacement,
  moveStickerPlacement,
  resizeStickerFromCorner,
  resizeStickerFromEdge,
  rotateStickerPlacement,
  snapStickerRotationToCardinal,
  snapStickerPlacement,
  stickerPlacementContainsPoint,
  stickerPlacementFromQuad,
  stickerPlacementToQuad,
  type StickerAffineQuad,
  type StickerCorner,
  type StickerEdge,
  type StickerPlacement,
  type StickerPoint,
} from '../../editor/stickerGeometry';
import {
  DEFAULT_STICKER_VIEWPORT,
  clampStickerViewportZoom,
  normalizeStickerViewport,
  stickerViewportPointToUv,
  zoomStickerViewportAt,
  type StickerViewport,
  type StickerViewportSize,
} from '../../editor/stickerViewport';
import {
  GroupStickerUvPreview,
  type GroupStickerPreviewSources,
} from './GroupStickerUvPreview';
import { WeaponUvSurface } from './WeaponUvSurface';
import { formatStickerValue } from './stickerValueFormat';
import './StickerPlacementEditor.css';

export type StickerPlacementChangeReason = 'move' | 'resize' | 'rotate' | 'nudge' | 'value' | 'fit';
export type StickerTransformTool = 'move' | 'scale' | 'turn';

export interface StickerSelectionTarget {
  readonly id: string;
  readonly label: string;
  readonly placement: StickerPlacement;
  readonly artworkSrc: string | null;
}

export interface StickerPlacementEditorProps {
  /** The unwrapped weapon texture the decal is positioned on. URLs may be object URLs. */
  readonly textureSrc: string | null;
  /** The decal artwork. URLs may be object URLs. */
  readonly stickerSrc: string | null;
  /** Live selector inputs for a group sticker. Its visible colour depends on placement. */
  readonly groupPreview?: GroupStickerPreviewSources | null;
  /** False when the visible block is already baked into textureSrc. */
  readonly renderStickerArtwork?: boolean;
  /** Controlled, normalized texture-space placement. */
  readonly placement: StickerPlacement;
  /** Exact authored destination coordinates, edited under the Proto mode. */
  readonly quad?: StickerAffineQuad;
  readonly onPlacementChange: (placement: StickerPlacement, reason: StickerPlacementChangeReason) => void;
  readonly onQuadChange?: (quad: StickerAffineQuad) => void;
  readonly protoVariableNames?: Partial<Record<'tl' | 'tr' | 'bl', string>>;
  /**
   * Changes when the owner selects a different sticker. The view then frames
   * that sticker, because a shallow, very wide drawer cannot show a whole
   * texture atlas and a workable decal at the same time.
   */
  readonly focusKey?: string;
  /** Lets the owner make one history item for a drag rather than one per frame. */
  readonly onInteractionStart?: () => void;
  readonly onInteractionEnd?: () => void;
  readonly onInteractionCancel?: () => void;
  readonly disabled?: boolean;
  readonly label?: string;
  /** Optional source dimensions ratio so the preview does not distort the texture. */
  readonly textureAspect?: number;
  readonly stickerAspect?: number;
  readonly notice?: string | null;
  /** Optional controlled transform mode. Omitting this keeps the control local to the editor. */
  readonly activeTool?: StickerTransformTool;
  readonly onActiveToolChange?: (tool: StickerTransformTool) => void;
  /** Keeps width and height proportional while scaling. Shift temporarily inverts it. */
  readonly aspectLocked?: boolean;
  readonly onAspectLockedChange?: (locked: boolean) => void;
  /** Optional controlled grid state. Omitting this keeps the checkbox local to the editor. */
  readonly snapEnabled?: boolean;
  readonly onSnapEnabledChange?: (enabled: boolean) => void;
  /** Fixed grid spacing in normalized UV. Omit to follow the zoom adaptively. */
  readonly snapStep?: number;
  /** Other placed stickers that can be selected directly from the UV surface. */
  readonly selectionTargets?: readonly StickerSelectionTarget[];
  readonly activeSelectionId?: string;
  readonly onSelectionChange?: (id: string) => void;
  readonly modelPartPickingActive?: boolean;
  readonly hiddenModelPartCount?: number;
  readonly onModelPartPickingChange?: (active: boolean) => void;
  readonly onRestoreHiddenModelParts?: () => void;
}

type PointerInteraction =
  | { readonly kind: 'move'; readonly initial: StickerPlacement; readonly pointer: StickerPoint }
  | { readonly kind: 'resize'; readonly initial: StickerPlacement; readonly corner: StickerCorner; readonly preserveAspect: boolean }
  | { readonly kind: 'resize-axis'; readonly initial: StickerPlacement; readonly edge: StickerEdge; readonly preserveAspect: boolean }
  | { readonly kind: 'rotate'; readonly initial: StickerPlacement }
  | { readonly kind: 'pan'; readonly initial: StickerViewport; readonly pointer: StickerPoint };

const CORNERS: readonly StickerCorner[] = ['top-left', 'top-right', 'bottom-right', 'bottom-left'];
const EDGES: readonly StickerEdge[] = ['top', 'right', 'bottom', 'left'];
const TOOLS: readonly { readonly id: StickerTransformTool; readonly label: string; readonly Icon: typeof Move }[] = [
  { id: 'move', label: 'Move', Icon: Move },
  { id: 'scale', label: 'Scale', Icon: Expand },
  { id: 'turn', label: 'Turn', Icon: RotateCw },
];

const CORNER_ROWS = [
  { corner: 'tl' as const, label: 'Top left', short: 'TL', x: 'tlX' as const, y: 'tlY' as const, field: 'dest_tl' },
  { corner: 'tr' as const, label: 'Top right', short: 'TR', x: 'trX' as const, y: 'trY' as const, field: 'dest_tr' },
  { corner: 'bl' as const, label: 'Bottom left', short: 'BL', x: 'blX' as const, y: 'blY' as const, field: 'dest_bl' },
];

/**
 * Power-of-two fractions of the texture. Halving keeps every coarser grid a
 * superset of every finer one, so zooming never moves an already-snapped edge.
 */
const SNAP_LADDER = [1 / 8, 1 / 16, 1 / 32, 1 / 64, 1 / 128, 1 / 256] as const;
/** Roughly how many grid cells should span the visible area at any zoom. */
const SNAP_CELLS_ACROSS_VIEW = 16;

/**
 * A grid fixed in texture space is drawn inside the zoomed canvas, so it grows
 * on screen as the user zooms in and a single cell can swallow the sticker.
 * Pick the ladder rung nearest a constant on-screen density instead: the grid
 * stays legible, and zooming in genuinely buys finer snapping.
 */
function adaptiveSnapStep(zoom: number): number {
  const target = 1 / (SNAP_CELLS_ACROSS_VIEW * Math.max(zoom, 0.01));
  let best: number = SNAP_LADDER[0];
  for (const step of SNAP_LADDER) {
    if (Math.abs(Math.log(step / target)) < Math.abs(Math.log(best / target))) best = step;
  }
  return best;
}

function pointerInSurface(event: Pick<React.MouseEvent<HTMLElement>, 'clientX' | 'clientY'>, surface: HTMLElement): StickerPoint {
  const bounds = surface.getBoundingClientRect();
  return {
    x: event.clientX - bounds.left,
    y: event.clientY - bounds.top,
  };
}

function surfaceSize(surface: HTMLElement): StickerViewportSize {
  const bounds = surface.getBoundingClientRect();
  return { width: Math.max(bounds.width, 1), height: Math.max(bounds.height, 1) };
}

function rotationForPointer(pointer: StickerPoint, placement: StickerPlacement): number {
  return Math.atan2(pointer.y - placement.y, pointer.x - placement.x) * (180 / Math.PI) + 90;
}

function nextNumber(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A compact, texture-space decal editor. Its placement is shared verbatim by
 * the model-side interaction, keeping 2D precision work and 3D placement in
 * lockstep without exposing implementation detail to the user.
 */
export function StickerPlacementEditor({
  textureSrc,
  stickerSrc,
  groupPreview,
  renderStickerArtwork = true,
  placement,
  quad,
  onPlacementChange,
  onQuadChange,
  protoVariableNames,
  focusKey,
  onInteractionStart,
  onInteractionEnd,
  onInteractionCancel,
  disabled = false,
  label = 'Sticker placement',
  textureAspect = 1.6,
  notice,
  activeTool,
  onActiveToolChange,
  aspectLocked,
  onAspectLockedChange,
  snapEnabled,
  onSnapEnabledChange,
  snapStep,
  selectionTargets = [],
  activeSelectionId,
  onSelectionChange,
  modelPartPickingActive = false,
  hiddenModelPartCount = 0,
  onModelPartPickingChange,
  onRestoreHiddenModelParts,
}: StickerPlacementEditorProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);
  const selectionPointerRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const pendingFrameRef = useRef(false);
  const frameRef = useRef<(() => void) | null>(null);
  const typingRef = useRef<{ timer: number | null }>({ timer: null });
  const revertRef = useRef<StickerPlacement | null>(null);
  const [internalTool, setInternalTool] = useState<StickerTransformTool>('move');
  const [internalAspectLocked, setInternalAspectLocked] = useState(true);
  // Precision work is a normal part of placing a decal, so the numbers are
  // present by default and only dismissed when the surface is wanted clear.
  const [valuesOpen, setValuesOpen] = useState(true);
  const [valueMode, setValueMode] = useState<'simple' | 'proto'>('simple');
  const [editingValue, setEditingValue] = useState<{ field: keyof StickerPlacement; text: string } | null>(null);
  const [cornerError, setCornerError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [internalSnapEnabled, setInternalSnapEnabled] = useState(false);
  const [viewport, setViewport] = useState<StickerViewport>(DEFAULT_STICKER_VIEWPORT);
  const [texturePixels, setTexturePixels] = useState<StickerViewportSize | null>(null);
  const placementValue = clampStickerPlacement(placement);
  const quadValue = quad ?? stickerPlacementToQuad(placementValue);
  const quadKey = quadValue ? [quadValue.tl, quadValue.tr, quadValue.bl].flat().join('|') : '';
  const [cornerDraft, setCornerDraft] = useState({ tlX: '', tlY: '', trX: '', trY: '', blX: '', blY: '' });
  const unavailable = disabled || (!stickerSrc && !groupPreview);
  const previousHiddenModelPartCountRef = useRef(hiddenModelPartCount);
  const [modelPartStatus, setModelPartStatus] = useState('');
  const partsControlsExpanded = modelPartPickingActive || hiddenModelPartCount > 0;
  const tool = activeTool ?? internalTool;
  const isAspectLocked = aspectLocked ?? internalAspectLocked;
  const isSnapEnabled = snapEnabled ?? internalSnapEnabled;
  const safeSnapStep = snapStep !== undefined && Number.isFinite(snapStep) && snapStep > 0
    ? Math.min(snapStep, 1)
    : adaptiveSnapStep(viewport.zoom);
  const surfaceAspect = Number.isFinite(textureAspect) ? Math.min(10, Math.max(0.1, textureAspect)) : 1.6;
  const placementStyle = (targetPlacement: StickerPlacement, zIndex: number): CSSProperties => ({
    left: `${targetPlacement.x * 100}%`,
    top: `${targetPlacement.y * 100}%`,
    width: `${targetPlacement.width * 100}%`,
    height: `${targetPlacement.height * 100}%`,
    transform: `translate(-50%, -50%) rotate(${targetPlacement.rotation}deg)`,
    zIndex,
  });

  const selectionAtPoint = (point: StickerPoint) => selectionTargets
    .map((target, index) => ({ target, index }))
    .filter(({ target }) => stickerPlacementContainsPoint(target.placement, point))
    .sort((first, second) => (
      first.target.placement.width * first.target.placement.height
      - second.target.placement.width * second.target.placement.height
      || second.index - first.index
    ))[0]?.target;

  useEffect(() => {
    const previousCount = previousHiddenModelPartCountRef.current;
    previousHiddenModelPartCountRef.current = hiddenModelPartCount;
    if (previousCount === hiddenModelPartCount) return;
    setModelPartStatus(
      `${hiddenModelPartCount} model ${hiddenModelPartCount === 1 ? 'part' : 'parts'} hidden`,
    );
  }, [hiddenModelPartCount]);

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => {
      // Re-frame rather than merely clamp while the framing is still pending,
      // otherwise a drawer that grows after mount leaves the sticker off-screen.
      if (pendingFrameRef.current && frameRef.current) {
        frameRef.current();
        return;
      }
      setViewport((current) => normalizeStickerViewport(current, surfaceSize(surface)));
    });
    observer.observe(surface);
    return () => observer.disconnect();
  }, []);

  const exitModelPartPicking = () => {
    if (!modelPartPickingActive) return;
    onModelPartPickingChange?.(false);
  };

  const emit = (next: StickerPlacement, reason: StickerPlacementChangeReason, snap = false) => {
    exitModelPartPicking();
    const limited = clampStickerPlacement(next);
    onPlacementChange(snap ? snapStickerPlacement(limited, safeSnapStep) : limited, reason);
  };

  const setTool = (nextTool: StickerTransformTool) => {
    setInternalTool(nextTool);
    onActiveToolChange?.(nextTool);
    onModelPartPickingChange?.(false);
  };

  useEffect(() => {
    if (unavailable) return;
    const onShortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable], [role="textbox"]')) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.key === 'Escape') {
        if (!modelPartPickingActive) return;
        event.preventDefault();
        onModelPartPickingChange?.(false);
        return;
      }
      const nextTool = ({ '1': 'move', '2': 'scale', '3': 'turn' } as const)[event.key as '1' | '2' | '3'];
      if (!nextTool) return;
      event.preventDefault();
      setInternalTool(nextTool);
      onActiveToolChange?.(nextTool);
      onModelPartPickingChange?.(false);
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [modelPartPickingActive, onActiveToolChange, onModelPartPickingChange, unavailable]);

  const setSnap = (enabled: boolean) => {
    setInternalSnapEnabled(enabled);
    onSnapEnabledChange?.(enabled);
  };

  const setAspectLock = (locked: boolean) => {
    setInternalAspectLocked(locked);
    onAspectLockedChange?.(locked);
  };

  const begin = (event: React.PointerEvent<HTMLElement>, interaction: PointerInteraction) => {
    if (unavailable || !surfaceRef.current) return;
    exitModelPartPicking();
    pendingFrameRef.current = false;
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = interaction;
    surfaceRef.current.focus({ preventScroll: true });
    surfaceRef.current.setPointerCapture(event.pointerId);
    onInteractionStart?.();
  };

  const beginMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const surface = surfaceRef.current;
    if (!surface || tool !== 'move' || event.button !== 0) return;
    const point = stickerViewportPointToUv(pointerInSurface(event, surface), viewport, surfaceSize(surface));
    const selected = selectionAtPoint(point);
    if (selected && selected.id !== activeSelectionId) {
      event.preventDefault();
      event.stopPropagation();
      onSelectionChange?.(selected.id);
      return;
    }
    begin(event, {
      kind: 'move',
      initial: placementValue,
      pointer: point,
    });
  };

  const beginResize = (event: React.PointerEvent<HTMLButtonElement>, corner: StickerCorner) => {
    if (tool !== 'scale' || event.button !== 0) return;
    begin(event, {
      kind: 'resize',
      initial: placementValue,
      corner,
      preserveAspect: event.shiftKey ? !isAspectLocked : isAspectLocked,
    });
  };

  const beginRotate = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (tool !== 'turn' || event.button !== 0) return;
    begin(event, { kind: 'rotate', initial: placementValue });
  };

  const beginAxisResize = (event: React.PointerEvent<HTMLButtonElement>, edge: StickerEdge) => {
    if (tool !== 'scale' || event.button !== 0) return;
    begin(event, {
      kind: 'resize-axis',
      initial: placementValue,
      edge,
      preserveAspect: event.shiftKey ? !isAspectLocked : isAspectLocked,
    });
  };

  const beginPan = (event: React.PointerEvent<HTMLDivElement>) => {
    const surface = surfaceRef.current;
    if (!surface || unavailable) return;
    if (event.button === 0) {
      selectionPointerRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
      return;
    }
    if (event.button !== 2) return;
    event.preventDefault();
    event.stopPropagation();
    interactionRef.current = { kind: 'pan', initial: viewport, pointer: pointerInSurface(event, surface) };
    surface.focus({ preventScroll: true });
    surface.setPointerCapture(event.pointerId);
  };

  const end = (event?: React.PointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    if (!interaction) {
      const selection = selectionPointerRef.current;
      selectionPointerRef.current = null;
      const surface = surfaceRef.current;
      if (!event || !surface || !selection || selection.pointerId !== event.pointerId || selection.moved) return;
      const point = stickerViewportPointToUv(pointerInSurface(event, surface), viewport, surfaceSize(surface));
      const selected = selectionAtPoint(point);
      if (selected && selected.id !== activeSelectionId) onSelectionChange?.(selected.id);
      return;
    }
    interactionRef.current = null;
    if (event && surfaceRef.current?.hasPointerCapture(event.pointerId)) surfaceRef.current.releasePointerCapture(event.pointerId);
    if (interaction.kind !== 'pan') onInteractionEnd?.();
  };

  const cancel = (event: React.PointerEvent<HTMLDivElement>) => {
    selectionPointerRef.current = null;
    const interaction = interactionRef.current;
    if (!interaction) return;
    interactionRef.current = null;
    if (surfaceRef.current?.hasPointerCapture(event.pointerId)) surfaceRef.current.releasePointerCapture(event.pointerId);
    if (interaction.kind !== 'pan') onInteractionCancel?.();
  };

  const movePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    const surface = surfaceRef.current;
    if (!surface) return;
    if (!interaction) {
      const selection = selectionPointerRef.current;
      if (selection && selection.pointerId === event.pointerId
        && Math.hypot(event.clientX - selection.x, event.clientY - selection.y) > 4) selection.moved = true;
      return;
    }
    const surfacePoint = pointerInSurface(event, surface);
    if (interaction.kind === 'pan') {
      const size = surfaceSize(surface);
      setViewport(normalizeStickerViewport({
        zoom: interaction.initial.zoom,
        panX: interaction.initial.panX + surfacePoint.x - interaction.pointer.x,
        panY: interaction.initial.panY + surfacePoint.y - interaction.pointer.y,
      }, size));
      return;
    }
    const pointer = stickerViewportPointToUv(surfacePoint, viewport, surfaceSize(surface));
    const snap = isSnapEnabled || event.ctrlKey;
    switch (interaction.kind) {
      case 'move':
        emit(moveStickerPlacement(interaction.initial, { x: pointer.x - interaction.pointer.x, y: pointer.y - interaction.pointer.y }), 'move', snap);
        break;
      case 'resize':
        emit(resizeStickerFromCorner(interaction.initial, interaction.corner, pointer, { preserveAspect: interaction.preserveAspect }), 'resize', snap);
        break;
      case 'resize-axis':
        emit(resizeStickerFromEdge(
          interaction.initial,
          interaction.edge,
          pointer,
          { preserveAspect: interaction.preserveAspect },
        ), 'resize', snap);
        break;
      case 'rotate':
        emit(rotateStickerPlacement(
          interaction.initial,
          event.shiftKey
            ? rotationForPointer(pointer, interaction.initial)
            : snapStickerRotationToCardinal(rotationForPointer(pointer, interaction.initial)),
        ), 'rotate', snap);
        break;
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setViewportZoom(viewport.zoom * 1.2);
      return;
    }
    if (event.key === '-') {
      event.preventDefault();
      setViewportZoom(viewport.zoom / 1.2);
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      fitViewport();
      return;
    }
    if (unavailable || event.metaKey) return;
    if (event.ctrlKey && ['z', 'y'].includes(event.key.toLowerCase())) return;
    const amount = event.shiftKey ? 0.025 : 0.005;
    let next: StickerPlacement | null = null;
    let reason: StickerPlacementChangeReason = 'nudge';
    switch (event.key) {
      case 'ArrowLeft': next = moveStickerPlacement(placementValue, { x: -amount, y: 0 }); break;
      case 'ArrowRight': next = moveStickerPlacement(placementValue, { x: amount, y: 0 }); break;
      case 'ArrowUp': next = moveStickerPlacement(placementValue, { x: 0, y: -amount }); break;
      case 'ArrowDown': next = moveStickerPlacement(placementValue, { x: 0, y: amount }); break;
      case '[': next = { ...placementValue, width: placementValue.width * 0.96, height: placementValue.height * 0.96 }; reason = 'resize'; break;
      case ']': next = { ...placementValue, width: placementValue.width / 0.96, height: placementValue.height / 0.96 }; reason = 'resize'; break;
      case 'q':
      case 'Q': next = rotateStickerPlacement(placementValue, placementValue.rotation - 2); reason = 'rotate'; break;
      case 'e':
      case 'E': next = rotateStickerPlacement(placementValue, placementValue.rotation + 2); reason = 'rotate'; break;
      default: return;
    }
    event.preventDefault();
    onInteractionStart?.();
    emit(next, reason, isSnapEnabled || event.ctrlKey);
    onInteractionEnd?.();
  };

  /**
   * Typing is a gesture, not a stream of separate edits. The first keystroke
   * opens one history entry and a pause closes it, so a burst of typing undoes
   * in a single step exactly like a drag does.
   */
  const noteTyping = () => {
    const current = typingRef.current;
    if (current.timer === null) onInteractionStart?.();
    else window.clearTimeout(current.timer);
    current.timer = window.setTimeout(() => {
      current.timer = null;
      onInteractionEnd?.();
    }, 450);
  };

  useEffect(() => () => {
    const current = typingRef.current;
    if (current.timer === null) return;
    window.clearTimeout(current.timer);
    current.timer = null;
    onInteractionEnd?.();
    // Only ever runs on unmount, to close a history entry left open by typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateValue = (field: keyof StickerPlacement, rawValue: string, temporarySnap = false) => {
    const parsed = nextNumber(rawValue);
    if (parsed === null) return;
    noteTyping();
    const aspect = placementValue.width / Math.max(placementValue.height, 0.0001);
    const linkedSize = isAspectLocked && field === 'width'
      ? { height: parsed / aspect }
      : isAspectLocked && field === 'height'
        ? { width: parsed * aspect }
        : {};
    emit({ ...placementValue, ...linkedSize, [field]: parsed }, 'value', isSnapEnabled || temporarySnap);
  };

  /** Live-apply the corner draft whenever the six numbers describe a real rectangle. */
  const applyCornerDraft = (draft: typeof cornerDraft) => {
    const values = Object.fromEntries(
      Object.entries(draft).map(([key, value]) => [key, nextNumber(value)]),
    ) as Record<keyof typeof cornerDraft, number | null>;
    if (Object.values(values).some((value) => value === null)) {
      setCornerError(null);
      return;
    }
    const next: StickerAffineQuad = {
      tl: [values.tlX as number, values.tlY as number],
      tr: [values.trX as number, values.trY as number],
      bl: [values.blX as number, values.blY as number],
    };
    if (!stickerPlacementFromQuad(next).editable) {
      setCornerError('Those corners have to make a non-degenerate parallelogram.');
      return;
    }
    setCornerError(null);
    if (!onQuadChange) return;
    exitModelPartPicking();
    noteTyping();
    onQuadChange(next);
  };

  const fitViewport = () => {
    releaseFraming();
    setViewport(DEFAULT_STICKER_VIEWPORT);
  };

  const setViewportZoom = (nextZoom: number, anchor?: StickerPoint) => {
    const surface = surfaceRef.current;
    releaseFraming();
    if (!surface) return;
    const size = surfaceSize(surface);
    const pointer = anchor ?? { x: size.width / 2, y: size.height / 2 };
    setViewport((current) => zoomStickerViewportAt(current, nextZoom, pointer, size));
  };

  const zoomToActualPixels = () => {
    const surface = surfaceRef.current;
    if (!surface || !texturePixels) {
      fitViewport();
      return;
    }
    const size = surfaceSize(surface);
    // The texture canvas at Fit is aspect-correct. This factor makes one
    // source texel one CSS pixel, instead of calling the fitted view 100%.
    setViewportZoom(clampStickerViewportZoom(texturePixels.width / size.width));
  };

  // React delegates wheel events through the document, where browsers may
  // treat them as passive. Own the viewport wheel natively so preventDefault
  // reliably stops the workbench/page from scrolling while zooming.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || unavailable) return;
    const zoom = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      pendingFrameRef.current = false;
      const delta = Math.min(800, Math.max(-800, event.deltaY));
      const size = surfaceSize(surface);
      const pointer = pointerInSurface(event, surface);
      setViewport((current) => {
        const next = zoomStickerViewportAt(
          current,
          current.zoom * Math.exp(-delta * 0.0015),
          pointer,
          size,
        );
        const interaction = interactionRef.current;
        if (interaction?.kind === 'pan') {
          // Pointer moves calculate pan from the gesture's baseline. Rebase
          // that baseline after wheel zoom so the next right-drag event does
          // not restore the zoom and pan values from before the wheel event.
          interactionRef.current = { kind: 'pan', initial: next, pointer };
        }
        return next;
      });
    };
    surface.addEventListener('wheel', zoom, { passive: false });
    return () => surface.removeEventListener('wheel', zoom);
  }, [unavailable]);

  /**
   * Frame the selected sticker. The drawer is wide but shallow, so fitting the
   * whole texture leaves the decal a few pixels across. Showing the sticker at
   * a workable size is what the user actually came here to do, and Fit is one
   * click away when they want the overview back.
   */
  useEffect(() => {
    if (!quadKey) return;
    const format = (value: number) => String(Number(value.toFixed(6)));
    const [tlX, tlY, trX, trY, blX, blY] = quadKey.split('|').map(Number);
    setCornerDraft({
      tlX: format(tlX), tlY: format(tlY),
      trX: format(trX), trY: format(trY),
      blX: format(blX), blY: format(blY),
    });
    setCornerError(null);
  }, [quadKey]);

  useEffect(() => {
    if (!copyNotice) return;
    const timer = window.setTimeout(() => setCopyNotice(null), 1600);
    return () => window.clearTimeout(timer);
  }, [copyNotice]);

  const copyText = async (text: string, notice: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyNotice(notice);
    } catch {
      setCopyNotice('Copy failed');
    }
  };

  const copySnippet = () => {
    const entries = CORNER_ROWS.map(({ corner, field, x, y }) => {
      const value = `${cornerDraft[x]} ${cornerDraft[y]}`;
      const variable = protoVariableNames?.[corner];
      return variable ? { variable, string: value } : { [field]: { string: value } };
    });
    void copyText(entries.map((entry) => JSON.stringify(entry, null, 2)).join(',\n'), 'JSON entries copied');
  };

  const editCorner = (key: keyof typeof cornerDraft, text: string) => {
    setCornerDraft((current) => {
      const next = { ...current, [key]: text };
      applyCornerDraft(next);
      return next;
    });
  };

  /** Any deliberate view or placement change hands control back to the user. */
  const releaseFraming = () => { pendingFrameRef.current = false; };

  const frameSticker = (target: StickerPlacement) => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const size = surfaceSize(surface);
    const span = Math.max(target.width, target.height, 0.01);
    // Aim for the sticker covering roughly a third of the shorter edge.
    const desired = (Math.min(size.width, size.height) * 0.34) / (span * Math.min(size.width, size.height));
    const zoom = clampStickerViewportZoom(Math.max(1, desired));
    setViewport(normalizeStickerViewport({
      zoom,
      panX: size.width / 2 - target.x * size.width * zoom,
      panY: size.height / 2 - target.y * size.height * zoom,
    }, size));
  };

  frameRef.current = () => frameSticker(clampStickerPlacement(placement));

  const focusRef = useRef<string | null>(null);
  useEffect(() => {
    if (unavailable) return;
    const key = focusKey ?? null;
    if (focusRef.current === key) return;
    focusRef.current = key;
    // The drawer and the surface may still be settling into their final size,
    // so stay armed until the box stops changing or the user takes over.
    pendingFrameRef.current = true;
    frameSticker(clampStickerPlacement(placement));
    // Framing follows the selected sticker, not every placement edit, so the
    // view stays still while the user drags.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, unavailable, texturePixels]);

  const fitPercent = texturePixels && surfaceRef.current
    ? Math.min(1, surfaceSize(surfaceRef.current).width / Math.max(texturePixels.width, 1))
    : 1;
  const displayZoom = Math.round(viewport.zoom * fitPercent * 100);

  return (
    <section className="sticker-placement-editor" aria-label={label} data-disabled={unavailable ? '' : undefined}>
      <header className="sticker-placement-editor-heading">
        <span className="sticker-placement-editor-title">{label}</span>
        <div className="sticker-placement-editor-heading-actions">
          <div className="sticker-placement-editor-tools" role="toolbar" aria-label="Sticker placement tools">
            {TOOLS.map(({ id, label: toolLabel, Icon }, index) => (
              <button
                key={id}
                type="button"
                className="sticker-placement-editor-tool"
                aria-label={toolLabel}
                aria-pressed={!modelPartPickingActive && tool === id}
                title={`${toolLabel} (${index + 1})${id === 'scale'
                  ? '. Hold Shift to temporarily invert the proportion lock.'
                  : id === 'turn'
                    ? '. Snaps near cardinal angles; hold Shift for free rotation.'
                    : ''}`}
                disabled={unavailable}
                onClick={() => setTool(id)}
              >
                <Icon size={15} aria-hidden="true" />
              </button>
            ))}
            <span className="sticker-placement-editor-tool-divider" aria-hidden="true" />
            <button
              type="button"
              className="sticker-placement-editor-tool sticker-placement-editor-aspect-lock"
              aria-label={isAspectLocked ? 'Unlock sticker proportions' : 'Lock sticker proportions'}
              aria-pressed={isAspectLocked}
              title={`${isAspectLocked ? 'Proportions locked' : 'Proportions unlocked'}. Hold Shift during a drag to temporarily ${isAspectLocked ? 'stretch freely' : 'keep proportions'}.`}
              disabled={unavailable}
              onClick={() => setAspectLock(!isAspectLocked)}
            >
              {isAspectLocked ? <Link2 size={15} aria-hidden="true" /> : <Unlink2 size={15} aria-hidden="true" />}
            </button>
            {onModelPartPickingChange && (
              <>
                <span className="sticker-placement-editor-tool-divider" aria-hidden="true" />
                <span className="sticker-placement-editor-parts-group">
                  <button
                    type="button"
                    className="sticker-placement-editor-tool sticker-placement-editor-parts-tool"
                    aria-label={`${modelPartPickingActive ? 'Stop picking model parts' : 'Pick model parts to hide'}${hiddenModelPartCount > 0 ? ` (${hiddenModelPartCount} hidden)` : ''}`}
                    aria-pressed={modelPartPickingActive}
                    title={modelPartPickingActive
                      ? 'Click a part to hide it, or click a hidden outline to show it again. Esc leaves the picker.'
                      : 'Hide model parts that cover the surface you want to sticker'}
                    disabled={unavailable}
                    onClick={() => onModelPartPickingChange(!modelPartPickingActive)}
                  >
                    <EyeOff size={14} aria-hidden="true" />
                    <span>Parts</span>
                    <span
                      className={`sticker-placement-editor-parts-count${partsControlsExpanded ? '' : ' is-reserved'}`}
                      aria-hidden="true"
                    >
                      {hiddenModelPartCount}
                    </span>
                  </button>
                  {onRestoreHiddenModelParts && (
                    <button
                      type="button"
                      className={`sticker-placement-editor-tool sticker-placement-editor-parts-restore${partsControlsExpanded ? '' : ' is-reserved'}`}
                      aria-label={`Show all hidden model parts (${hiddenModelPartCount})`}
                      aria-hidden={!partsControlsExpanded}
                      title="Show every hidden model part again"
                      disabled={unavailable || hiddenModelPartCount === 0}
                      tabIndex={partsControlsExpanded ? undefined : -1}
                      onClick={onRestoreHiddenModelParts}
                    >
                      <Eye size={14} aria-hidden="true" />
                      <span>Show all</span>
                    </button>
                  )}
                </span>
              </>
            )}
          </div>
          {onModelPartPickingChange && (
            <output className="sticker-placement-editor-parts-status" aria-live="polite" aria-atomic="true">
              {modelPartStatus}
            </output>
          )}
          <span className="sticker-placement-editor-separator" aria-hidden="true" />
          <label className="sticker-placement-editor-snap" title="Align edits to the grid. Hold Ctrl to snap just for one drag.">
            <input type="checkbox" checked={isSnapEnabled} onChange={(event) => setSnap(event.target.checked)} disabled={unavailable} />
            <Magnet size={12} aria-hidden="true" />
            Snap
          </label>
          <div className="sticker-placement-editor-viewport-controls" role="group" aria-label="Zoom">
            <button type="button" className="sticker-placement-editor-zoom-button" aria-label="Zoom out" onClick={() => setViewportZoom(viewport.zoom / 1.2)} disabled={unavailable} title="Zoom out (-)">
              <Minus size={13} aria-hidden="true" />
            </button>
            <output className="sticker-placement-editor-zoom-readout" aria-live="polite">{displayZoom}%</output>
            <button type="button" className="sticker-placement-editor-zoom-button" aria-label="Zoom in" onClick={() => setViewportZoom(viewport.zoom * 1.2)} disabled={unavailable} title="Zoom in (+)">
              <Plus size={13} aria-hidden="true" />
            </button>
            <button type="button" className="sticker-placement-editor-view-button" onClick={fitViewport} disabled={unavailable} title="Show the whole texture (0)">Fit</button>
            <button type="button" className="sticker-placement-editor-view-button" onClick={zoomToActualPixels} disabled={unavailable} title="Actual pixels (100%)">100%</button>
          </div>
          <button
            type="button"
            className="sticker-placement-editor-values-toggle"
            aria-label="Exact values"
            aria-expanded={valuesOpen}
            aria-pressed={valuesOpen}
            title="Exact values"
            disabled={unavailable}
            onClick={() => setValuesOpen((open) => !open)}
          >
            <MoreHorizontal size={15} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="sticker-placement-editor-workspace">
        {valuesOpen ? (
          <aside className="sticker-placement-editor-inspector" aria-label="Sticker values">
            <div className="sticker-placement-editor-value-mode" role="group" aria-label="Value mode">
              <button type="button" aria-pressed={valueMode === 'simple'} onClick={() => setValueMode('simple')}>Simple</button>
              <button type="button" aria-pressed={valueMode === 'proto'} onClick={() => setValueMode('proto')}>Proto</button>
            </div>
            {valueMode === 'simple' ? (
              <div className="sticker-placement-editor-values">
                {([
              ['x', 'X', 'Horizontal position', 0.01, undefined],
              ['y', 'Y', 'Vertical position', 0.01, undefined],
              ['width', 'Width', 'Sticker width', 0.01, 0.02],
              ['height', 'Height', 'Sticker height', 0.01, 0.02],
              ['rotation', 'Turn', 'Sticker rotation in degrees', 1, undefined],
            ] as const).map(([field, visibleLabel, ariaLabel, step, minimum]) => {
              const display = formatStickerValue(placementValue[field]);
              // While a field is focused it shows exactly what was typed, so a
              // live commit cannot reformat the text under the caret.
              const shown = editingValue?.field === field ? editingValue.text : display;
              return (
                <label key={field} title={ariaLabel}>
                  <span>{visibleLabel}</span>
                  <input
                    aria-label={ariaLabel}
                    type="number"
                    step={step}
                    min={minimum}
                    value={shown}
                    onFocus={() => { revertRef.current = placementValue; }}
                    onChange={(event) => {
                      setEditingValue({ field, text: event.target.value });
                      updateValue(field, event.target.value);
                    }}
                    onBlur={() => setEditingValue(null)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        if (event.ctrlKey) {
                          event.preventDefault();
                          updateValue(field, event.currentTarget.value, true);
                        }
                        event.currentTarget.blur();
                      }
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        const original = revertRef.current;
                        setEditingValue(null);
                        if (original) emit(original, 'value');
                        event.currentTarget.blur();
                      }
                    }}
                    disabled={unavailable}
                  />
                </label>
              );
            })}
              </div>
            ) : (
              <div className="sticker-placement-editor-corners">
                <div className="sticker-placement-editor-corner-head" aria-hidden="true">
                  <span />
                  <span>X</span>
                  <span>Y</span>
                  <span />
                </div>
                {CORNER_ROWS.map(({ label: rowLabel, short, x: xKey, y: yKey }) => (
                  <div className="sticker-placement-editor-corner-row" key={rowLabel}>
                    <abbr title={rowLabel}>{short}</abbr>
                    <input
                      aria-label={`${rowLabel} X`}
                      inputMode="decimal"
                      value={cornerDraft[xKey]}
                      disabled={unavailable}
                      onChange={(event) => editCorner(xKey, event.target.value)}
                    />
                    <input
                      aria-label={`${rowLabel} Y`}
                      inputMode="decimal"
                      value={cornerDraft[yKey]}
                      disabled={unavailable}
                      onChange={(event) => editCorner(yKey, event.target.value)}
                    />
                    <button
                      type="button"
                      aria-label={`Copy ${rowLabel}`}
                      title={`Copy ${rowLabel}`}
                      disabled={unavailable}
                      onClick={() => void copyText(`${cornerDraft[xKey]} ${cornerDraft[yKey]}`, `${rowLabel} copied`)}
                    >
                      <Copy size={12} aria-hidden="true" />
                    </button>
                  </div>
                ))}
                {cornerError ? <p className="sticker-placement-editor-corner-error" role="alert">{cornerError}</p> : null}
                <div className="sticker-placement-editor-corner-actions">
                  <button
                    type="button"
                    title="Copy all three corners as JSON"
                    disabled={unavailable}
                    onClick={copySnippet}
                  >
                    <Braces size={13} aria-hidden="true" />
                    Copy JSON
                  </button>
                  {copyNotice ? <span role="status">{copyNotice}</span> : null}
                </div>
              </div>
            )}
          </aside>
        ) : null}

        <div className="sticker-placement-editor-stage">
        <div
          ref={surfaceRef}
          className="sticker-placement-editor-surface"
          style={{
            '--sticker-texture-aspect': String(surfaceAspect),
            '--sticker-grid-step': `${safeSnapStep * 100}%`,
          } as React.CSSProperties}
          data-snap={isSnapEnabled ? '' : undefined}
          data-tool={tool}
          tabIndex={unavailable ? -1 : 0}
          role="group"
          aria-label={`${label}. The weapon texture is shown flat. Arrow keys move the sticker, brackets resize it, Q and E turn it. The wheel zooms and right drag pans the view.`}
          aria-disabled={unavailable || undefined}
          onKeyDown={onKeyDown}
          onPointerDown={beginPan}
          onPointerMove={movePointer}
          onPointerUp={end}
          onPointerCancel={cancel}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className="sticker-placement-editor-canvas"
            style={{ transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})` }}
          >
            <WeaponUvSurface
              textureSrc={textureSrc}
              textureAlt="Weapon UV texture"
              onTextureLoad={(event) => setTexturePixels({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })}
            />
            <span className="sticker-placement-editor-grid" aria-hidden="true" />
            {selectionTargets.map((target, index) => (
              target.id !== activeSelectionId && target.artworkSrc ? (
                <div
                  key={target.id}
                  className="sticker-placement-editor-passive-item"
                  style={placementStyle(target.placement, 4 + index)}
                  aria-hidden="true"
                >
                  <img src={target.artworkSrc} alt="" draggable={false} />
                </div>
              ) : null
            ))}
            {stickerSrc || groupPreview ? (
              <div
                className="sticker-placement-editor-item"
                style={{
                  ...placementStyle(placementValue, 4 + selectionTargets.length),
                  '--sticker-control-scale': Math.min(1.25, 1 / viewport.zoom),
                } as CSSProperties}
                onPointerDown={beginMove}
              >
                {groupPreview && quadValue
                  ? <GroupStickerUvPreview sources={groupPreview} quad={quadValue} />
                  : (renderStickerArtwork && stickerSrc ? <img src={stickerSrc} alt="" draggable={false} /> : null)}
                {tool === 'scale' && CORNERS.map((corner) => (
                  <button key={corner} type="button" className={`sticker-placement-editor-handle sticker-placement-editor-handle-${corner}`}
                    aria-label={`Resize from ${corner.replace('-', ' ')}`} disabled={unavailable}
                    onPointerDown={(event) => beginResize(event, corner)} />
                ))}
                {tool === 'scale' && EDGES.map((edge) => (
                  <button key={edge} type="button" className={`sticker-placement-editor-axis-handle sticker-placement-editor-axis-handle-${edge}`}
                    aria-label={`Resize ${edge === 'left' || edge === 'right' ? 'width' : 'height'} from ${edge}`}
                    disabled={unavailable} onPointerDown={(event) => beginAxisResize(event, edge)} />
                ))}
                {tool === 'turn' && <button type="button" className="sticker-placement-editor-rotate" aria-label="Turn sticker" disabled={unavailable} onPointerDown={beginRotate} />}
              </div>
            ) : null}
          </div>
          {unavailable && <span className="sticker-placement-editor-unavailable" role="status">{notice ?? 'Sticker artwork unavailable.'}</span>}
        </div>
        </div>
      </div>
    </section>
  );
}
