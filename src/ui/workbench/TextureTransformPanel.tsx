import type { ReactNode } from 'react';
import { Check, Eye, MoreHorizontal, RotateCcw } from 'lucide-react';
import { SeedRangeField, type SeedRangeDivergence, type SeedRangeValue } from './SeedRangeField';
import './TextureTransformPanel.css';

export interface TextureTransformFields {
  readonly rotation: SeedRangeValue;
  readonly scale: SeedRangeValue;
  readonly offsetU: SeedRangeValue;
  readonly offsetV: SeedRangeValue;
}

export interface TextureTransformPanelProps {
  readonly layerLabel: string;
  readonly layerIndex: number;
  readonly layerCount: number;
  readonly fields: TextureTransformFields;
  readonly currentSeedValues?: Partial<Record<keyof TextureTransformFields, number>>;
  readonly defaults: TextureTransformFields;
  readonly flipU: boolean;
  readonly flipV: boolean;
  readonly scope: 'all' | 'weapon';
  readonly scopeWeaponLabel?: string;
  readonly divergence?: Partial<Record<keyof TextureTransformFields, SeedRangeDivergence>>;
  readonly isolateLayer: boolean;
  /**
   * The Parts/Transform switch, supplied by the workbench. It belongs in this
   * panel's own header rather than in a bar above it, so both sub-views keep a
   * single header row and the layer name never scrolls out of sight.
   */
  readonly headerSlot?: ReactNode;
  readonly disabled?: boolean;
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

/**
 * The transform sub-view of a paint layer: per-field ranges and mirroring.
 */
export function TextureTransformPanel({
  layerLabel,
  layerIndex,
  layerCount,
  fields,
  currentSeedValues,
  defaults,
  flipU,
  flipV,
  scope,
  scopeWeaponLabel,
  divergence,
  isolateLayer,
  headerSlot,
  disabled = false,
  onFieldChange,
  onFlipChange,
  onScopeChange,
  onIsolateLayerChange,
  onResetAll,
  onPushFieldToAll,
  onInteractionStart,
  onInteractionEnd,
}: TextureTransformPanelProps) {
  const handleFieldChange = (key: keyof TextureTransformFields, value: SeedRangeValue) => {
    onFieldChange(key, value);
  };

  return (
    <div className="texture-transform-panel">
      <div className="texture-transform-panel-head">
        <span className="texture-transform-panel-title">
          {layerLabel}
          <small>paint layer {layerIndex + 1} of {layerCount}</small>
        </span>
        {headerSlot}
        <span className="texture-transform-panel-head-spacer" />
        <select
          id="texture-transform-scope"
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
        <details
          className="texture-transform-panel-actions"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.removeAttribute('open');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') event.currentTarget.removeAttribute('open');
          }}
        >
          <summary role="button" aria-haspopup="menu" aria-label="More transform actions" title="More transform actions">
            <MoreHorizontal size={15} aria-hidden="true" />
          </summary>
          <div className="texture-transform-panel-actions-menu" role="menu">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={isolateLayer}
              disabled={disabled}
              onClick={(event) => {
                onIsolateLayerChange(!isolateLayer);
                event.currentTarget.closest('details')?.removeAttribute('open');
              }}
            >
              <Eye size={13} aria-hidden="true" />
              <span>{isolateLayer ? 'Stop isolating layer' : 'Isolate selected layer'}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={disabled}
              onClick={(event) => {
                onResetAll();
                event.currentTarget.closest('details')?.removeAttribute('open');
              }}
            >
              <RotateCcw size={13} aria-hidden="true" />
              <span>Reset all transforms</span>
            </button>
          </div>
        </details>
      </div>

      <div className="texture-transform-panel-fields">
        {FIELD_ORDER.map((config) => {
          const fieldValue = fields[config.key];
          const defaultValue = defaults[config.key];
          const currentSeedValue = currentSeedValues?.[config.key];
          const bounds = authoredBounds(config.bounds, fieldValue, defaultValue, currentSeedValue);
          return (
          <div className="texture-transform-panel-field" key={config.key}>
            <SeedRangeField
              label={config.label}
              unit={config.unit}
              bounds={bounds}
              step={config.step}
              decimals={config.decimals}
              value={fieldValue}
              currentSeedValue={currentSeedValue}
              defaultValue={defaultValue}
              divergence={divergence?.[config.key]}
              disabled={disabled}
              onChange={(value) => handleFieldChange(config.key, value)}
              onPushToAll={onPushFieldToAll ? () => onPushFieldToAll(config.key) : undefined}
              onInteractionStart={onInteractionStart}
              onInteractionEnd={onInteractionEnd}
            />
          </div>
          );
        })}

        <div className="texture-transform-panel-mirror-row">
          <span>Mirroring</span>
          <label className="texture-transform-panel-check">
            <input
              type="checkbox"
              checked={flipU}
              disabled={disabled}
              onChange={(event) => onFlipChange('u', event.target.checked)}
            />
            <span className="texture-transform-panel-check-box" aria-hidden="true"><Check size={10} /></span>
            <span>Flip U</span>
          </label>
          <label className="texture-transform-panel-check">
            <input
              type="checkbox"
              checked={flipV}
              disabled={disabled}
              onChange={(event) => onFlipChange('v', event.target.checked)}
            />
            <span className="texture-transform-panel-check-box" aria-hidden="true"><Check size={10} /></span>
            <span>Flip V</span>
          </label>
        </div>
      </div>
    </div>
  );
}
