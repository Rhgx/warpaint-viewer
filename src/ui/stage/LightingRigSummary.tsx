import { Aperture, SlidersHorizontal } from 'lucide-react';
import type { CustomLightingRig } from '../../viewer/customLighting';
import { SwitchField } from '../common/controls';
import { LightIcon, ScalarRow } from './lightingFields';
import './Lighting.css';

/**
 * The inspector half of custom lighting. It keeps only what belongs in a
 * settings column: the rig-wide ambient and exposure, plus a chip per light so
 * the rig stays readable and selectable without leaving the panel. Per-light
 * authoring lives in the stage panel, next to the render it changes.
 */
export function LightingRigSummary({
  rig,
  panelOpen,
  selectedLightId,
  onChange,
  onPreviewChange,
  onTogglePanel,
  onSelectLight,
}: {
  rig: CustomLightingRig;
  panelOpen: boolean;
  selectedLightId: string | null;
  onChange: (rig: CustomLightingRig) => void;
  onPreviewChange: (rig: CustomLightingRig) => void;
  onTogglePanel: () => void;
  onSelectLight: (id: string) => void;
}) {
  return (
    <div className="lighting-summary">
      <div className="lighting-chips">
        {rig.lights.map((light) => (
          <button
            key={light.id}
            type="button"
            className="lighting-chip"
            data-selected={light.id === selectedLightId || undefined}
            data-off={!light.enabled || undefined}
            title={light.enabled ? light.name : `${light.name} (off)`}
            onClick={() => onSelectLight(light.id)}
          >
            <span
              className="lighting-dot"
              style={{ backgroundColor: light.color }}
              data-off={!light.enabled || undefined}
              aria-hidden="true"
            />
            <LightIcon type={light.type} size={11} />
            <span className="lighting-chip-name">{light.name}</span>
          </button>
        ))}
        {rig.lights.length === 0 && <span className="lighting-chips-empty">No lights yet</span>}
      </div>

      <button
        type="button"
        className="lighting-summary-edit"
        aria-pressed={panelOpen}
        onClick={onTogglePanel}
      >
        <SlidersHorizontal size={12} aria-hidden="true" />
        <span>{panelOpen ? 'Editing lights' : 'Edit lights'}</span>
      </button>

      <ScalarRow
        label="Ambient"
        value={rig.ambient}
        min={0}
        max={1}
        step={0.01}
        onPreviewChange={(ambient) => onPreviewChange({ ...rig, ambient })}
        onChange={(ambient) => onChange({ ...rig, ambient })}
      />
      <ScalarRow
        label="Exposure"
        value={rig.exposure}
        min={0.1}
        max={4}
        step={0.05}
        onPreviewChange={(exposure) => onPreviewChange({ ...rig, exposure })}
        onChange={(exposure) => onChange({ ...rig, exposure })}
      />
      <div className="lighting-summary-toggle">
        <span className="lighting-summary-toggle-label" title="Material-authored highlight that follows the camera">
          <Aperture size={11} aria-hidden="true" />
          <span>Camera rim</span>
        </span>
        <SwitchField
          checked={rig.cameraRimLight}
          ariaLabel="Camera-facing material rim light"
          onChange={(cameraRimLight) => onChange({ ...rig, cameraRimLight })}
        />
      </div>
    </div>
  );
}
