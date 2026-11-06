import { useEffect, useState } from 'react';
import { Check, Pause, Play } from 'lucide-react';

import type { Viewer } from '../../viewer/Viewer';
import type { FirstPersonPlayback } from '../../viewer/firstPersonStage';
import { formatPlaybackTime, type firstPersonAnimationGroups } from './firstPersonAnimations';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectItemText, SelectPopup, SelectTrigger, SelectValue } from '../primitives/Select';
import { Slider } from '../primitives/Slider';
import { STAGE_PANEL, ToolbarButton } from '../primitives/Toolbar';

const PLAYBACK_SPEEDS = [1, 0.5, 0.25] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

// One frame of the 30 fps source animations, which is what an arrow key steps by.
const SCRUB_STEP = 1 / 30;

/**
 * The one part of the bar that re-renders while playing, so the frame loop's cost stops here. Rendering sleeps while
 * paused, and with it the subscription, so this stays quiet too.
 */
function PlaybackTimeline({ viewer, looping, onEnded }: { viewer: Viewer; looping: boolean; onEnded: () => void }) {
  const [{ position, duration, markers, loopRange }, setPlayback] = useState<FirstPersonPlayback>({ position: 0, duration: 0, markers: [], loopRange: null, ended: false });

  useEffect(() => viewer.subscribeFirstPersonPlayback((playback) => {
    setPlayback(playback);
    if (playback.ended) onEnded();
  }), [viewer, onEnded]);

  const seek = (next: number) => {
    viewer.seekFirstPerson(next);
    setPlayback((current) => ({ ...current, position: next }));
  };

  // Captured, as Base UI takes the press for itself. On the window, as the release can land anywhere.
  const startScrub = () => {
    viewer.setFirstPersonScrubbing(true);
    const end = () => {
      viewer.setFirstPersonScrubbing(false);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };

  return (
    <>
      {/* touch-none: a browser that takes the gesture for itself cancels the pointer, which would end the hold mid-drag. */}
      <div className="min-w-0 flex-1 touch-none px-1.5" data-slot="first-person-scrubber" onPointerDownCapture={startScrub}>
        <Slider min={0} max={Math.max(duration, SCRUB_STEP)} step={SCRUB_STEP} value={position} onChange={seek} ariaLabel="Animation Position" markers={markers} markerUnit=" s" stripes={looping ? loopRange : null} />
      </div>
      <span className="w-23 flex-none text-center text-11 whitespace-nowrap text-text tabular-nums @max-[520px]:hidden" data-slot="first-person-time">
        {formatPlaybackTime(position)} / {formatPlaybackTime(duration)}
      </span>
    </>
  );
}

export function FirstPersonBar({ viewer, groups, animation, onAnimationChange, paused, onTogglePaused, onEnded, looping, onLoopingChange, speed, onSpeedChange }: {
  viewer: Viewer;
  groups: ReturnType<typeof firstPersonAnimationGroups>;
  animation: string;
  onAnimationChange: (id: string) => void;
  paused: boolean;
  onTogglePaused: () => void;
  onEnded: () => void;
  looping: boolean;
  onLoopingChange: (looping: boolean) => void;
  speed: PlaybackSpeed;
  onSpeedChange: (speed: PlaybackSpeed) => void;
}) {
  const options = groups.flatMap((group) => group.options);

  useEffect(() => {
    // Clicking First Person leaves its button focused, where Space would press it again instead of playing.
    if (document.activeElement instanceof HTMLElement && !document.activeElement.matches(':focus-visible')) document.activeElement.blur();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[role="dialog"], [role="alertdialog"]')) return;
      // Space belongs to whatever else takes it. A range input is the exception, as it does nothing with it.
      if (!event.target.matches('input[type="range"]')
        && event.target.closest('a[href], button, input, select, textarea, summary, [contenteditable="true"], [tabindex]')) return;
      event.preventDefault();
      onTogglePaused();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onTogglePaused]);

  const label = paused ? 'Play Animation' : 'Pause Animation';
  return (
    <div className={cn(STAGE_PANEL, 'pointer-events-auto w-full max-w-156 items-center text-12 select-none')} data-slot="first-person-bar" role="group" aria-label="Animation Playback">
      <ToolbarButton data-slot="first-person-playback" className="flex-none" aria-label={label} title={label} onClick={onTogglePaused}>
        {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
      </ToolbarButton>
      <Select value={animation} onValueChange={(next) => { if (next !== null) onAnimationChange(next); }}>
        <SelectTrigger opensUp className="w-33 min-w-0 flex-none bg-transparent text-text @max-[300px]:w-24" aria-label="Animation">
          <SelectValue className="truncate">{() => options.find((option) => option.id === animation)?.label}</SelectValue>
        </SelectTrigger>
        {/* A mouse leaves the focus free, so that Space plays the animation just picked rather than reopening this. */}
        <SelectPopup side="top" className="max-h-[min(24rem,var(--available-height))]" finalFocus={(closeType) => closeType === 'keyboard'}>
          {groups.map((group) => (
            <SelectGroup key={group.label}>
              <SelectGroupLabel>{group.label}</SelectGroupLabel>
              {group.options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  <SelectItemText>{option.label}</SelectItemText>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectPopup>
      </Select>
      <PlaybackTimeline viewer={viewer} looping={looping} onEnded={onEnded} />
      <Button
        variant="toolbar"
        data-slot="first-person-loop"
        className="flex-none gap-1.25 px-1 text-11 @max-[300px]:hidden"
        role="checkbox"
        aria-checked={looping}
        onClick={(event) => {
          onLoopingChange(!looping);
          // A mouse leaves the focus free, so that Space still plays and pauses.
          if (event.detail > 0) event.currentTarget.blur();
        }}
      >
        <span className={cn('flex size-3.5 items-center justify-center rounded-xs border', looping ? 'border-accent bg-accent text-accent-text' : 'border-strong')} aria-hidden="true">
          {looping && <Check size={11} strokeWidth={3} />}
        </span>
        <span className={looping ? 'text-text' : undefined}>Loop</span>
      </Button>
      <ToolbarButton
        data-slot="first-person-speed"
        className="w-10 flex-none text-11 tabular-nums @max-[420px]:hidden"
        aria-label={`Playback Speed ${speed}x`}
        title="Playback Speed"
        aria-pressed={speed !== 1}
        onClick={(event) => {
          onSpeedChange(PLAYBACK_SPEEDS[(PLAYBACK_SPEEDS.indexOf(speed) + 1) % PLAYBACK_SPEEDS.length]);
          // A mouse leaves the focus free, so that Space still plays and pauses.
          if (event.detail > 0) event.currentTarget.blur();
        }}
      >
        {speed}x
      </ToolbarButton>
    </div>
  );
}
