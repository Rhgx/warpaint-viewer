import { Dices, RotateCcw } from 'lucide-react';
import { Control, IconSelectField, NumberFieldControl, SelectField, TeamToggle, WearSliderField } from './components';
import type { IconOption } from './components';
import { LIGHTING_PRESETS } from '../viewer/lighting';
import type { Manifest, Team } from '../data/types';

export interface ControlsState {
  weaponKey: string;
  wearIndex: number;
  team: Team;
  seed: number;
  preset: string;
}

export function ControlsBar({
  manifest,
  weaponOptions,
  hasTeamTextures,
  state,
  onChange,
  onRandomizeSeed,
  onResetView,
}: {
  manifest: Manifest;
  weaponOptions: IconOption[];
  hasTeamTextures: boolean;
  state: ControlsState;
  onChange: (patch: Partial<ControlsState>) => void;
  onRandomizeSeed: () => void;
  onResetView: () => void;
}) {
  const presetOptions = LIGHTING_PRESETS.map((p) => ({ value: p.id, label: p.label }));

  return (
    <div className="controls-bar">
      <Control label="Weapon">
        <IconSelectField
          value={state.weaponKey}
          onChange={(v) => onChange({ weaponKey: v })}
          options={weaponOptions}
        />
      </Control>

      <Control label={`Wear - ${manifest.wearNames[state.wearIndex] ?? ''}`}>
        <WearSliderField
          value={state.wearIndex}
          names={manifest.wearNames}
          onChange={(wearIndex) => onChange({ wearIndex })}
        />
      </Control>

      <Control label="Team">
        <TeamToggle
          team={state.team}
          disabled={!hasTeamTextures}
          onChange={(t) => onChange({ team: t })}
        />
      </Control>

      <Control label="Seed">
        <div className="seed-row">
          <NumberFieldControl
            value={state.seed}
            min={0}
            max={4294967295}
            onChange={(v) => onChange({ seed: Math.max(0, Math.floor(v)) })}
          />
          <button type="button" className="btn btn-icon" title="Randomize seed" aria-label="Randomize seed" onClick={onRandomizeSeed}>
            <Dices size={15} />
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

      <Control label="View">
        <button type="button" className="btn" onClick={onResetView}>
          <RotateCcw size={13} />
          <span>Reset</span>
        </button>
      </Control>
    </div>
  );
}
