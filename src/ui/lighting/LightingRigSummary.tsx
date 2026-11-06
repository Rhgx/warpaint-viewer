import { SlidersHorizontal } from 'lucide-react';
import { useStore } from 'zustand';
import { CUSTOM_AMBIENT_MAX, CUSTOM_EXPOSURE_MAX, CUSTOM_EXPOSURE_MIN } from '../../viewer/lighting/customLightingModel';
import type { LightingStore } from '../../viewer/lighting/lightingStore';
import { ControlLabel } from '../common/controls';
import { Button } from '../primitives/Button';
import { Switch } from '../primitives/Switch';
import { LightDot, LightIcon, ScalarRow } from './lightingFields';

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
    <div className="flex flex-col gap-1.5" data-slot="lighting-summary">
      <div className="flex flex-wrap gap-1">
        {rig.lights.map((light) => (
          <button
            key={light.id}
            type="button"
            className="inline-flex h-5.5 max-w-full cursor-pointer items-center gap-1.25 rounded-sm border border-border bg-panel-2 pr-1.75 pl-1.5 text-10.5 text-text transition-fast focus-ring hover:border-strong data-selected:border-accent data-selected:bg-accent data-selected:text-accent-text data-selected:data-off:bg-panel-2 data-selected:data-off:text-text touch:h-9 [&_svg]:flex-none [&_svg]:opacity-85"
            data-selected={(panelOpen && light.id === selectedLightId) || undefined}
            data-off={!light.enabled || undefined}
            title={light.enabled ? light.name : `${light.name} (off)`}
            onClick={() => onSelectLight(light.id)}
          >
            <LightDot color={light.color} off={!light.enabled} />
            <LightIcon type={light.type} size={11} />
            <span className="truncate in-data-off:line-through in-data-off:opacity-55">{light.name}</span>
          </button>
        ))}
        {rig.lights.length === 0 && <span className="text-10.5 text-dim">No lights yet</span>}
      </div>

      <Button
        variant="toggle"
        className="w-full gap-1.5 text-11"
        aria-pressed={panelOpen}
        onClick={onTogglePanel}
      >
        <SlidersHorizontal size={12} aria-hidden="true" />
        <span>{panelOpen ? 'Editing Lights' : 'Edit Lights'}</span>
      </Button>

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
      <div className="flex min-h-5.5 items-center justify-between gap-1.5">
        <ControlLabel title="Material-authored highlight that follows the camera">
          Camera Rim
        </ControlLabel>
        <Switch
          checked={rig.cameraRimLight}
          ariaLabel="Camera-facing material rim light"
          onChange={(cameraRimLight) => onChange({ ...rig, cameraRimLight })}
        />
      </div>
    </div>
  );
}
