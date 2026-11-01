import { Aperture, SlidersHorizontal } from 'lucide-react';
import { useStore } from 'zustand';
import { CUSTOM_AMBIENT_MAX, CUSTOM_EXPOSURE_MAX, CUSTOM_EXPOSURE_MIN } from '../../viewer/lighting/customLighting';
import type { LightingStore } from '../../viewer/lighting/lightingStore';
import { SwitchField } from '../common/controls';
import { LightIcon, ScalarRow } from './lightingFields';
import './Lighting.css';

/** Inspector half of custom lighting: rig-wide values and a chip per light. Per-light editing is on the stage. */
export function LightingRigSummary({
  store,
  onTogglePanel,
  onSelectLight,
}: {
  store: LightingStore;
  onTogglePanel: () => void;
  onSelectLight: (id: string) => void;
}) {
  const rig = useStore(store, (state) => state.rig);
  const panelOpen = useStore(store, (state) => state.open);
  const selectedLightId = useStore(store, (state) => state.selectedLightId);
  const { apply: onChange, preview: onPreviewChange } = store.getState();
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
        max={CUSTOM_AMBIENT_MAX}
        step={0.01}
        onPreviewChange={(ambient) => onPreviewChange({ ...rig, ambient })}
        onChange={(ambient) => onChange({ ...rig, ambient })}
      />
      <ScalarRow
        label="Exposure"
        value={rig.exposure}
        min={CUSTOM_EXPOSURE_MIN}
        max={CUSTOM_EXPOSURE_MAX}
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
