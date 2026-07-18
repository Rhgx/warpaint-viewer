import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Camera, ChevronDown, Crosshair, Dices, Droplets, Flame, Hash, Sparkles, Sun, Undo2, Users,
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

// The seed is a 64-bit decimal. While focused, the field holds a free-typed
// draft (digits only, empty allowed) so the user can clear it and retype;
// the committed seed only updates on Enter or on blur with a non-empty
// draft. Blurring with an empty/invalid draft reverts to the last committed
// seed instead of leaving the field stuck empty.
function SeedField({
  seed,
  onCommit,
  onRandomize,
  onUndo,
  canUndo,
}: {
  seed: string;
  onCommit: (v: string) => void;
  onRandomize: () => void;
  onUndo: () => void;
  canUndo: boolean;
}) {
  const [draft, setDraft] = useState(seed);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setDraft(seed);
  }, [seed, focused]);

  const commit = () => {
    const digits = draft.replace(/\D/g, '').slice(0, 20);
    if (!digits) {
      setDraft(seed);
      return;
    }
    const value = BigInt.asUintN(64, BigInt(digits)).toString();
    setDraft(value);
    onCommit(value);
  };

  return (
    <div className="seed-field">
      <input
        className="ui-num-input seed-input"
        inputMode="numeric"
        aria-label="Paint seed"
        value={draft}
        onFocus={() => setFocused(true)}
        onChange={(event) => setDraft(event.currentTarget.value.replace(/\D/g, '').slice(0, 20))}
        onBlur={() => {
          commit();
          setFocused(false);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
      <div className="seed-field-actions">
        <button
          type="button"
          className="seed-action-btn"
          title="Randomize seed"
          aria-label="Randomize seed"
          onClick={onRandomize}
        >
          <Dices size={15} />
        </button>
        <button
          type="button"
          className="seed-action-btn"
          title="Previous seed"
          aria-label="Previous seed"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 size={15} />
        </button>
      </div>
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
  onUndoSeed,
  canUndoSeed,
  onViewAngle,
}: {
  manifest: Manifest;
  weaponOptions: IconOption[];
  hasTeamTextures: boolean;
  state: ControlsState;
  onChange: (patch: Partial<ControlsState>) => void;
  onRandomizeSeed: () => void;
  onUndoSeed: () => void;
  canUndoSeed: boolean;
  onViewAngle: (id: string) => void;
}) {
  const [viewAngle, setViewAngle] = useState('default');
  const presetOptions = LIGHTING_PRESETS.map((p) => ({ value: p.id, label: p.label }));
  const unusualOptions = UNUSUAL_PRESETS.map((p) => ({ value: p.id, label: p.label }));
  const viewAngleOptions = VIEW_ANGLES.map((p) => ({ value: p.id, label: p.label }));

  const sheenOptions: SwatchOption[] = SHEEN_PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    color: p.id === 'none' ? null : rgbCss(state.team === 'blu' ? p.blu : p.red),
  }));

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

        <Control label={<><Droplets size={12} /><span>Wear</span></>}>
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
            disabledReason="This warpaint uses one shared texture; team choice only affects the Team Shine sheen"
            onChange={(t) => onChange({ team: t })}
          />
        </Control>

        <Control label={<><Hash size={12} /><span>Seed</span></>}>
          <SeedField
            seed={state.seed}
            onCommit={(seed) => onChange({ seed })}
            onRandomize={onRandomizeSeed}
            onUndo={onUndoSeed}
            canUndo={canUndoSeed}
          />
        </Control>
      </InspectorSection>

      <InspectorSection title="Finish">
        <Control label={<><Sun size={12} /><span>Lighting</span></>}>
          <SelectField
            value={state.preset}
            onChange={(v) => onChange({ preset: v })}
            options={presetOptions}
          />
        </Control>

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
      </InspectorSection>
    </>
  );
}
