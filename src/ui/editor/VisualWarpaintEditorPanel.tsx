import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { Eye, PencilRuler, Trash2 } from 'lucide-react';

import { formatGroupNameForDisplay, type CompatibleGroupTexture } from '../../editor/layers/groupNames';
import { rawGroupIdForBucket } from '../../editor/layers/groupSampling';
import { useArmedConfirm } from '../../hooks/useArmedConfirm';
import { ControlLabel } from '../common/controls';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { EmptyState } from '../primitives/EmptyState';
import { Select, SelectItem, SelectItemText, SelectPopup, SelectTrigger, SelectValue } from '../primitives/Select';
import { EDITOR_BUTTON, EDITOR_HEAD, EDITOR_NOTE, EDITOR_TITLE } from './editorStyles';

const CLEAR_CONFIRM_MS = 3000;
const PANEL = 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden';
const LAYOUT_OPTION = 'flex min-w-0 items-baseline gap-1.25 whitespace-nowrap';
const LAYOUT_OPTION_FILE = 'min-w-0 overflow-hidden text-9.5 text-ellipsis text-dim group-data-highlighted:text-inherit group-data-highlighted:opacity-72';
// A label too long for any row wraps rather than truncates.
const PART_CHIP = 'h-auto min-h-control max-w-full justify-start gap-1.75 bg-transparent py-1 pr-2.75 pl-2.25 text-left text-11.5 text-dim not-aria-pressed:hover:text-text/75';

export interface VisualWarpaintEditorPanelProps {
  readonly enabled: boolean;
  readonly unavailableReason?: string;
  readonly notice?: string | null;
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
  /** Parts/Transform switch from the workbench, placed in this head so sub-views share one header row. */
  readonly headerSlot?: ReactNode;
  /** Layer-level actions from the workbench, shown at the start of this head's action group. */
  readonly headerActions?: ReactNode;
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
  headerActions,
}: VisualWarpaintEditorPanelProps) {
  const [confirmClear, armClear, disarmClear] = useArmedConfirm(CLEAR_CONFIRM_MS);
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

  // A layer or parts change makes a pending destructive action ambiguous, so disarm it.
  useEffect(() => {
    disarmClear();
  }, [selectionContextId, selectionKey, disarmClear]);

  useEffect(() => {
    if (!confirmClear) return;
    const cancel = () => disarmClear();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape should cancel the armed action, not also close the workbench.
      event.preventDefault();
      cancel();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && clearButtonRef.current?.contains(target)) return;
      cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', cancel);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [confirmClear, disarmClear]);

  const emptyState = (message: string) => (
    <EmptyState icon={<PencilRuler size={22} />} title={message} role="status" />
  );

  const clearAreas = () => {
    if (!confirmClear) {
      armClear();
      return;
    }
    disarmClear();
    onPreviewGroup?.(null);
    onClearSelection();
  };

  if (!enabled) {
    return (
      <section className={PANEL} aria-label="Paint areas">
        {headerSlot && <div className={EDITOR_HEAD}>{headerSlot}</div>}
        {emptyState(unavailableReason ?? 'Nothing to edit yet.')}
      </section>
    );
  }

  return (
    <section className={PANEL} aria-label="Paint areas">
      <div className={EDITOR_HEAD}>
        {headerSlot}
        <span className={EDITOR_TITLE}>Parts in {layerLabel}</span>
        <span className={cn(EDITOR_NOTE, 'font-normal tabular-nums')}>{areaCount} of {availableParts.length}</span>
        <div className="flex-1" />
        {headerActions}
        {(groupTextureChoices?.length ?? 0) > 1 && (
          <div className="inline-flex min-w-0 items-center gap-1.5 whitespace-nowrap">
            <ControlLabel>Group Layout</ControlLabel>
            <Select
              value={activeGroupTextureRef}
              onValueChange={(value) => onGroupTextureChange?.(value as string)}
            >
              <SelectTrigger
                className="w-56.25 min-w-0 py-0"
                aria-label="Weapon group layout"
                title={activeGroupTextureRef}
                disabled={!onGroupTextureChange}
              >
                <SelectValue>
                  {() => selectedGroupTexture ? (
                    <span className={LAYOUT_OPTION}>
                      <span className="flex-none">{selectedGroupTexture.label}</span>
                      <span className={LAYOUT_OPTION_FILE}>({groupTextureName(selectedGroupTexture.ref)})</span>
                    </span>
                  ) : 'Select layout'}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup className="w-[min(250px,var(--available-width))] min-w-0 text-11">
                {groupTextureChoices?.map((choice) => (
                  <SelectItem key={choice.ref} value={choice.ref}>
                    <SelectItemText>
                      <span className={LAYOUT_OPTION}>
                        <span className="flex-none">{choice.label}</span>
                        <span className={LAYOUT_OPTION_FILE}>({groupTextureName(choice.ref)})</span>
                      </span>
                    </SelectItemText>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        )}
        <Button
          variant="toggle"
          size="compact"
          className={cn(EDITOR_BUTTON, 'not-aria-pressed:text-dim')}
          data-slot="editor-layer-map"
          aria-pressed={showLayerMap ?? false}
          disabled={!onShowLayerMapChange}
          onClick={() => onShowLayerMapChange?.(!(showLayerMap ?? false))}
        >
          <Eye size={13} aria-hidden="true" />
          Layer Map
        </Button>
        <Button
          ref={clearButtonRef}
          variant={confirmClear ? 'armed' : 'danger'}
          size="compact"
          className={EDITOR_BUTTON}
          data-slot="editor-clear-parts"
          disabled={areaCount === 0 || clearSelectionDisabled}
          onClick={clearAreas}
          onBlur={() => disarmClear()}
          aria-label={confirmClear
            ? `Confirm clearing ${areaCount} included ${areaCount === 1 ? 'part' : 'parts'}`
            : `Clear ${areaCount} included ${areaCount === 1 ? 'part' : 'parts'}`}
          title={confirmClear ? 'Click again to clear these parts' : 'Clear included parts'}
        >
          <Trash2 size={12} aria-hidden="true" />
          {confirmClear ? 'Clear All?' : 'Clear'}
        </Button>
      </div>

      {/* Always mounted as a live region. It takes room only while it has a message. */}
      <div
        className="h-0 flex-none overflow-hidden px-3 text-10 text-dim opacity-0 transition-fast data-visible:h-auto data-visible:pt-1.75 data-visible:opacity-100"
        role="status"
        aria-live="polite"
        data-visible={notice ? '' : undefined}
      >
        {notice}
      </div>

      {boardParts.length > 0 ? (
        <div className="scrollbar-slim flex min-h-0 flex-1 flex-wrap content-start gap-1.5 overflow-auto px-3 pt-2.5 pb-3" role="group" aria-label="Weapon parts">
          {boardParts.map((part) => (
            <Button
              key={part.groupId}
              variant="toggle"
              className={PART_CHIP}
              data-slot="editor-part-chip"
              aria-pressed={part.inActiveLayer}
              aria-label={part.fullName}
              title={part.fullName}
              onClick={() => onToggleGroup(part.groupId)}
              onMouseEnter={() => onPreviewGroup?.(part.groupId)}
              onMouseLeave={() => onPreviewGroup?.(null)}
              onFocus={() => onPreviewGroup?.(part.groupId)}
              onBlur={() => onPreviewGroup?.(null)}
            >
              <span
                className={cn('size-2.25 flex-none rounded-[3px] bg-current', part.inActiveLayer ? 'opacity-100 ring-1 ring-panel' : part.inOtherLayer ? 'opacity-85' : 'opacity-35')}
                style={part.swatchColor ? { background: part.swatchColor } : undefined}
                aria-hidden="true"
              />
              <span className="min-w-0">{part.displayName}</span>
            </Button>
          ))}
        </div>
      ) : emptyState('This paint has no assignable parts.')}
    </section>
  );
}
