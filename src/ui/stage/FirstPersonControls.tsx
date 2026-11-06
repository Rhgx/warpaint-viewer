import { useEffect, useState } from 'react';
import { Eye, Pause, Play } from 'lucide-react';

import type { Viewer } from '../../viewer/Viewer';
import type { ViewmodelManifest, ViewmodelWeapon } from '../../viewer/firstPerson/firstPerson';
import { Control, ControlLabel, SelectField } from '../common/controls';
import { firstPersonAnimationGroups } from './firstPersonAnimations';
import { InspectorSection } from './Inspector';
import { Button } from '../primitives/Button';
import { Slider } from '../primitives/Slider';
import { Switch } from '../primitives/Switch';
import { ToggleGroup } from '../primitives/ToggleGroup';

function SwitchRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <label className="flex min-h-control cursor-pointer items-center justify-between gap-1.5 text-12 text-text [&>[role=switch]]:flex-none">
      <span>{label}</span>
      <Switch checked={checked} onChange={onChange} ariaLabel={label} />
    </label>
  );
}

export function FirstPersonControls({ viewer, weaponKey, team, disabled, enabled, onEnabledChange }: {
  viewer: Viewer;
  weaponKey: string;
  team: 'red' | 'blu';
  disabled: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  const [manifest, setManifest] = useState<ViewmodelManifest | null>(null);
  const [playerClass, setPlayerClass] = useState('');
  const [animation, setAnimation] = useState('ACT_VM_IDLE:0');
  const [fov, setFov] = useState(70);
  const [minimized, setMinimized] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fishPhysics, setFishPhysics] = useState(true);
  const [showHands, setShowHands] = useState(true);
  const [spinBarrel, setSpinBarrel] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ weapon: ViewmodelWeapon; team: 'red' | 'blu'; viewer: Viewer; error: string | null } | null>(null);
  const active = enabled;
  const choices = manifest?.weapons.filter(weapon => weapon.weaponKey === weaponKey) ?? [];
  const weapon = choices.find(choice => choice.class === playerClass) ?? choices[0];
  const animationGroups = firstPersonAnimationGroups(weapon?.clips ?? {}, weapon?.weaponKey);
  const animations = animationGroups.flatMap(group => group.options);
  const selectedAnimation = animations.find(option => option.id === animation)
    ?? animations.find(option => option.clip === weapon?.activity) ?? animations[0];
  const activity = selectedAnimation?.clip ?? weapon?.activity ?? '';
  let status: 'loading' | 'ready' | 'error' = 'loading';
  let error = '';
  if (!manifest) {
    if (fetchError !== null) { status = 'error'; error = fetchError; }
  } else if (!weapon) {
    status = 'error';
    error = 'No first-person model is available for this weapon.';
  } else if (shown?.weapon === weapon && shown.team === team && shown.viewer === viewer) {
    status = shown.error === null ? 'ready' : 'error';
    error = shown.error ?? '';
  }

  useEffect(() => {
    if (!active || manifest) return;
    const abort = new AbortController();
    fetch(`${import.meta.env.BASE_URL}data/viewmodels/manifest.json`, { signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Viewmodel assets could not be loaded (${response.status}).`);
        const data: ViewmodelManifest = await response.json();
        setManifest(data);
      }).catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setFetchError(String(reason));
      });
    return () => { abort.abort(); setFetchError(null); };
  }, [active, manifest]);

  useEffect(() => {
    if (!active || !manifest) return;
    if (!weapon) return;
    let cancelled = false;
    viewer.showFirstPerson(manifest.arms[weapon.armsKey], weapon, team).then(() => {
      if (!cancelled) setShown({ weapon, team, viewer, error: null });
    }).catch((reason: unknown) => {
      if (!cancelled) setShown({ weapon, team, viewer, error: String(reason) });
    });
    return () => { cancelled = true; viewer.clearFirstPerson(); setShown(null); };
  }, [active, manifest, weapon, team, viewer]);

  useEffect(() => {
    if (active && status === 'ready') viewer.configureFirstPerson(fov, minimized, activity, paused, fishPhysics, showHands, spinBarrel);
  }, [active, status, viewer, fov, minimized, activity, paused, fishPhysics, showHands, spinBarrel]);

  return <InspectorSection title="Preview" icon={Eye}>
      <Control group label="View mode">
        <ToggleGroup
          label="View mode"
          value={active ? 'first-person' : 'inspect'}
          options={[
            { value: 'inspect', label: 'Inspect' },
            {
              value: 'first-person',
              label: 'First Person',
              disabled: disabled || weaponKey === 'paintkit_tool',
              title: disabled ? 'Select a weapon and close visual editors to use first-person preview' : 'Preview the painted weapon with class arms',
            },
          ]}
          onChange={(mode) => onEnabledChange(mode === 'first-person')}
        />
      </Control>
      {active && <>
        {choices.length > 1 && <Control label="Class">
          <SelectField value={weapon?.class ?? ''} onChange={setPlayerClass} options={choices.map(choice => ({
            value: choice.class,
            label: choice.class === 'demo' ? 'Demoman' : choice.class[0].toUpperCase() + choice.class.slice(1),
          }))} />
        </Control>}
        {animations.length > 0 && <div data-slot="first-person-animations" role="group" aria-label="Animation">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <ControlLabel>Animation <span className="text-text tabular-nums">{animations.length}</span></ControlLabel>
            <Button data-slot="first-person-playback" className="text-11 text-text"
              aria-label={paused ? 'Play Animation' : 'Pause Animation'}
              title={paused ? 'Play Animation' : 'Pause Animation'}
              disabled={status !== 'ready'}
              onClick={() => setPaused(value => !value)}>
              {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
              <span>{paused ? 'Play' : 'Pause'}</span>
            </Button>
          </div>
          {/* On mobile the Controls sheet scrolls as a whole instead of nesting a scroll box. */}
          <div className="scrollbar-slim max-h-65 overflow-y-auto overscroll-contain rounded-sm border border-border p-2 mobile:max-h-none">
            {animationGroups.map(group => <div key={group.label} className="not-first:mt-2.5" role="group" aria-label={group.label}>
              <div className="mb-1 text-10 text-dim">{group.label}</div>
              <div className="grid grid-cols-2 gap-1">
                {group.options.map(option => <button key={option.id} type="button"
                  className="min-h-control cursor-pointer rounded-[3px] border border-border bg-transparent px-1.75 py-1.25 text-left text-11 wrap-anywhere text-text focus-ring not-disabled:hover:border-strong not-disabled:hover:bg-panel focus-visible:-outline-offset-2 disabled:cursor-default disabled:opacity-50 aria-pressed:border-accent aria-pressed:bg-accent aria-pressed:text-accent-text" aria-pressed={option.id === selectedAnimation?.id}
                  disabled={status !== 'ready'} onClick={() => setAnimation(option.id)}>
                  {option.label}
                </button>)}
              </div>
            </div>)}
          </div>
        </div>}
        {weaponKey === 'c_holymackerel' && <SwitchRow label="Fish Bone Physics" checked={fishPhysics} onChange={setFishPhysics} />}
        <Control label={<><span className="flex-auto">Viewmodel FOV</span><span className="text-text tabular-nums">{fov}</span></>}>
          <Slider min={54} max={120} step={1} value={fov} onChange={setFov} ariaLabel="Viewmodel FOV" markers={[54, 70, 90]} />
        </Control>
        <SwitchRow label="Minimized Viewmodel" checked={minimized} onChange={setMinimized} />
        {status === 'ready' && viewer.firstPersonHasSpinningBarrel && <SwitchRow label="Spin Barrel" checked={spinBarrel} onChange={setSpinBarrel} />}
        <SwitchRow label="Show Hands" checked={showHands} onChange={setShowHands} />
        {status === 'loading' && <span className="text-11 leading-normal text-dim" role="status">Loading arms and weapon...</span>}
        {status === 'error' && <span className="wrap-anywhere text-fail" role="alert">{error}</span>}
      </>}
  </InspectorSection>;
}
