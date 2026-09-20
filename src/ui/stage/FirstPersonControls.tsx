import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { Viewer } from '../../viewer/Viewer';
import type { ViewmodelManifest } from '../../viewer/firstPerson';
import { Control, SelectField, SliderField, SwitchField } from '../common/controls';
import { firstPersonAnimationGroups } from './firstPersonAnimations';
import { InspectorSection } from './Inspector';
import './FirstPersonControls.css';

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
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const active = enabled;
  const choices = manifest?.weapons.filter(weapon => weapon.weaponKey === weaponKey) ?? [];
  const weapon = choices.find(choice => choice.class === playerClass) ?? choices[0];
  const animationGroups = firstPersonAnimationGroups(weapon?.clips ?? {});
  const animations = animationGroups.flatMap(group => group.options);
  const selectedAnimation = animations.find(option => option.id === animation)
    ?? animations.find(option => option.clip === weapon?.activity) ?? animations[0];
  const activity = selectedAnimation?.clip ?? weapon?.activity ?? '';

  useEffect(() => {
    if (!active || manifest) return;
    const abort = new AbortController();
    setStatus('loading');
    fetch(`${import.meta.env.BASE_URL}data/viewmodels/manifest.json`, { signal: abort.signal })
      .then(async response => {
        if (!response.ok) throw new Error(`Viewmodel assets could not be loaded (${response.status}).`);
        const data: ViewmodelManifest = await response.json();
        setManifest(data);
      }).catch((reason: unknown) => {
        if (abort.signal.aborted) return;
        setError(String(reason)); setStatus('error');
      });
    return () => abort.abort();
  }, [active, manifest]);

  useEffect(() => {
    if (!active || !manifest) return;
    if (!weapon) { setError('No first-person model is available for this weapon.'); setStatus('error'); return; }
    let cancelled = false;
    setStatus('loading');
    viewer.showFirstPerson(manifest.arms[weapon.armsKey], weapon, team).then(() => {
      if (!cancelled) setStatus('ready');
    }).catch((reason: unknown) => {
      if (!cancelled) { setError(String(reason)); setStatus('error'); }
    });
    return () => { cancelled = true; viewer.clearFirstPerson(); };
  }, [active, manifest, weapon, team, viewer]);

  useEffect(() => {
    if (active && status === 'ready') viewer.configureFirstPerson(fov, minimized, activity, paused, fishPhysics, showHands, spinBarrel);
  }, [active, status, viewer, fov, minimized, activity, paused, fishPhysics, showHands, spinBarrel]);

  return <InspectorSection title="Preview" className="first-person-controls">
      <Control group label="View mode">
        <div className="ui-toggle-group" role="group" aria-label="View mode">
          <button type="button" className="ui-toggle-btn" data-pressed={!active || undefined}
            aria-pressed={!active} onClick={() => onEnabledChange(false)}>Inspect</button>
          <button type="button" className="ui-toggle-btn" data-pressed={active || undefined}
            aria-pressed={active} disabled={disabled || weaponKey === 'paintkit_tool'}
            title={disabled ? 'Select a weapon and close visual editors to use first-person preview' : 'Preview the painted weapon with class arms'}
            onClick={() => onEnabledChange(true)}>First Person</button>
        </div>
      </Control>
      {active && <>
        {choices.length > 1 && <Control label="Class">
          <SelectField value={weapon?.class ?? ''} onChange={setPlayerClass} options={choices.map(choice => ({
            value: choice.class,
            label: choice.class === 'demo' ? 'Demoman' : choice.class[0].toUpperCase() + choice.class.slice(1),
          }))} />
        </Control>}
        {animations.length > 0 && <div className="first-person-animations" role="group" aria-label="Animation">
          <div className="first-person-animation-header">
            <span>Animation <span className="first-person-animation-count">{animations.length}</span></span>
            <button type="button" className="btn first-person-playback"
              aria-label={paused ? 'Play Animation' : 'Pause Animation'}
              title={paused ? 'Play Animation' : 'Pause Animation'}
              disabled={status !== 'ready'}
              onClick={() => setPaused(value => !value)}>
              {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
              <span>{paused ? 'Play' : 'Pause'}</span>
            </button>
          </div>
          <div className="first-person-animation-list">
            {animationGroups.map(group => <div key={group.label} className="first-person-animation-group" role="group" aria-label={group.label}>
              <div className="first-person-animation-group-label">{group.label}</div>
              <div className="first-person-animation-options">
                {group.options.map(option => <button key={option.id} type="button"
                  className="first-person-animation-option" aria-pressed={option.id === selectedAnimation?.id}
                  disabled={status !== 'ready'} onClick={() => setAnimation(option.id)}>
                  {option.label}
                </button>)}
              </div>
            </div>)}
          </div>
        </div>}
        {weaponKey === 'c_holymackerel' && <Control className="first-person-switch-row" label="Fish Bone Physics">
          <SwitchField checked={fishPhysics} onChange={setFishPhysics} ariaLabel="Fish Bone Physics" />
        </Control>}
        <Control className="first-person-fov" label={<><span>Viewmodel FOV</span><span className="first-person-fov-value">{fov}</span></>}>
          <SliderField min={54} max={120} step={1} value={fov} onChange={setFov} ariaLabel="Viewmodel FOV" markers={[54, 70, 90]} />
        </Control>
        <Control className="first-person-switch-row" label="Minimized Viewmodel">
          <SwitchField checked={minimized} onChange={setMinimized} ariaLabel="Minimized Viewmodel" />
        </Control>
        {status === 'ready' && viewer.firstPersonHasSpinningBarrel && <Control className="first-person-switch-row" label="Spin Barrel">
          <SwitchField checked={spinBarrel} onChange={setSpinBarrel} ariaLabel="Spin Barrel" />
        </Control>}
        <Control className="first-person-switch-row" label="Show Hands">
          <SwitchField checked={showHands} onChange={setShowHands} ariaLabel="Show Hands" />
        </Control>
        {status === 'loading' && <span role="status">Loading arms and weapon...</span>}
        {status === 'error' && <span role="alert">{error}</span>}
      </>}
  </InspectorSection>;
}
