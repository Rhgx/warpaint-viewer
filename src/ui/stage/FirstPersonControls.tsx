import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye } from 'lucide-react';

import type { Viewer } from '../../viewer/Viewer';
import type { ViewmodelManifest, ViewmodelWeapon } from '../../viewer/firstPerson/firstPerson';
import { Control, SelectField } from '../common/controls';
import { FirstPersonBar, type PlaybackSpeed } from './FirstPersonBar';
import { firstPersonAnimationGroups } from './firstPersonAnimations';
import { InspectorSection } from './Inspector';
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

export function FirstPersonControls({ viewer, weaponKey, team, disabled, enabled, onEnabledChange, barSlot }: {
  viewer: Viewer;
  weaponKey: string;
  team: 'red' | 'blu';
  disabled: boolean;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  barSlot: HTMLElement | null;
}) {
  const [manifest, setManifest] = useState<ViewmodelManifest | null>(null);
  const [playerClass, setPlayerClass] = useState('');
  const [animation, setAnimation] = useState('ACT_VM_IDLE:0');
  const [fov, setFov] = useState(70);
  const [minimized, setMinimized] = useState(false);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  const [looping, setLooping] = useState(true);
  const [fishPhysics, setFishPhysics] = useState(true);
  const [showHands, setShowHands] = useState(true);
  const [spinBarrel, setSpinBarrel] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ weapon: ViewmodelWeapon; team: 'red' | 'blu'; viewer: Viewer; error: string | null } | null>(null);
  const active = enabled;
  const choices = useMemo(() => manifest?.weapons.filter(weapon => weapon.weaponKey === weaponKey) ?? [], [manifest, weaponKey]);
  const weapon = choices.find(choice => choice.class === playerClass) ?? choices[0];
  const weaponClips = weapon?.clips;
  const animationGroups = useMemo(() => firstPersonAnimationGroups(weaponClips ?? {}, weaponKey), [weaponClips, weaponKey]);
  const animations = animationGroups.flatMap(group => group.options);
  const selectedAnimation = animations.find(option => option.id === animation)
    ?? animations.find(option => option.clips[0] === weapon?.activity) ?? animations[0];
  const selectedClips = selectedAnimation?.clips;
  const idleClip = weapon?.activity;
  const clips = useMemo(() => selectedClips ?? (idleClip ? [idleClip] : []), [selectedClips, idleClip]);
  const togglePaused = useCallback(() => setPaused(value => !value), []);
  const pauseAtEnd = useCallback(() => setPaused(true), []);
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
    if (active && status === 'ready') viewer.configureFirstPerson(fov, minimized, clips, paused, fishPhysics, showHands, spinBarrel, speed, looping);
  }, [active, status, viewer, fov, minimized, clips, paused, fishPhysics, showHands, spinBarrel, speed, looping]);

  return <>
    <InspectorSection title="Preview" icon={Eye}>
      <Control group label="View Mode">
        <ToggleGroup
          label="View Mode"
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
    </InspectorSection>
    {active && status === 'ready' && barSlot && selectedAnimation && createPortal(
      <FirstPersonBar
        viewer={viewer}
        groups={animationGroups}
        animation={selectedAnimation.id}
        onAnimationChange={setAnimation}
        paused={paused}
        onTogglePaused={togglePaused}
        onEnded={pauseAtEnd}
        looping={looping}
        onLoopingChange={setLooping}
        speed={speed}
        onSpeedChange={setSpeed}
      />,
      barSlot,
    )}
  </>;
}
