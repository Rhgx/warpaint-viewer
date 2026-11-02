import type { ReactNode } from 'react';
import { Check, Eye, RotateCcw } from 'lucide-react';
import { SeedRangeField, type SeedRangeDivergence, type SeedRangeValue } from './SeedRangeField';
import { WeaponUvSurface } from './WeaponUvSurface';
import './TextureTransformPanel.css';

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
  readonly layerIndex: number;
  readonly layerCount: number;
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
  layerIndex,
  layerCount,
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
  return (
    <div className="texture-transform-panel">
      <div className="texture-transform-panel-head">
        <span className="texture-transform-panel-title">
          {layerLabel}
          <small>paint layer {layerIndex + 1} of {layerCount}</small>
        </span>
        {headerSlot}
        <span className="texture-transform-panel-head-spacer" />
        {headerActions}
        <select
          className="texture-transform-panel-scope-select"
          aria-label="Transform scope"
          title="Choose whether transform edits apply to every weapon or only the current weapon"
          value={scope}
          disabled={disabled}
          onChange={(event) => onScopeChange(event.target.value as 'all' | 'weapon')}
        >
          <option value="all">All weapons</option>
          <option value="weapon">
            {scopeWeaponLabel ? `This weapon only (${scopeWeaponLabel})` : 'This weapon only'}
          </option>
        </select>
        <button
          type="button"
          className="texture-transform-panel-action"
          title="Reset all transforms to their original values"
          aria-label="Reset all transforms to their original values"
          disabled={disabled}
          onClick={onResetAll}
        >
          <RotateCcw size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="texture-transform-panel-action"
          title={isolateLayer ? 'Stop isolating selected layer' : 'Isolate selected layer'}
          aria-label={isolateLayer ? 'Stop isolating selected layer' : 'Isolate selected layer'}
          aria-pressed={isolateLayer}
          disabled={disabled}
          onClick={() => onIsolateLayerChange(!isolateLayer)}
        >
          <Eye size={15} aria-hidden="true" />
        </button>
      </div>

      <div className="texture-transform-panel-body">
        <div className="texture-transform-panel-preview-pane">
          <span className="texture-transform-panel-preview-title">Weapon UV</span>
          <div className="texture-transform-panel-preview-frame">
            <div
              className="texture-transform-panel-preview"
              style={{ aspectRatio: Number.isFinite(previewAspect) && previewAspect > 0 ? previewAspect : 1 }}
              aria-label="Complete composed weapon texture in UV space"
            >
              <WeaponUvSurface
                textureSrc={uvTextureSrc}
                isolationOverlaySrc={uvIsolationOverlaySrc}
              />
              {!uvTextureSrc ? (
                <span className="texture-transform-panel-preview-status" role="status">
                  {uvSurfaceLoading ? 'Preparing weapon surface…' : 'Weapon texture unavailable.'}
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="texture-transform-panel-fields">
          {FIELD_ORDER.map((config) => {
          const fieldValue = fields[config.key];
          const originalValue = originalValues[config.key];
          const currentSeedValue = currentSeedValues?.[config.key];
          const bounds = authoredBounds(config.bounds, fieldValue, originalValue, currentSeedValue);
          const shared = sharedFields?.includes(config.key) ?? false;
          return (
          <div className="texture-transform-panel-field" key={config.key} title={shared ? SHARED_FIELD_NOTE : undefined}>
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

          <div className="texture-transform-panel-mirror-row">
            <span>Mirroring</span>
            <label
              className="texture-transform-panel-check"
              title={sharedFields?.includes('flipU') ? SHARED_FIELD_NOTE : undefined}
            >
              <input
                type="checkbox"
                checked={flipU}
                disabled={disabled || (sharedFields?.includes('flipU') ?? false)}
                onChange={(event) => onFlipChange('u', event.target.checked)}
              />
              <span className="texture-transform-panel-check-box" aria-hidden="true"><Check size={10} /></span>
              <span>Flip U</span>
            </label>
            <label
              className="texture-transform-panel-check"
              title={sharedFields?.includes('flipV') ? SHARED_FIELD_NOTE : undefined}
            >
              <input
                type="checkbox"
                checked={flipV}
                disabled={disabled || (sharedFields?.includes('flipV') ?? false)}
                onChange={(event) => onFlipChange('v', event.target.checked)}
              />
              <span className="texture-transform-panel-check-box" aria-hidden="true"><Check size={10} /></span>
              <span>Flip V</span>
            </label>
          </div>
        </div>
      </div>
    </div>
  );
}
