import { Control, NumberFieldControl, SelectField, SliderField, TeamToggle } from './components';
import { LIGHTING_PRESETS } from '../viewer/lighting';
import type { Manifest, Team } from '../data/types';

export interface ControlsState {
  weaponKey: string;
  wearIndex: number;
  team: Team;
  seed: number;
  preset: string;
  exposure: number;
}

export function ControlsBar({
  manifest,
  weaponOptions,
  state,
  onChange,
  onRandomizeSeed,
  onResetView,
}: {
  manifest: Manifest;
  weaponOptions: { value: string; label: string }[];
  state: ControlsState;
  onChange: (patch: Partial<ControlsState>) => void;
  onRandomizeSeed: () => void;
  onResetView: () => void;
}) {
  const wearOptions = manifest.wearNames.map((name, i) => ({ value: String(i), label: name }));
  const presetOptions = LIGHTING_PRESETS.map((p) => ({ value: p.id, label: p.label }));

  return (
    <div className="controls-bar">
      <Control label="Weapon">
        <SelectField
          value={state.weaponKey}
          onChange={(v) => onChange({ weaponKey: v })}
          options={weaponOptions}
        />
      </Control>

      <Control label="Wear">
        <SelectField
          value={String(state.wearIndex)}
          onChange={(v) => onChange({ wearIndex: Number(v) })}
          options={wearOptions}
        />
      </Control>

      <Control label="Team">
        <TeamToggle team={state.team} onChange={(t) => onChange({ team: t })} />
      </Control>

      <Control label="Seed">
        <div className="seed-row">
          <NumberFieldControl
            value={state.seed}
            min={0}
            max={4294967295}
            onChange={(v) => onChange({ seed: Math.max(0, Math.floor(v)) })}
          />
          <button type="button" className="btn" onClick={onRandomizeSeed}>
            Randomize
          </button>
        </div>
      </Control>

      <Control label="Lighting">
        <SelectField
          value={state.preset}
          onChange={(v) => onChange({ preset: v })}
          options={presetOptions}
        />
      </Control>

      <Control label={`Exposure ${state.exposure.toFixed(2)}`}>
        <SliderField
          value={state.exposure}
          min={0.1}
          max={3}
          step={0.05}
          onChange={(v) => onChange({ exposure: v })}
        />
      </Control>

      <Control label="View">
        <button type="button" className="btn" onClick={onResetView}>
          Reset view
        </button>
      </Control>
    </div>
  );
}
