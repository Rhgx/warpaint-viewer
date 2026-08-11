import { useEffect, useRef, useState } from 'react';
import { Eye, Trash2 } from 'lucide-react';
import { formatGroupNameForDisplay } from '../../editor/groupNames';
import './VisualWarpaintEditorPanel.css';

const CLEAR_CONFIRM_MS = 3000;

export interface VisualWarpaintEditorSample {
  readonly rawRed: number;
  readonly bucket: number;
  readonly uv: Readonly<{ readonly u: number; readonly v: number }>;
  readonly texel?: Readonly<{ readonly x: number; readonly y: number }>;
}

export interface VisualWarpaintEditorPanelProps {
  readonly enabled: boolean;
  readonly unavailableReason?: string;
  readonly notice?: string | null;
  readonly sample: VisualWarpaintEditorSample | null;
  readonly selectedGroupIds: readonly number[];
  /** Changes whenever the active paint layer changes, even if its parts match. */
  readonly selectionContextId?: string;
  readonly groupLabels?: Readonly<Record<number, string>>;
  readonly onToggleGroup: (groupId: number) => void;
  readonly onClearSelection: () => void;
  readonly onPreviewGroup?: (groupId: number | null) => void;
  /** Retained for the workbench contract; assignment is implicit while Edit is open. */
  readonly inspectOnClick: boolean;
  readonly onInspectOnClickChange: (active: boolean) => void;
  /** When enabled, the viewer softly distinguishes parts assigned to each layer. */
  readonly showLayerMap?: boolean;
  readonly onShowLayerMapChange?: (active: boolean) => void;
  /** 0-based index of the layer currently being edited, among all layers. */
  readonly activeLayerIndex?: number;
  /** Every assigned part's layer, across all layers, keyed by compositor bucket. */
  readonly groupLayerIndex?: Readonly<Record<number, number>>;
  /** CSS (sRGB) colour per layer index, matching the context column swatches and the viewer's layer map. */
  readonly layerColors?: readonly string[];
}

export function VisualWarpaintEditorPanel({
  enabled,
  unavailableReason,
  notice,
  selectedGroupIds,
  selectionContextId,
  groupLabels,
  onToggleGroup,
  onClearSelection,
  onPreviewGroup,
  showLayerMap,
  onShowLayerMapChange,
  activeLayerIndex,
  groupLayerIndex,
  layerColors,
}: VisualWarpaintEditorPanelProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const areaCount = selectedGroupIds.length;
  const layerNumber = (activeLayerIndex ?? 0) + 1;
  const activeLayerColor = activeLayerIndex !== undefined ? layerColors?.[activeLayerIndex] : undefined;

  const availableParts = Object.entries(groupLabels ?? {})
    .map(([groupId, name]) => ({ groupId: Number(groupId), name }))
    .filter((part) => Number.isInteger(part.groupId) && part.groupId > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const displayCounts = new Map<string, number>();
  const boardParts = availableParts.map((part) => {
    const conciseName = formatGroupNameForDisplay(part.name);
    const count = (displayCounts.get(conciseName) ?? 0) + 1;
    displayCounts.set(conciseName, count);
    const inActiveLayer = selectedGroupIds.includes(part.groupId);
    const otherLayerIndex = !inActiveLayer ? groupLayerIndex?.[part.groupId] : undefined;
    const swatchColor = inActiveLayer
      ? activeLayerColor
      : (otherLayerIndex !== undefined ? layerColors?.[otherLayerIndex] : undefined);
    return {
      groupId: part.groupId,
      fullName: part.name,
      displayName: count === 1 ? conciseName : `${conciseName} (${count})`,
      inActiveLayer,
      inOtherLayer: otherLayerIndex !== undefined,
      swatchColor,
    };
  });

  const selectionKey = selectedGroupIds.join(',');

  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), CLEAR_CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  // Moving to another layer or changing its parts makes the original action
  // ambiguous, so a pending destructive action never follows that context.
  useEffect(() => {
    setConfirmClear(false);
  }, [selectionContextId, selectionKey]);

  useEffect(() => {
    if (!confirmClear) return;
    const cancel = () => setConfirmClear(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape should cancel the armed action, not also close the workbench.
      event.preventDefault();
      cancel();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!clearButtonRef.current?.contains(event.target as Node)) cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', cancel);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [confirmClear]);

  const clearAreas = () => {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setConfirmClear(false);
    onPreviewGroup?.(null);
    onClearSelection();
  };

  if (!enabled) {
    return (
      <section className="visual-warpaint-editor-panel" aria-label="Paint areas">
        <p className="visual-warpaint-editor-unavailable" role="status">
          {unavailableReason ?? 'Nothing to edit yet.'}
        </p>
      </section>
    );
  }

  return (
    <section className="visual-warpaint-editor-panel" aria-label="Paint areas">
      <div className="visual-warpaint-editor-head">
        <span className="visual-warpaint-editor-head-title">Parts in Layer {layerNumber}</span>
        <span className="visual-warpaint-editor-head-count">{areaCount} of {availableParts.length}</span>
        <div className="visual-warpaint-editor-head-spacer" />
        <button
          type="button"
          className="visual-warpaint-editor-layer-map-toggle"
          aria-pressed={showLayerMap ?? false}
          disabled={!onShowLayerMapChange}
          onClick={() => onShowLayerMapChange?.(!(showLayerMap ?? false))}
        >
          <Eye size={13} aria-hidden="true" />
          Layer map
        </button>
        <button
          ref={clearButtonRef}
          type="button"
          className="visual-warpaint-editor-clear"
          disabled={areaCount === 0}
          data-confirm={confirmClear ? '' : undefined}
          onClick={clearAreas}
          onBlur={() => setConfirmClear(false)}
          aria-label={confirmClear
            ? `Confirm clearing ${areaCount} included ${areaCount === 1 ? 'part' : 'parts'}`
            : `Clear ${areaCount} included ${areaCount === 1 ? 'part' : 'parts'}`}
          title={confirmClear ? 'Click again to clear these parts' : 'Clear included parts'}
        >
          <Trash2 size={12} aria-hidden="true" />
          {confirmClear ? 'Clear all?' : 'Clear'}
        </button>
      </div>

      <div
        className="visual-warpaint-editor-notice"
        role="status"
        aria-live="polite"
        data-visible={notice ? '' : undefined}
      >
        {notice}
      </div>

      {boardParts.length > 0 ? (
        <div className="visual-warpaint-editor-board" role="group" aria-label="Weapon parts">
          {boardParts.map((part) => (
            <button
              type="button"
              key={part.groupId}
              className="visual-warpaint-editor-chip"
              aria-pressed={part.inActiveLayer}
              aria-label={part.fullName}
              title={part.fullName}
              data-elsewhere={part.inOtherLayer ? '' : undefined}
              onClick={() => onToggleGroup(part.groupId)}
              onMouseEnter={() => onPreviewGroup?.(part.groupId)}
              onMouseLeave={() => onPreviewGroup?.(null)}
              onFocus={() => onPreviewGroup?.(part.groupId)}
              onBlur={() => onPreviewGroup?.(null)}
            >
              <span
                className="visual-warpaint-editor-chip-swatch"
                style={part.swatchColor ? { background: part.swatchColor } : undefined}
                aria-hidden="true"
              />
              <span>{part.displayName}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="visual-warpaint-editor-unavailable" role="status">
          This paint has no assignable parts.
        </p>
      )}
    </section>
  );
}
