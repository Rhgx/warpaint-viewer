import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore, type StoreApi } from 'zustand';
import type { CSSProperties, ReactNode } from 'react';
import { Braces, Copy, Eye, EyeOff, Link2, Magnet, Minus, PanelLeft, Plus, Unlink2 } from 'lucide-react';

import {
  constrainStickerPlacementToTexture,
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
} from '../../editor/sticker/stickerGeometry';
import {
  DEFAULT_STICKER_VIEWPORT,
  clampStickerViewportZoom,
  normalizeStickerViewport,
  stickerViewportPointToUv,
  zoomStickerViewportAt,
  type StickerViewport,
  type StickerViewportSize,
} from '../../editor/sticker/stickerViewport';
import { ControlLabel } from '../common/controls';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { COMPACT_INPUTS, Input } from '../primitives/Input';
import { InlineNotice } from '../primitives/Notice';
import { ToggleGroup } from '../primitives/ToggleGroup';
import { EDITOR_BUTTON, EDITOR_HEAD, EDITOR_NUMBER, EDITOR_TITLE } from './editorStyles';
import {
  GroupStickerUvPreview,
  type GroupStickerPreviewSources,
} from './GroupStickerUvPreview';
import { WeaponUvSurface } from './WeaponUvSurface';
import { formatStickerValue } from './stickerValueFormat';
import {
  adaptiveSnapStep,
  nextNumber,
  pointerInSurface,
  rotationForPointer,
  surfaceSize,
} from './stickerPlacementEditorHelpers';
import {
  CORNER_ROWS,
  CORNERS,
  EDGES,
  TOOLS,
  TOOL_SHORTCUTS,
  type PointerInteraction,
  type StickerPlacementChangeReason,
  type StickerSelectionTarget,
  type StickerTransformTool,
} from './stickerPlacementEditorTypes';

// Quieter than a pressed tool until hovered, as with the other editor toggles.
const TOOL = 'not-aria-pressed:text-dim not-disabled:not-aria-pressed:hover:text-text';
const TOOL_DIVIDER = 'mx-px h-5 w-px bg-border max-[620px]:my-px max-[620px]:h-px max-[620px]:w-5';
const ZOOM_BUTTON = 'h-full not-disabled:hover:bg-panel';
const CORNER_ROW = 'grid grid-cols-[22px_minmax(0,1fr)_minmax(0,1fr)_var(--spacing-control)] items-center gap-1';
const CORNER_INPUT = cn(EDITOR_NUMBER, 'px-1.5');
const HANDLE = 'sticker-handle focus-ring';
const CORNER_HANDLE: Record<StickerCorner, string> = {
  'top-left': '-top-4 -left-4 cursor-nwse-resize',
  'top-right': '-top-4 -right-4 cursor-nesw-resize',
  'bottom-right': '-right-4 -bottom-4 cursor-nwse-resize',
  'bottom-left': '-bottom-4 -left-4 cursor-nesw-resize',
};
const EDGE_HANDLE: Record<StickerEdge, string> = {
  top: '-top-4 left-[calc(50%-16px)] cursor-ns-resize before:inset-x-2 before:inset-y-3',
  right: 'top-[calc(50%-16px)] -right-4 cursor-ew-resize before:inset-x-3 before:inset-y-2',
  bottom: '-bottom-4 left-[calc(50%-16px)] cursor-ns-resize before:inset-x-2 before:inset-y-3',
  left: 'top-[calc(50%-16px)] -left-4 cursor-ew-resize before:inset-x-3 before:inset-y-2',
};
const TURN_HANDLE = "-top-9.5 left-[calc(50%-16px)] cursor-crosshair before:rounded-full after:pointer-events-none after:absolute after:-bottom-1.5 after:left-3.75 after:h-3.75 after:w-px after:bg-accent after:content-['']";

export interface StickerPlacementEditorProps {
  readonly draftStore: StoreApi<StickerAffineQuad | null>;
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
  /** Changes when the owner picks another sticker; the view then frames it, as a wide drawer cannot show atlas and decal together. */
  readonly focusKey?: string;
  /** Lets the owner make one history item for a drag rather than one per frame. */
  readonly onInteractionStart?: () => void;
  readonly onInteractionEnd?: () => void;
  readonly onInteractionCancel?: () => void;
  readonly disabled?: boolean;
  readonly label?: string;
  /** Optional source dimensions ratio so the preview does not distort the texture. */
  readonly textureAspect?: number;
  /** Creates a valid authored quad when the current one is writable but degenerate. */
  readonly onCreatePlacement?: () => void;
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
  /** The sticker's weighted artwork choices, shown under a third inspector tab. */
  readonly variantsPanel?: ReactNode;
  readonly variantCount?: number;
}

/** Shared verbatim with the model-side interaction, so 2D edits and 3D placement stay in lockstep. */
export function StickerPlacementEditor({
  draftStore,
  textureSrc,
  stickerSrc,
  groupPreview,
  renderStickerArtwork = true,
  placement: authoredPlacement,
  quad: authoredQuad,
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
  onCreatePlacement,
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
  variantsPanel,
  variantCount,
}: StickerPlacementEditorProps) {
  const draftQuad = useStore(draftStore);
  const quad = draftQuad ?? authoredQuad;
  const placement = draftQuad ? stickerPlacementFromQuad(draftQuad).placement ?? authoredPlacement : authoredPlacement;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<PointerInteraction | null>(null);
  const selectionPointerRef = useRef<{ pointerId: number; x: number; y: number; moved: boolean } | null>(null);
  const pendingFrameRef = useRef(false);
  const frameRef = useRef<(() => void) | null>(null);
  const typingRef = useRef<{ timer: number | null }>({ timer: null });
  const revertRef = useRef<StickerPlacement | null>(null);
  const [internalTool, setInternalTool] = useState<StickerTransformTool>('move');
  const [internalAspectLocked, setInternalAspectLocked] = useState(true);
  // Numbers show by default; they are hidden only when the surface is wanted clear.
  const [valuesOpen, setValuesOpen] = useState(true);
  const [valueMode, setValueMode] = useState<'simple' | 'proto' | 'variants'>('simple');
  const shownMode = valueMode === 'variants' && !variantsPanel ? 'simple' : valueMode;
  const [editingValue, setEditingValue] = useState<{ field: keyof StickerPlacement; text: string } | null>(null);
  const [cornerError, setCornerError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [internalSnapEnabled, setInternalSnapEnabled] = useState(false);
  const [viewport, setViewport] = useState<StickerViewport>(DEFAULT_STICKER_VIEWPORT);
  const [texturePixels, setTexturePixels] = useState<StickerViewportSize | null>(null);
  const placementValue = constrainStickerPlacementToTexture(placement);
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
      // Re-frame, not just clamp, while framing is pending; a drawer that grows after mount would hide the sticker.
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
    const limited = constrainStickerPlacementToTexture(next);
    onPlacementChange(snap ? snapStickerPlacement(limited, safeSnapStep) : limited, reason);
  };

  const setTool = useCallback((nextTool: StickerTransformTool) => {
    setInternalTool(nextTool);
    onActiveToolChange?.(nextTool);
    onModelPartPickingChange?.(false);
  }, [onActiveToolChange, onModelPartPickingChange]);

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
      const nextTool = TOOL_SHORTCUTS[event.key];
      if (!nextTool) return;
      event.preventDefault();
      setTool(nextTool);
    };
    window.addEventListener('keydown', onShortcut);
    return () => window.removeEventListener('keydown', onShortcut);
  }, [modelPartPickingActive, onModelPartPickingChange, setTool, unavailable]);

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

  /** A burst of typing is one history entry: the first keystroke opens it and a pause closes it. */
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
      setCornerError('The three corner points must make a shape with a width and height.');
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
    // This factor makes one source texel one CSS pixel, not 100% of the fitted view.
    setViewportZoom(clampStickerViewportZoom(texturePixels.width / size.width));
  };

  // React wheel listeners are passive, so attach natively for preventDefault to stop page scroll.
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
          // Pan is measured from the gesture baseline; rebase it so right-drag does not undo the zoom.
          interactionRef.current = { kind: 'pan', initial: next, pointer };
        }
        return next;
      });
    };
    surface.addEventListener('wheel', zoom, { passive: false });
    return () => surface.removeEventListener('wheel', zoom);
  }, [unavailable]);

  /** Frames the selected sticker at a workable size; Fit restores the whole-texture view. */
  useEffect(() => {
    if (!quadKey) return;
    const [tlX, tlY, trX, trY, blX, blY] = quadKey.split('|').map(Number);
    setCornerDraft({
      tlX: formatStickerValue(tlX), tlY: formatStickerValue(tlY),
      trX: formatStickerValue(trX), trY: formatStickerValue(trY),
      blX: formatStickerValue(blX), blY: formatStickerValue(blY),
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
    const next = { ...cornerDraft, [key]: text };
    setCornerDraft(next);
    applyCornerDraft(next);
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

  frameRef.current = () => frameSticker(constrainStickerPlacementToTexture(placement));

  const focusRef = useRef<string | null>(null);
  useEffect(() => {
    if (unavailable) return;
    const key = focusKey ?? null;
    if (focusRef.current === key) return;
    focusRef.current = key;
    // The drawer and surface may still be settling, so stay armed until the box stops changing.
    pendingFrameRef.current = true;
    frameSticker(constrainStickerPlacementToTexture(placement));
    // Frame on sticker change, not every placement edit, so the view stays still while dragging.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, unavailable, texturePixels]);

  const fitPercent = texturePixels && surfaceRef.current
    ? Math.min(1, surfaceSize(surfaceRef.current).width / Math.max(texturePixels.width, 1))
    : 1;
  const displayZoom = Math.round(viewport.zoom * fitPercent * 100);

  return (
    <section className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-panel', COMPACT_INPUTS)} data-slot="sticker-editor" aria-label={label} data-disabled={unavailable ? '' : undefined}>
      <header className={EDITOR_HEAD}>
        {/* A small basis, so that a long name truncates beside the tools rather than wrapping them to a new row. */}
        <span className={cn(EDITOR_TITLE, 'flex-[1_1_96px]')}>{label}</span>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          <div className="flex items-center gap-1.25 max-[620px]:flex-col max-[620px]:self-start" role="toolbar" aria-label="Sticker placement tools">
            {TOOLS.map(({ id, label: toolLabel, Icon }, index) => (
              <Button
                key={id}
                variant="toggle"
                size="icon"
                className={TOOL}
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
              </Button>
            ))}
            <span className={TOOL_DIVIDER} aria-hidden="true" />
            <Button
              variant="toggle"
              size="icon"
              className={TOOL}
              aria-label={isAspectLocked ? 'Unlock sticker proportions' : 'Lock sticker proportions'}
              aria-pressed={isAspectLocked}
              title={`${isAspectLocked ? 'Proportions locked' : 'Proportions unlocked'}. Hold Shift during a drag to temporarily ${isAspectLocked ? 'stretch freely' : 'keep proportions'}.`}
              disabled={unavailable}
              onClick={() => setAspectLock(!isAspectLocked)}
            >
              {isAspectLocked ? <Link2 size={15} aria-hidden="true" /> : <Unlink2 size={15} aria-hidden="true" />}
            </Button>
            {onModelPartPickingChange && (
              <>
                <span className={TOOL_DIVIDER} aria-hidden="true" />
                <span className="contents max-[620px]:flex max-[620px]:items-center max-[620px]:gap-1.25">
                  <Button
                    variant="toggle"
                    size="compact"
                    className={cn(EDITOR_BUTTON, TOOL)}
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
                    {/* Hidden rather than absent, so that the tools after it hold their place. */}
                    <span
                      className={cn('min-w-[1.25em] rounded-xs border border-current px-1 py-px text-center text-9 leading-[1.1] tabular-nums', !partsControlsExpanded && 'invisible')}
                      aria-hidden="true"
                    >
                      {hiddenModelPartCount}
                    </span>
                  </Button>
                  {onRestoreHiddenModelParts && (
                    <Button
                      size="compact"
                      className={cn(EDITOR_BUTTON, !partsControlsExpanded && 'invisible')}
                      aria-label={`Show all hidden model parts (${hiddenModelPartCount})`}
                      aria-hidden={!partsControlsExpanded}
                      title="Show every hidden model part again"
                      disabled={unavailable || hiddenModelPartCount === 0}
                      tabIndex={partsControlsExpanded ? undefined : -1}
                      onClick={onRestoreHiddenModelParts}
                    >
                      <Eye size={14} aria-hidden="true" />
                      <span>Show All</span>
                    </Button>
                  )}
                </span>
              </>
            )}
          </div>
          {onModelPartPickingChange && (
            <output className="sr-only" aria-live="polite" aria-atomic="true">
              {modelPartStatus}
            </output>
          )}
          <span className="mx-0.5 my-1 w-px self-stretch bg-border" aria-hidden="true" />
          <Button
            variant="toggle"
            size="compact"
            className={cn(EDITOR_BUTTON, TOOL)}
            data-slot="sticker-snap"
            aria-pressed={isSnapEnabled}
            title="Align edits to the grid. Hold Ctrl to snap just for one drag."
            disabled={unavailable}
            onClick={() => setSnap(!isSnapEnabled)}
          >
            <Magnet size={13} aria-hidden="true" />
            Snap
          </Button>
          <div className="inline-flex h-control items-center gap-0.5 rounded-sm border border-border bg-panel-2" role="group" aria-label="Zoom">
            <Button variant="ghost" size="icon" className={ZOOM_BUTTON} aria-label="Zoom out" onClick={() => setViewportZoom(viewport.zoom / 1.2)} disabled={unavailable} title="Zoom out (-)">
              <Minus size={13} aria-hidden="true" />
            </Button>
            <output className="min-w-9 text-center text-10 text-dim tabular-nums" aria-live="polite">{displayZoom}%</output>
            <Button variant="ghost" size="icon" className={ZOOM_BUTTON} aria-label="Zoom in" onClick={() => setViewportZoom(viewport.zoom * 1.2)} disabled={unavailable} title="Zoom in (+)">
              <Plus size={13} aria-hidden="true" />
            </Button>
            <span className="my-1 w-px self-stretch bg-border" aria-hidden="true" />
            <Button variant="ghost" className={cn(ZOOM_BUTTON, EDITOR_BUTTON, 'min-w-0 px-1.5')} onClick={fitViewport} disabled={unavailable} title="Show the whole texture (0)">Fit</Button>
            <span className="my-1 w-px self-stretch bg-border" aria-hidden="true" />
            <Button variant="ghost" className={cn(ZOOM_BUTTON, EDITOR_BUTTON, 'min-w-0 px-1.5')} onClick={zoomToActualPixels} disabled={unavailable} title="Actual pixels (100%)">100%</Button>
          </div>
          <Button
            variant="toggle"
            size="icon"
            className={TOOL}
            aria-label="Inspector"
            aria-expanded={valuesOpen}
            aria-pressed={valuesOpen}
            title="Inspector"
            disabled={unavailable}
            onClick={() => setValuesOpen((open) => !open)}
          >
            <PanelLeft size={15} aria-hidden="true" />
          </Button>
        </div>
      </header>

      {/* Values sit beside the surface, never over it. */}
      <div className="relative flex min-h-0 min-w-0 flex-1 items-stretch gap-3 px-3 pt-2 pb-3 max-[620px]:gap-2.5 max-[620px]:px-2.5">
        {valuesOpen ? (
          <aside className="scrollbar-slim flex w-52 flex-none flex-col gap-2 overflow-auto border-r border-border pr-3 max-[620px]:border-t max-[620px]:border-r-0 max-[620px]:pt-2.5 max-[620px]:pr-0" aria-label="Sticker values">
            <ToggleGroup<'simple' | 'proto' | 'variants'>
              size="tool"
              label="Value mode"
              value={shownMode}
              options={[
                { value: 'simple', label: 'Simple' },
                { value: 'proto', label: 'Proto' },
                ...(variantsPanel ? [{
                  value: 'variants' as const,
                  label: <>Variants{(variantCount ?? 0) > 1 ? <span className="ml-1 font-semibold text-dim tabular-nums">{variantCount}</span> : null}</>,
                }] : []),
              ]}
              onChange={setValueMode}
            />
            {shownMode === 'variants' ? variantsPanel : shownMode === 'simple' ? (
              <div className="grid content-start gap-1.25 max-[620px]:grid-cols-2">
                {([
              ['x', 'X', 'Horizontal position', 0.01, undefined],
              ['y', 'Y', 'Vertical position', 0.01, undefined],
              ['width', 'Width', 'Sticker width', 0.01, 0.02],
              ['height', 'Height', 'Sticker height', 0.01, 0.02],
              ['rotation', 'Turn', 'Sticker rotation in degrees', 1, undefined],
            ] as const).map(([field, visibleLabel, ariaLabel, step, minimum]) => {
              const display = formatStickerValue(placementValue[field]);
              // A focused field shows the typed text, so a live commit cannot reformat it under the caret.
              const shown = editingValue?.field === field ? editingValue.text : display;
              return (
                <label key={field} className="grid min-w-0 grid-cols-[46px_minmax(0,1fr)] items-center gap-1.5" title={ariaLabel}>
                  <ControlLabel>{visibleLabel}</ControlLabel>
                  <Input
                    className={EDITOR_NUMBER}
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
              <div className="grid content-start gap-1.25">
                {/* Column headings carry the axis, so each row only needs its corner. */}
                <div className={CORNER_ROW} aria-hidden="true">
                  <span />
                  <ControlLabel className="justify-end">X</ControlLabel>
                  <ControlLabel className="justify-end">Y</ControlLabel>
                  <span />
                </div>
                {CORNER_ROWS.map(({ label: rowLabel, short, x: xKey, y: yKey }) => (
                  <div className={CORNER_ROW} key={rowLabel}>
                    <ControlLabel><abbr className="cursor-help no-underline" title={rowLabel}>{short}</abbr></ControlLabel>
                    <Input
                      className={CORNER_INPUT}
                      aria-label={`${rowLabel} X`}
                      inputMode="decimal"
                      value={cornerDraft[xKey]}
                      disabled={unavailable}
                      onChange={(event) => editCorner(xKey, event.target.value)}
                    />
                    <Input
                      className={CORNER_INPUT}
                      aria-label={`${rowLabel} Y`}
                      inputMode="decimal"
                      value={cornerDraft[yKey]}
                      disabled={unavailable}
                      onChange={(event) => editCorner(yKey, event.target.value)}
                    />
                    <Button
                      size="icon"
                      aria-label={`Copy ${rowLabel}`}
                      title={`Copy ${rowLabel}`}
                      disabled={unavailable}
                      onClick={() => void copyText(`${cornerDraft[xKey]} ${cornerDraft[yKey]}`, `${rowLabel} copied`)}
                    >
                      <Copy size={12} aria-hidden="true" />
                    </Button>
                  </div>
                ))}
                <div className="mt-px grid gap-1.25 border-t border-border pt-2">
                  <Button
                    size="compact"
                    className={cn(EDITOR_BUTTON, 'w-full')}
                    title="Copy all three corners as JSON"
                    disabled={unavailable}
                    onClick={copySnippet}
                  >
                    <Braces size={13} aria-hidden="true" />
                    Copy JSON
                  </Button>
                  {copyNotice ? <span className="text-center text-10 text-dim" role="status">{copyNotice}</span> : null}
                </div>
                {/* Below the action, so that Copy JSON does not move when the message comes and goes. */}
                {cornerError ? (
                  <InlineNotice tone="error" role="alert">{cornerError}</InlineNotice>
                ) : null}
              </div>
            )}
          </aside>
        ) : null}

        <div className="relative grid min-h-0 min-w-0 flex-1 place-items-center">
        <div
          ref={surfaceRef}
          // Fills the pane, capped by the texture's aspect ratio. Pointer-to-UV maths reads this box.
          className="group/surface checker-cells relative aspect-(--sticker-texture-aspect) h-full max-w-full min-w-0 min-h-0 cursor-default touch-none overflow-hidden rounded-sm border border-strong bg-checker focus-ring focus-visible:border-accent"
          data-slot="sticker-surface"
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
            className="absolute inset-0 size-full origin-top-left overflow-visible will-change-transform"
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
            <span className="sticker-grid pointer-events-none absolute inset-0 z-3 hidden group-data-snap/surface:block" aria-hidden="true" />
            {/* Other stickers are already composed into the surface texture. */}
            {stickerSrc || groupPreview ? (
              <div
                className="absolute z-4 box-border touch-none border border-accent shadow-[0_1px_4px_rgb(0_0_0/38%)] ring-1 ring-accent/45 select-none group-data-[tool=move]/surface:cursor-grab group-data-[tool=move]/surface:active:cursor-grabbing forced-colors:border-[Highlight]"
                style={{
                  ...placementStyle(placementValue, 4 + selectionTargets.length),
                  '--sticker-control-scale': Math.min(1.25, 1 / viewport.zoom),
                } as CSSProperties}
                onPointerDown={beginMove}
              >
                {groupPreview && quadValue
                  ? <GroupStickerUvPreview sources={groupPreview} quad={quadValue} />
                  : (renderStickerArtwork && stickerSrc ? <img className="pointer-events-none block size-full select-none" src={stickerSrc} alt="" draggable={false} /> : null)}
                {tool === 'scale' && CORNERS.map((corner) => (
                  <button key={corner} type="button" className={cn(HANDLE, CORNER_HANDLE[corner])}
                    aria-label={`Resize from ${corner.replace('-', ' ')}`} disabled={unavailable}
                    onPointerDown={(event) => beginResize(event, corner)} />
                ))}
                {tool === 'scale' && EDGES.map((edge) => (
                  <button key={edge} type="button" className={cn(HANDLE, 'before:rounded-xs', EDGE_HANDLE[edge])}
                    aria-label={`Resize ${edge === 'left' || edge === 'right' ? 'width' : 'height'} from ${edge}`}
                    disabled={unavailable} onPointerDown={(event) => beginAxisResize(event, edge)} />
                ))}
                {tool === 'turn' && <button type="button" className={cn(HANDLE, TURN_HANDLE)} aria-label="Turn sticker" disabled={unavailable} onPointerDown={beginRotate} />}
              </div>
            ) : null}
          </div>
          {unavailable && (
            <div className="absolute inset-0 z-3 flex flex-col items-center justify-center gap-2.25 bg-panel/82 p-3.5 text-center text-10 text-dim">
              <span role="status">{notice ?? 'Sticker artwork unavailable.'}</span>
              {onCreatePlacement ? (
                <Button variant="primary" size="compact" className={EDITOR_BUTTON} onClick={onCreatePlacement}>Create Centered Placement</Button>
              ) : null}
            </div>
          )}
        </div>
        </div>
      </div>
    </section>
  );
}
