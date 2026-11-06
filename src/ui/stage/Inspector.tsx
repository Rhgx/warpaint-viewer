import { Fragment, memo, useId, useState } from 'react';
import type { ReactNode } from 'react';
import { Aperture, Box, Camera, Paintbrush } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import type { PreloadIntent } from '../../hooks/useIntentPreload';
import {
  Control, CONTROL, ControlLabel, IconSelectField, SeedInput, SelectField, SwatchSelectField, TeamToggle, WearSliderField,
} from '../common/controls';
import type { IconOption, SwatchOption } from '../common/controls';
import { LIGHTING_PRESET_OPTIONS } from '../../viewer/lighting/lightingPresetIds';
import { SHEEN_PRESETS, UNUSUAL_PRESETS, VIEW_ANGLES } from '../../viewer/presets';
import type { Manifest } from '../../data/types';
import { TURNTABLE_SECONDS, type ControlsState, type TurntableFormat, type TurntableProfile, type TurntableQuality } from '../../viewer/controls';
import type { LightingStore } from '../../viewer/lighting/lightingStore';
import { CUSTOM_LIGHTING_ID } from '../../viewer/lighting/customLightingModel';
import { LightingRigSummary } from '../lighting/LightingRigSummary';
import { DEFAULT_KILLS, supportsStatClock, type StatClockSetting } from '../../data/statClock';
import { StatClockFields } from '../common/StatClockFields';
import { TURNTABLE_FORMATS, turntablePlaybackFps } from '../../export/turntableFormats';
import { matchesMobileLayout, TOUCH_ONLY_DEVICE } from '../../device';
import { cn } from '../primitives/cn';
import { Input } from '../primitives/Input';
import { InlineNotice } from '../primitives/Notice';
import { PanelSection, PanelSectionHeader } from '../primitives/PanelSection';
import { Slider } from '../primitives/Slider';
import { ToggleGroup } from '../primitives/ToggleGroup';

const rgbCss = ([r, g, b]: [number, number, number]) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

// Mobile browsers cap canvas area well below 8K, so touch-only devices stop at 4K.
const SCREENSHOT_SIZE_OPTIONS = [
  { value: '1280', label: '720p' },
  { value: '1920', label: '1080p' },
  { value: '2560', label: '2K' },
  { value: '3840', label: '4K' },
  { value: '7680', label: '8K' },
  { value: '15360', label: '16K' },
].filter((option) => !TOUCH_ONLY_DEVICE || Number(option.value) <= 3840);

const TURNTABLE_QUALITY_OPTIONS = [
  { value: 'standard', label: 'Standard' },
  { value: 'high', label: 'High' },
  { value: 'maximum', label: 'Maximum' },
];

// Shown under each format in the open list; short enough never to wrap.
const TURNTABLE_FORMAT_DESCRIPTIONS: Record<TurntableFormat, string> = {
  gif: 'Plays everywhere, 256 colors',
  webp: 'Full color, soft edges',
  apng: 'Lossless, soft edges, large',
  mp4: 'Smallest, no transparency',
};

// A collapsible group. Expanded unless defaultOpen says otherwise; state is local and not persisted.
export function InspectorSection({ title, icon, children, defaultOpen = true }: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <PanelSection>
      <PanelSectionHeader open={open} icon={icon} onClick={() => setOpen((o) => !o)}>
        <span>{title}</span>
      </PanelSectionHeader>
      {open && <div className="flex flex-col gap-2.5 px-0.5 pt-2 pb-2.5">{children}</div>}
    </PanelSection>
  );
}

// The seed is a 64-bit decimal. While focused, the field holds a free-typed draft that
// commits on Enter or a non-empty blur; an invalid draft reverts to the last committed seed.
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
    <SeedInput
      aria-label="Paint seed"
      randomizeLabel="Randomize seed"
      onRandomize={onRandomize}
      onUndo={onUndo}
      canUndo={canUndo}
      value={focused ? draft : seed}
      onFocus={() => {
        setDraft(seed);
        setFocused(true);
      }}
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
  );
}

// Hex readout for the turntable color; commits only on a full #rrggbb match.
function TurntableColorHexField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  const [syncedValue, setSyncedValue] = useState(value);
  if (syncedValue !== value) {
    setSyncedValue(value);
    setDraft(value);
  }

  return (
    <Input
      className="h-6.5 min-h-0 min-w-0 flex-1 px-1.25 py-0 font-mono text-10.5 font-light tabular-nums touch:h-control"
      value={draft}
      maxLength={7}
      spellCheck={false}
      aria-label="Turntable color hex"
      onChange={(event) => {
        const next = event.currentTarget.value;
        setDraft(next);
        if (/^#[0-9a-f]{6}$/i.test(next)) onChange(next.toLowerCase());
      }}
      onBlur={() => {
        if (!/^#[0-9a-f]{6}$/i.test(draft)) setDraft(value);
      }}
    />
  );
}

export const Inspector = memo(function Inspector({
  previewControls,
  firstPersonActive = false,
  manifest,
  weaponOptions,
  onPreloadWeapon,
  hasTeamTextures,
  state,
  turntableFormats,
  viewAngle,
  onChange,
  onRandomizeSeed,
  onUndoSeed,
  canUndoSeed,
  onViewAngle,
  lightingStore,
  onToggleLightingPanel,
  onSelectLight,
}: {
  previewControls?: ReactNode;
  firstPersonActive?: boolean;
  manifest: Manifest;
  weaponOptions: IconOption[];
  onPreloadWeapon?: PreloadIntent;
  hasTeamTextures: boolean;
  state: ControlsState;
  turntableFormats: TurntableFormat[];
  viewAngle: string;
  onChange: (patch: Partial<ControlsState>) => void;
  onRandomizeSeed: () => void;
  onUndoSeed: () => void;
  canUndoSeed: boolean;
  onViewAngle: (id: string) => void;
  lightingStore: LightingStore;
  onToggleLightingPanel: () => void;
  onSelectLight: (id: string) => void;
}) {
  // Rarely used sections start collapsed on mobile. Decided once, so resizing never folds them.
  const [compact] = useState(matchesMobileLayout);
  const teamNoteId = useId();
  const teamLocked = !hasTeamTextures && state.sheen !== 'team_shine';
  const presetOptions = [
    ...LIGHTING_PRESET_OPTIONS.map((p) => ({ value: p.id, label: p.label })),
    { value: CUSTOM_LIGHTING_ID, label: 'Custom' },
  ];
  const unusualOptions: IconOption[] = UNUSUAL_PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    icon: p.id === 'none' ? null : `${import.meta.env.BASE_URL}data/effects/thumbs/${p.id}.png`,
  }));
  const viewAngleOptions = VIEW_ANGLES.map((p) => ({ value: p.id, label: p.label }));
  const clock = state.statClocks[state.weaponKey];
  const clockLocked = supportsStatClock(state.weaponKey) ? null : 'Not on this weapon';
  const setClock = (next: Partial<StatClockSetting>) => onChange({
    statClocks: { ...state.statClocks, [state.weaponKey]: { on: !!clock?.on, kills: clock?.kills ?? DEFAULT_KILLS, ...next } },
  });

  const sheenOptions: SwatchOption[] = SHEEN_PRESETS.map((p) => ({
    value: p.id,
    label: p.label,
    color: p.id === 'none' ? null : rgbCss(p.id === 'team_shine' ? p.red : (state.team === 'blu' ? p.blu : p.red)),
    secondaryColor: p.id === 'team_shine' ? rgbCss(p.blu) : null,
  }));

  // First Person can only capture images, regardless of the stored format.
  const captureFormat = firstPersonActive ? 'image' : state.captureFormat;

  const profile = state.turntableProfiles[state.turntableFormat];
  const formatInfo = TURNTABLE_FORMATS[state.turntableFormat];
  // Patches only the current format's remembered settings.
  const patchProfile = <K extends keyof TurntableProfile,>(key: K, value: TurntableProfile[K]) =>
    onChange({ turntableProfiles: { ...state.turntableProfiles, [state.turntableFormat]: { ...profile, [key]: value } } });

  const turntableFrames = Math.max(2, Math.round(TURNTABLE_SECONDS * turntablePlaybackFps(state.turntableFormat, profile.fps)));
  const turntableEstimatedBytes = formatInfo.estimateBytes(profile, turntableFrames, TURNTABLE_SECONDS);
  const turntableOverDiscordLimit = turntableEstimatedBytes > 10 * 1024 * 1024;
  const turntableEstimatedMb = (turntableEstimatedBytes / (1024 * 1024)).toFixed(1);

  // First Person leads with its own controls. Keyed, so moving it keeps their state.
  const preview = <Fragment key="preview">{previewControls}</Fragment>;

  return (
    <>
      <InspectorSection title="Item" icon={Box}>
        <div className={CONTROL} data-slot="control" role="group" aria-label="Weapon">
          <ControlLabel>Weapon</ControlLabel>
          <IconSelectField
            value={state.weaponKey}
            onChange={(v) => onChange({ weaponKey: v })}
            options={weaponOptions}
            onPreload={onPreloadWeapon}
            ariaLabel="Weapon"
            stepLabels={{ previous: 'Previous weapon', next: 'Next weapon' }}
            searchPlaceholder="Filter weapons..."
          />
        </div>

        <Control group label="Wear">
          <WearSliderField
            value={state.wearIndex}
            names={manifest.wearNames}
            onChange={(wearIndex) => onChange({ wearIndex })}
          />
        </Control>

        {/* The note sits in the label row, so that locking moves nothing below it. Spelled out, since touch screens never show the tooltip. */}
        <Control group label={<><span className="flex-auto">Team</span>{teamLocked && <span id={teamNoteId} className="text-10">No separate BLU textures</span>}</>}>
          <TeamToggle
            team={state.team}
            disabled={teamLocked}
            disabledReason="This war paint has no separate BLU textures."
            describedBy={teamLocked ? teamNoteId : undefined}
            onChange={(t) => onChange({ team: t })}
          />
        </Control>

        <Control group label="Seed">
          <SeedField
            seed={state.seed}
            onCommit={(seed) => onChange({ seed })}
            onRandomize={onRandomizeSeed}
            onUndo={onUndoSeed}
            canUndo={canUndoSeed}
          />
        </Control>
      </InspectorSection>

      <InspectorSection title="Finish" icon={Paintbrush}>
        <Control label="Lighting">
          <SelectField
            value={state.preset}
            onChange={(v) => onChange({ preset: v })}
            options={presetOptions}
          />
        </Control>

        {state.preset === CUSTOM_LIGHTING_ID && (
          <LightingRigSummary
            store={lightingStore}
            onTogglePanel={onToggleLightingPanel}
            onSelectLight={onSelectLight}
          />
        )}

        <Control label="Sheen">
          <SwatchSelectField
            value={state.sheen}
            onChange={(v) => {
              // Leaving Team Shine re-locks the team toggle on single-team paints; snap it back.
              if (v !== 'team_shine' && !hasTeamTextures) onChange({ sheen: v, team: 'red' });
              else onChange({ sheen: v });
            }}
            options={sheenOptions}
          />
        </Control>

        <Control label="Effect">
          <IconSelectField
            value={state.unusual}
            onChange={(v) => onChange({ unusual: v })}
            options={unusualOptions}
          />
        </Control>

        <StatClockFields
          on={!!clock?.on}
          kills={clock?.kills ?? DEFAULT_KILLS}
          lockedReason={clockLocked}
          onToggle={(on) => setClock({ on })}
          onKills={(kills) => setClock({ kills })}
        />
      </InspectorSection>

      {preview}

      {/* First Person has its own camera, so none of these apply there. */}
      {!firstPersonActive && (
        <InspectorSection title="Camera" icon={Camera} defaultOpen={!compact}>
          <Control label="View Angle">
            <SelectField
              value={viewAngle}
              onChange={onViewAngle}
              options={viewAngleOptions}
            />
          </Control>

          <Control label={<><span className="flex-auto">Field of View</span><span className="text-text tabular-nums">{state.fov}</span></>}>
            <Slider
              value={state.fov}
              onChange={(fov) => onChange({ fov })}
              min={30}
              max={110}
              step={1}
              ariaLabel="Field of View"
              markers={[54, 70, 90]}
            />
          </Control>

          <Control group label={<span>Projection</span>}>
            <ToggleGroup
              label="Projection"
              value={state.projection}
              options={[
                { value: 'perspective', label: 'Perspective' },
                { value: 'orthographic', label: 'Orthographic' },
              ]}
              onChange={(projection) => onChange({ projection })}
            />
          </Control>

        </InspectorSection>
      )}

      <InspectorSection title="Capture" icon={Aperture} defaultOpen={!compact}>
        {/* First Person renders a live view, not the inspect pose an animated turntable needs, so it can only capture images. */}
        {!firstPersonActive && (
          <Control group label={<span>Output</span>}>
            <ToggleGroup
              label="Output"
              value={state.captureFormat}
              options={[
                { value: 'image', label: 'Image' },
                { value: 'animated', label: 'Animated' },
              ]}
              onChange={(captureFormat) => onChange({ captureFormat })}
            />
          </Control>
        )}

        {captureFormat === 'image' && (
          <Control label={<span>Image Size</span>}>
            <SelectField
              value={String(state.screenshotMaxEdge)}
              onChange={(value) => onChange({ screenshotMaxEdge: Number(value) })}
              options={SCREENSHOT_SIZE_OPTIONS}
            />
          </Control>
        )}

        {captureFormat === 'animated' && <>
          <Control label={<span>Format</span>}>
            <SelectField
              value={state.turntableFormat}
              onChange={(value) => onChange({ turntableFormat: value as TurntableFormat })}
              options={turntableFormats.map((format) => ({
                value: format,
                label: TURNTABLE_FORMATS[format].label,
                description: TURNTABLE_FORMAT_DESCRIPTIONS[format],
              }))}
            />
          </Control>

          <Control label={<span>Size</span>}>
            <SelectField
              value={String(profile.maxEdge)}
              onChange={(value) => patchProfile('maxEdge', Number(value))}
              options={formatInfo.sizes.map((n) => ({ value: String(n), label: `${n} px` }))}
            />
          </Control>

          <Control label={<span>Frame Rate</span>}>
            <SelectField
              value={String(profile.fps)}
              onChange={(value) => patchProfile('fps', Number(value))}
              options={formatInfo.frameRates.map((n) => ({ value: String(n), label: `${n} fps` }))}
            />
          </Control>

          {formatInfo.hasQuality && (
            <Control label={<span>Quality</span>}>
              <SelectField
                value={profile.quality}
                onChange={(value) => patchProfile('quality', value as TurntableQuality)}
                options={TURNTABLE_QUALITY_OPTIONS}
              />
            </Control>
          )}

          {formatInfo.alpha !== null && (
            <Control group label={<span>Background</span>}>
              <ToggleGroup
                label="Background"
                value={state.turntableTransparent ? 'transparent' : 'solid'}
                options={[
                  { value: 'transparent', label: 'Transparent' },
                  { value: 'solid', label: 'Solid' },
                ]}
                onChange={(background) => onChange({ turntableTransparent: background === 'transparent' })}
              />
            </Control>
          )}

          {(formatInfo.alpha === null || !state.turntableTransparent) && (
            <Control group label={<span>Background Color</span>}>
              <div className="flex items-center gap-1.5">
                <input
                  className="h-6.5 min-w-0 flex-[0_0_40px] cursor-pointer rounded-sm border border-border bg-panel p-0.5 focus-ring touch:h-control"
                  type="color"
                  value={state.turntableColor}
                  aria-label="Background color picker"
                  onChange={(event) => onChange({ turntableColor: event.currentTarget.value })}
                />
                <TurntableColorHexField
                  value={state.turntableColor}
                  onChange={(turntableColor) => onChange({ turntableColor })}
                />
              </div>
            </Control>
          )}

          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 rounded-sm border border-border bg-panel-2 px-2 py-1.5 text-11 text-dim tabular-nums" data-slot="capture-estimate">
            <span>{turntableFrames} frames</span>
            <span className={cn('font-semibold', turntableOverDiscordLimit ? 'text-warn' : 'text-text')}>~{turntableEstimatedMb} MB</span>
            {turntableOverDiscordLimit && <InlineNotice className="basis-full">Likely over Discord's 10 MB upload limit</InlineNotice>}
          </div>
        </>}
      </InspectorSection>
    </>
  );
});
