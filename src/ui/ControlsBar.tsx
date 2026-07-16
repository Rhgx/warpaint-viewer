import { Camera, Crosshair, Dices, Droplets, Hash, RotateCcw, Sun, Users } from 'lucide-react';
import { Control, IconSelectField, SelectField, TeamToggle, WearSliderField } from './components';
import type { IconOption } from './components';
import { LIGHTING_PRESETS } from '../viewer/lighting';
import type { Manifest, Team } from '../data/types';

export interface ControlsState {
  weaponKey: string;
  wearIndex: number;
  team: Team;
  seed: string;
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
      <Control label={<><Crosshair size={12} /><span>Weapon</span></>}>
        <IconSelectField
          value={state.weaponKey}
          onChange={(v) => onChange({ weaponKey: v })}
          options={weaponOptions}
        />
      </Control>

      <Control label={<><Droplets size={12} /><span>Wear - {manifest.wearNames[state.wearIndex] ?? ''}</span></>}>
        <WearSliderField
          value={state.wearIndex}
          names={manifest.wearNames}
          onChange={(wearIndex) => onChange({ wearIndex })}
        />
      </Control>

      <Control label={<><Users size={12} /><span>Team</span></>}>
        <TeamToggle
          team={state.team}
          disabled={!hasTeamTextures}
          onChange={(t) => onChange({ team: t })}
        />
      </Control>

      <Control label={<><Hash size={12} /><span>Seed</span></>}>
        <div className="seed-row">
          <input
            className="ui-num-input seed-input"
            inputMode="numeric"
            aria-label="Paint seed"
            value={state.seed}
            onChange={(event) => {
              const digits = event.currentTarget.value.replace(/\D/g, '').slice(0, 20);
              if (!digits) return;
              const value = BigInt.asUintN(64, BigInt(digits));
              onChange({ seed: value.toString() });
            }}
          />
          <button type="button" className="btn btn-icon" title="Randomize seed" aria-label="Randomize seed" onClick={onRandomizeSeed}>
            <Dices size={15} />
          </button>
        </div>
      </Control>

      <Control label={<><Sun size={12} /><span>Lighting</span></>}>
        <SelectField
          value={state.preset}
          onChange={(v) => onChange({ preset: v })}
          options={presetOptions}
        />
      </Control>

      <Control label={<><Camera size={12} /><span>View</span></>}>
        <button type="button" className="btn" onClick={onResetView}>
          <RotateCcw size={13} />
          <span>Reset</span>
        </button>
      </Control>
    </div>
  );
}
