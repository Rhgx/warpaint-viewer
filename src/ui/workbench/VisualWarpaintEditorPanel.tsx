import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Select } from '@base-ui/react/select';
import { Check, ChevronDown, Eye, Trash2 } from 'lucide-react';
import { formatGroupNameForDisplay, type CompatibleGroupTexture } from '../../editor/groupNames';
import { rawGroupIdForBucket } from '../../editor/groupSampling';
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
  readonly clearSelectionDisabled?: boolean;
  readonly onPreviewGroup?: (groupId: number | null) => void;
  readonly groupTextureChoices?: readonly CompatibleGroupTexture[];
  readonly activeGroupTextureRef?: string;
  readonly onGroupTextureChange?: (ref: string) => void;
  /** Retained for the workbench contract; assignment is implicit while Edit is open. */
  readonly inspectOnClick: boolean;
  readonly onInspectOnClickChange: (active: boolean) => void;
  /** When enabled, the viewer softly distinguishes parts assigned to each layer. */
  readonly showLayerMap?: boolean;
  readonly onShowLayerMapChange?: (active: boolean) => void;
  /** 0-based index of the layer currently being edited, among all layers. */
  readonly activeLayerIndex?: number;
  /** Authored display label for the active layer, shared with the layer list. */
  readonly activeLayerLabel?: string;
  /** Every assigned part's layer, across all layers, keyed by compositor bucket. */
  readonly groupLayerIndex?: Readonly<Record<number, number>>;
  /** CSS (sRGB) colour per layer index, matching the context column swatches and the viewer's layer map. */
  readonly layerColors?: readonly string[];
  /** Higher-chroma versions of layer colours for the small context markers. */
  readonly layerSwatchColors?: readonly string[];
  /** Small source-texture previews for the layer list in the edit context column. */
  readonly layerThumbnails?: readonly (string | null)[];
  /** The recipe's unmasked base texture, available in the Transform view. */
  readonly baseLayer?: Readonly<{
    readonly label: string;
    readonly thumbnail: string | null;
    readonly active: boolean;
    readonly onSelect: () => void;
  }>;
  /**
   * The Parts/Transform switch, supplied by the workbench. It sits in this
   * head so the sub-views share one header row instead of stacking a second
   * bar above the panel.
   */
  readonly headerSlot?: ReactNode;
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
  clearSelectionDisabled,
  onPreviewGroup,
  groupTextureChoices,
  activeGroupTextureRef,
  onGroupTextureChange,
  showLayerMap,
  onShowLayerMapChange,
  activeLayerIndex,
  activeLayerLabel,
  groupLayerIndex,
  layerColors,
  headerSlot,
}: VisualWarpaintEditorPanelProps) {
  const [confirmClear, setConfirmClear] = useState(false);
  const clearButtonRef = useRef<HTMLButtonElement>(null);
  const areaCount = selectedGroupIds.length;
  const layerLabel = activeLayerLabel ?? `Layer ${(activeLayerIndex ?? 0) + 1}`;
  const activeLayerColor = activeLayerIndex !== undefined ? layerColors?.[activeLayerIndex] : undefined;
  const selectedGroupTexture = groupTextureChoices?.find((choice) => choice.ref === activeGroupTextureRef);
  const groupTextureName = (ref: string) => ref.split('/').at(-1) ?? ref;

  const availableParts = Object.entries(groupLabels ?? {})
    .map(([groupId, name]) => ({ groupId: Number(groupId), name }))
    .filter((part) => Number.isInteger(part.groupId) && part.groupId > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  const boardParts = availableParts.map((part) => {
    const conciseName = formatGroupNameForDisplay(part.name);
    const rawGroupId = rawGroupIdForBucket(part.groupId);
    const inActiveLayer = selectedGroupIds.includes(part.groupId);
    const otherLayerIndex = !inActiveLayer ? groupLayerIndex?.[part.groupId] : undefined;
    const swatchColor = inActiveLayer
      ? activeLayerColor
      : (otherLayerIndex !== undefined ? layerColors?.[otherLayerIndex] : undefined);
    return {
      groupId: part.groupId,
      fullName: part.name,
      displayName: `${conciseName} [${rawGroupId ?? part.groupId}]`,
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
        <span className="visual-warpaint-editor-head-title">Parts in {layerLabel}</span>
        <span className="visual-warpaint-editor-head-count">{areaCount} of {availableParts.length}</span>
        {headerSlot}
        <div className="visual-warpaint-editor-head-spacer" />
        {(groupTextureChoices?.length ?? 0) > 1 && (
          <div className="visual-warpaint-editor-layout">
            <span>Group layout</span>
            <Select.Root
              value={activeGroupTextureRef}
              onValueChange={(value) => onGroupTextureChange?.(value as string)}
            >
              <Select.Trigger
                className="ui-select-trigger visual-warpaint-editor-layout-trigger"
                aria-label="Weapon group layout"
                title={activeGroupTextureRef}
                disabled={!onGroupTextureChange}
              >
                <Select.Value>
                  {() => selectedGroupTexture ? (
                    <span className="visual-warpaint-editor-layout-option">
                      <span>{selectedGroupTexture.label}</span>
                      <span>( {groupTextureName(selectedGroupTexture.ref)} )</span>
                    </span>
                  ) : 'Select layout'}
                </Select.Value>
                <Select.Icon className="ui-select-icon"><ChevronDown size={12} /></Select.Icon>
              </Select.Trigger>
              <Select.Portal>
                <Select.Positioner className="ui-select-positioner" sideOffset={4} alignItemWithTrigger={false}>
                  <Select.Popup className="ui-select-popup visual-warpaint-editor-layout-popup">
                    {groupTextureChoices?.map((choice) => (
                      <Select.Item key={choice.ref} value={choice.ref} className="ui-select-item">
                        <Select.ItemText>
                          <span className="visual-warpaint-editor-layout-option">
                            <span>{choice.label}</span>
                            <span>( {groupTextureName(choice.ref)} )</span>
                          </span>
                        </Select.ItemText>
                        <Select.ItemIndicator className="ui-select-indicator"><Check size={12} /></Select.ItemIndicator>
                      </Select.Item>
                    ))}
                  </Select.Popup>
                </Select.Positioner>
              </Select.Portal>
            </Select.Root>
          </div>
        )}
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
          disabled={areaCount === 0 || clearSelectionDisabled}
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
