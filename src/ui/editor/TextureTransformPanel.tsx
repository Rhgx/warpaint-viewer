import type { ReactNode } from 'react';
import { Eye, RotateCcw } from 'lucide-react';

import { ControlLabel } from '../common/controls';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { COMPACT_INPUTS } from '../primitives/Input';
import { Select, SelectItem, SelectItemText, SelectPopup, SelectTrigger, SelectValue } from '../primitives/Select';
import { EDITOR_CHECK_LABEL, EDITOR_CHECKBOX, EDITOR_HEAD, EDITOR_TITLE } from './editorStyles';
import { SeedRangeField, type SeedRangeDivergence, type SeedRangeValue } from './SeedRangeField';
import { WeaponUvSurface } from './WeaponUvSurface';

export interface TextureTransformFields {
  readonly rotation: SeedRangeValue;
  readonly scale: SeedRangeValue;
  readonly offsetU: SeedRangeValue;
  readonly offsetV: SeedRangeValue;
}

export type TextureTransformPanelField = keyof TextureTransformFields | 'flipU' | 'flipV';

const SHARED_FIELD_NOTE = 'Shared by all weapons. Switch to All weapons to edit.';

export interface TextureTransformPanelProps {
  readonly layerLabel: string;
  readonly fields: TextureTransformFields;
  readonly currentSeedValues?: Partial<Record<keyof TextureTransformFields, number>>;
  readonly originalValues: TextureTransformFields;
  readonly flipU: boolean;
  readonly flipV: boolean;
  readonly scope: 'all' | 'weapon';
  readonly scopeWeaponLabel?: string;
  readonly divergence?: Partial<Record<keyof TextureTransformFields, SeedRangeDivergence>>;
  readonly isolateLayer: boolean;
  /** Complete composed weapon texture shown in its flat UV domain. */
  readonly uvTextureSrc?: string | null;
  /** Neutral mask that dims texture groups outside the isolated layer. */
  readonly uvIsolationOverlaySrc?: string | null;
  /** Width divided by height for the weapon's composed texture. */
  readonly previewAspect?: number;
  readonly uvSurfaceLoading?: boolean;
  /** The Parts/Transform switch, supplied by the workbench and shown in this panel's header row. */
  readonly headerSlot?: ReactNode;
  /** Layer-level actions from the workbench, shown at the start of this head's action group. */
  readonly headerActions?: ReactNode;
  readonly disabled?: boolean;
  /** Controls that write the shared value even in weapon scope; they are disabled there. */
  readonly sharedFields?: readonly TextureTransformPanelField[];
  readonly onFieldChange: (key: keyof TextureTransformFields, value: SeedRangeValue) => void;
  readonly onFlipChange: (axis: 'u' | 'v', allowed: boolean) => void;
  readonly onScopeChange: (scope: 'all' | 'weapon') => void;
  readonly onIsolateLayerChange: (isolate: boolean) => void;
  readonly onResetAll: () => void;
  readonly onPushFieldToAll?: (key: keyof TextureTransformFields) => void;
  readonly onInteractionStart?: () => void;
  readonly onInteractionEnd?: () => void;
}

interface FieldConfig {
  readonly key: keyof TextureTransformFields;
  readonly label: string;
  readonly unit?: string;
  readonly bounds: readonly [number, number];
  readonly step: number;
  readonly decimals: number;
}

const FIELD_ORDER: readonly FieldConfig[] = [
  { key: 'rotation', label: 'Rotation', unit: '°', bounds: [0, 360], step: 1, decimals: 0 },
  { key: 'scale', label: 'Scale', unit: '×', bounds: [0.01, 6], step: 0.01, decimals: 2 },
  { key: 'offsetU', label: 'Offset U', bounds: [0, 1], step: 0.01, decimals: 2 },
  { key: 'offsetV', label: 'Offset V', bounds: [0, 1], step: 0.01, decimals: 2 },
];

function authoredBounds(
  base: readonly [number, number],
  value: SeedRangeValue,
  defaultValue: SeedRangeValue,
  currentSeedValue: number | undefined,
): readonly [number, number] {
  const values = [base[0], base[1], value.min, value.max, defaultValue.min, defaultValue.max];
  if (currentSeedValue !== undefined && Number.isFinite(currentSeedValue)) values.push(currentSeedValue);
  return [Math.min(...values), Math.max(...values)];
}

/** The transform sub-view of a paint layer: per-field ranges and mirroring. */
export function TextureTransformPanel({
  layerLabel,
  fields,
  currentSeedValues,
  originalValues,
  flipU,
  flipV,
  scope,
  scopeWeaponLabel,
  divergence,
  isolateLayer,
  uvTextureSrc,
  uvIsolationOverlaySrc,
  previewAspect = 1,
  uvSurfaceLoading = false,
  headerSlot,
  headerActions,
  disabled = false,
  sharedFields,
  onFieldChange,
  onFlipChange,
  onScopeChange,
  onIsolateLayerChange,
  onResetAll,
  onPushFieldToAll,
  onInteractionStart,
  onInteractionEnd,
}: TextureTransformPanelProps) {
  const uvAspect = Number.isFinite(previewAspect) && previewAspect > 0 ? previewAspect : 1;
  const weaponScopeLabel = scopeWeaponLabel ? `This weapon only (${scopeWeaponLabel})` : 'This weapon only';
  return (
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', COMPACT_INPUTS)} data-slot="texture-transform">
      <div className={EDITOR_HEAD}>
        {headerSlot}
        <span className={EDITOR_TITLE}>{layerLabel}</span>
        <span className="flex-1" />
        {headerActions}
        {/* Wraps as one, so that the two icons are not left alone on a second row. */}
        <div className="flex min-w-0 items-center gap-2">
        <Select
          value={scope}
          disabled={disabled}
          onValueChange={(next) => {
            if (next === 'all' || next === 'weapon') onScopeChange(next);
          }}
        >
          <SelectTrigger
            className="w-auto max-w-55 min-w-0 py-0 max-[900px]:max-w-38.75"
            aria-label="Transform scope"
            title="Choose whether transform edits apply to every weapon or only the current weapon"
          >
            <SelectValue className="truncate">{() => (scope === 'all' ? 'All weapons' : weaponScopeLabel)}</SelectValue>
          </SelectTrigger>
          <SelectPopup className="text-11">
            <SelectItem value="all"><SelectItemText>All weapons</SelectItemText></SelectItem>
            <SelectItem value="weapon"><SelectItemText>{weaponScopeLabel}</SelectItemText></SelectItem>
          </SelectPopup>
        </Select>
        <Button
          size="icon"
          title="Reset all transforms to their original values"
          aria-label="Reset all transforms to their original values"
          disabled={disabled}
          onClick={onResetAll}
        >
          <RotateCcw size={14} aria-hidden="true" />
        </Button>
        <Button
          variant="toggle"
          size="icon"
          title={isolateLayer ? 'Stop isolating selected layer' : 'Isolate selected layer'}
          aria-label={isolateLayer ? 'Stop isolating selected layer' : 'Isolate selected layer'}
          aria-pressed={isolateLayer}
          disabled={disabled}
          onClick={() => onIsolateLayerChange(!isolateLayer)}
        >
          <Eye size={15} aria-hidden="true" />
        </Button>
        </div>
      </div>

      {/* The first column caps the UV surface at a square footprint, larger when the editor fills the screen. Extra width goes to the controls. */}
      <div className="scrollbar-slim grid min-h-0 flex-1 grid-cols-[minmax(300px,460px)_minmax(320px,1fr)] overflow-auto @min-[1400px]:grid-cols-[minmax(300px,720px)_minmax(320px,1fr)] bg-panel @max-[760px]:grid-cols-1">
        <div className="flex min-h-0 min-w-0 flex-col border-r border-border bg-panel-2 px-3 pt-2.5 pb-3 @max-[760px]:min-h-60 @max-[760px]:border-r-0 @max-[760px]:border-b">
          <span className="mb-2 flex-none text-11.5 font-[650] text-text">Weapon UV</span>
          <div className="flex min-h-0 min-w-0 flex-1 @container-size items-start justify-center">
            <div
              className="relative flex-none overflow-hidden border border-strong bg-panel"
              // As large as the room allows at the texture's own shape, so that the frame hugs the image.
              style={{ aspectRatio: uvAspect, width: `min(100cqw, calc(100cqh * ${uvAspect}))` }}
              aria-label="Complete composed weapon texture in UV space"
            >
              <WeaponUvSurface
                textureSrc={uvTextureSrc}
                isolationOverlaySrc={uvIsolationOverlaySrc}
              />
              {!uvTextureSrc ? (
                <span className="absolute inset-0 z-3 grid place-items-center p-4 text-center text-10.5 text-dim" role="status">
                  {uvSurfaceLoading ? 'Preparing weapon surface…' : 'Weapon texture unavailable.'}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col" data-slot="transform-fields">
          {FIELD_ORDER.map((config) => {
          const fieldValue = fields[config.key];
          const originalValue = originalValues[config.key];
          const currentSeedValue = currentSeedValues?.[config.key];
          const bounds = authoredBounds(config.bounds, fieldValue, originalValue, currentSeedValue);
          const shared = sharedFields?.includes(config.key) ?? false;
          return (
          <div className="flex flex-none flex-col" key={config.key} title={shared ? SHARED_FIELD_NOTE : undefined}>
            <SeedRangeField
              label={config.label}
              unit={config.unit}
              bounds={bounds}
              step={config.step}
              decimals={config.decimals}
              value={fieldValue}
              currentSeedValue={currentSeedValue}
              originalValue={originalValue}
              divergence={divergence?.[config.key]}
              disabled={disabled}
              valueDisabled={shared}
              onChange={(value) => onFieldChange(config.key, value)}
              onPushToAll={onPushFieldToAll ? () => onPushFieldToAll(config.key) : undefined}
              onInteractionStart={onInteractionStart}
              onInteractionEnd={onInteractionEnd}
            />
          </div>
          );
          })}

          <div className="flex min-h-10 flex-none items-center gap-3.5 border-t border-border/66 px-2.5 py-1.5">
            <ControlLabel className="mr-auto">Mirroring</ControlLabel>
            <label
              className={EDITOR_CHECK_LABEL}
              title={sharedFields?.includes('flipU') ? SHARED_FIELD_NOTE : undefined}
            >
              <input
                type="checkbox"
                className={EDITOR_CHECKBOX}
                checked={flipU}
                disabled={disabled || (sharedFields?.includes('flipU') ?? false)}
                onChange={(event) => onFlipChange('u', event.target.checked)}
              />
              <span>Flip U</span>
            </label>
            <label
              className={EDITOR_CHECK_LABEL}
              title={sharedFields?.includes('flipV') ? SHARED_FIELD_NOTE : undefined}
            >
              <input
                type="checkbox"
                className={EDITOR_CHECKBOX}
                checked={flipV}
                disabled={disabled || (sharedFields?.includes('flipV') ?? false)}
                onChange={(event) => onFlipChange('v', event.target.checked)}
              />
              <span>Flip V</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
