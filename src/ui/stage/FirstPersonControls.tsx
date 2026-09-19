import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import type { Viewer } from '../../viewer/Viewer';
import type { ViewmodelManifest } from '../../viewer/firstPerson';
import { Control, SelectField, SliderField, SwitchField } from '../common/controls';
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
  const [animation, setAnimation] = useState('ACT_VM_IDLE');
  const [fov, setFov] = useState(70);
  const [minimized, setMinimized] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fishPhysics, setFishPhysics] = useState(true);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const active = enabled;
  const choices = manifest?.weapons.filter(weapon => weapon.weaponKey === weaponKey) ?? [];
  const weapon = choices.find(choice => choice.class === playerClass) ?? choices[0];
  const activities = [
    ['ACT_VM_IDLE', 'Idle'],
    ['ACT_VM_INSPECT_START', 'Inspect Start'],
    ['ACT_VM_INSPECT_IDLE', 'Inspect'],
    ['ACT_VM_INSPECT_END', 'Inspect End'],
  ].filter(([key]) => weapon?.clips[key]);
  const selectedAnimation = weapon?.clips[animation] ? animation : 'ACT_VM_IDLE';
  const clips = weapon?.clips[selectedAnimation];
  const activity = (Array.isArray(clips) ? clips[0] : clips) ?? weapon?.activity ?? '';

  useEffect(() => {
    if (!active || manifest) return;
    const abort = new AbortController();
    setStatus('loading');
    fetch('/data/viewmodels/manifest.json', { signal: abort.signal })
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
    if (active && status === 'ready') viewer.configureFirstPerson(fov, minimized, activity, paused, fishPhysics);
  }, [active, status, viewer, fov, minimized, activity, paused, fishPhysics]);

  return <section className="inspector-section first-person-controls" aria-label="Preview">
    <div className="inspector-section-header">Preview</div>
    <div className="inspector-section-body">
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
        {activities.length > 0 && <div className="first-person-animation-row">
          <Control label="Animation">
            <SelectField value={selectedAnimation} onChange={setAnimation}
              options={activities.map(([value, label]) => ({ value, label }))} />
          </Control>
          <button type="button" className="btn first-person-playback"
            aria-label={paused ? 'Play Animation' : 'Pause Animation'}
            title={paused ? 'Play Animation' : 'Pause Animation'}
            onClick={() => setPaused(value => !value)}>
            {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          </button>
        </div>}
        {weaponKey === 'c_holymackerel' && <Control className="first-person-switch-row" label="Fish Bone Physics">
          <SwitchField checked={fishPhysics} onChange={setFishPhysics} ariaLabel="Fish Bone Physics" />
        </Control>}
        <Control className="first-person-fov" label={<><span>Viewmodel FOV</span><span className="first-person-fov-value">{fov}</span></>}>
          <SliderField min={54} max={120} step={1} value={fov} onChange={setFov} ariaLabel="Viewmodel FOV" />
        </Control>
        <Control className="first-person-switch-row" label="Minimized Viewmodel">
          <SwitchField checked={minimized} onChange={setMinimized} ariaLabel="Minimized Viewmodel" />
        </Control>
        {status === 'loading' && <span role="status">Loading arms and weapon...</span>}
        {status === 'error' && <span role="alert">{error}</span>}
      </>}
    </div>
  </section>;
}
