import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Camera, ChevronDown, Crosshair, Dices, Droplets, Flame, Hash, ImageDown, RotateCcw, Sparkles, Sun, Users,
} from 'lucide-react';
import {
  Control, IconSelectField, SelectField, SliderField, SwatchSelectField, TeamToggle, WearSliderField,
} from './components';
import type { IconOption, SwatchOption } from './components';
import { LIGHTING_PRESETS } from '../viewer/lighting';
import { SHEEN_PRESETS, UNUSUAL_PRESETS, VIEW_ANGLES } from '../viewer/presets';
import type { Manifest, Team } from '../data/types';

export interface ControlsState {
  weaponKey: string;
  wearIndex: number;
  team: Team;
  seed: string;
  preset: string;
  sheen: string;
  unusual: string;
  fov: number;
  projection: 'perspective' | 'orthographic';
  screenshotScale: number;
}

const rgbCss = ([r, g, b]: [number, number, number]) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

const SCREENSHOT_SCALE_OPTIONS = [
  { value: '1', label: '1x' },
  { value: '2', label: '2x' },
  { value: '4', label: '4x' },
];

// A collapsible group of controls. Expanded by default; each section keeps
// its own local, unpersisted open/closed state.
function InspectorSection({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="inspector-section">
      <button
        type="button"
        className="inspector-section-header"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{title}</span>
        <ChevronDown size={14} className="inspector-section-chevron" data-collapsed={!open || undefined} />
      </button>
      {open && <div className="inspector-section-body">{children}</div>}
    </div>
  );
}

export function Inspector({
  manifest,
  weaponOptions,
  hasTeamTextures,
  state,
  onChange,
  onRandomizeSeed,
  onResetView,
  onViewAngle,
  onScreenshot,
}: {
  manifest: Manifest;
  weaponOptions: IconOption[];
  hasTeamTextures: boolean;
  state: ControlsState;
  onChange: (patch: Partial<ControlsState>) => void;
  onRandomizeSeed: () => void;
  onResetView: () => void;
  onViewAngle: (id: string) => void;
  onScreenshot: () => Promise<void>;
}) {
  const [viewAngle, setViewAngle] = useState('default');
  const [capturing, setCapturing] = useState(false);
  const presetOptions = LIGHTING_PRESETS.map((p) => ({ value: p.id, label: p.label }));
  const unusualOptions = UNUSUAL_PRESETS.map((p) => ({ value: p.id, label: p.label }));
  const viewAngleOptions = VIEW_ANGLES.map((p) => ({ value: p.id, label: p.label }));

  const sheenOptions: SwatchOption[] = SHEEN_PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    color: p.id === 'none' ? null : rgbCss(state.team === 'blu' ? p.blu : p.red),
  }));

  const handleScreenshot = async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      await onScreenshot();
    } finally {
      setCapturing(false);
    }
  };

  return (
    <>
      <InspectorSection title="Item">
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
            disabled={!hasTeamTextures && state.sheen !== 'team_shine'}
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
      </InspectorSection>

      <InspectorSection title="Finish">
        <Control label={<><Sparkles size={12} /><span>Sheen</span></>}>
          <SwatchSelectField
            value={state.sheen}
            onChange={(v) => {
              // Leaving Team Shine on a single-team warpaint re-locks the team
              // toggle, so snap the team back to the kit's real texture.
              if (v !== 'team_shine' && !hasTeamTextures) onChange({ sheen: v, team: 'red' });
              else onChange({ sheen: v });
            }}
            options={sheenOptions}
          />
        </Control>

        <Control label={<><Flame size={12} /><span>Effect</span></>}>
          <SelectField
            value={state.unusual}
            onChange={(v) => onChange({ unusual: v })}
            options={unusualOptions}
          />
        </Control>

        <Control label={<><Sun size={12} /><span>Lighting</span></>}>
          <SelectField
            value={state.preset}
            onChange={(v) => onChange({ preset: v })}
            options={presetOptions}
          />
        </Control>
      </InspectorSection>

      <InspectorSection title="Camera">
        <Control label={<><Camera size={12} /><span>View angle</span></>}>
          <SelectField
            value={viewAngle}
            onChange={(v) => {
              setViewAngle(v);
              onViewAngle(v);
            }}
            options={viewAngleOptions}
          />
        </Control>

        <Control label={<span>Field of view - {state.fov}</span>}>
          <SliderField
            value={state.fov}
            onChange={(fov) => onChange({ fov })}
            min={30}
            max={110}
            step={1}
            ariaLabel="Field of view"
          />
        </Control>

        <Control label={<span>Projection</span>}>
          <div className="ui-toggle-group" role="group" aria-label="Projection">
            <button
              type="button"
              className="ui-toggle-btn"
              data-pressed={state.projection === 'perspective' || undefined}
              aria-pressed={state.projection === 'perspective'}
              onClick={() => onChange({ projection: 'perspective' })}
            >
              Perspective
            </button>
            <button
              type="button"
              className="ui-toggle-btn"
              data-pressed={state.projection === 'orthographic' || undefined}
              aria-pressed={state.projection === 'orthographic'}
              onClick={() => onChange({ projection: 'orthographic' })}
            >
              Orthographic
            </button>
          </div>
        </Control>

        <Control label={<span>Screenshot scale</span>}>
          <SelectField
            value={String(state.screenshotScale)}
            onChange={(v) => onChange({ screenshotScale: Number(v) })}
            options={SCREENSHOT_SCALE_OPTIONS}
          />
        </Control>

        <div className="inspector-actions-row">
          <button type="button" className="btn" onClick={onResetView}>
            <RotateCcw size={13} />
            <span>Reset</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={capturing}
            onClick={handleScreenshot}
          >
            <ImageDown size={13} />
            <span>Save PNG</span>
          </button>
        </div>
      </InspectorSection>
    </>
  );
}
