import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Camera, ChevronDown, Crosshair, Dices, Droplets, Flame, Hash, Sparkles, Sun, Undo2, Users,
} from 'lucide-react';
import {
  Control, IconSelectField, SelectField, SliderField, SwatchSelectField, TeamToggle, WearSliderField,
} from '../common/controls';
import type { IconOption, SwatchOption } from '../common/controls';
import { LIGHTING_PRESETS } from '../../viewer/lighting/lighting';
import { SHEEN_PRESETS, UNUSUAL_PRESETS, VIEW_ANGLES } from '../../viewer/presets';
import type { Manifest } from '../../data/types';
import { TURNTABLE_SECONDS, type ControlsState, type TurntableFormat, type TurntableProfile, type TurntableQuality } from '../../viewer/controls';
import type { LightingStore } from '../../viewer/lighting/lightingStore';
import { CUSTOM_LIGHTING_ID } from '../../viewer/lighting/customLighting';
import { LightingRigSummary } from '../lighting/LightingRigSummary';
import { TURNTABLE_FORMATS, turntablePlaybackFps } from '../../hooks/useScreenshotActions';

const rgbCss = ([r, g, b]: [number, number, number]) =>
  `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;

const SCREENSHOT_SIZE_OPTIONS = [
  { value: '1280', label: '720p' },
  { value: '1920', label: '1080p' },
  { value: '2560', label: '2K' },
  { value: '3840', label: '4K' },
  { value: '7680', label: '8K' },
  { value: '15360', label: '16K' },
];

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

// A collapsible group of controls. Expanded by default; each section keeps
// its own local, unpersisted open/closed state.
export function InspectorSection({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(true);
  return (
    <div className={`inspector-section ${className}`}>
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

// Hex readout for the turntable color swatch; mirrors the validation in
// lightingFields.tsx's ColorRow (commit only on a full #rrggbb match, revert
// the draft on blur otherwise).
function TurntableColorHexField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  return (
    <input
      className="lighting-readout lighting-color-hex"
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

export function Inspector({
  previewControls,
  firstPersonActive = false,
  manifest,
  weaponOptions,
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
  const presetOptions = [
    ...LIGHTING_PRESETS.map((p) => ({ value: p.id, label: p.label })),
    { value: CUSTOM_LIGHTING_ID, label: 'Custom' },
  ];
  const unusualOptions = UNUSUAL_PRESETS.map((p) => ({ value: p.id, label: p.label }));
  const viewAngleOptions = VIEW_ANGLES.map((p) => ({ value: p.id, label: p.label }));

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

  return (
    <>
      <InspectorSection title="Item">
        <div className="control" role="group" aria-label="Weapon">
          <span className="control-label"><Crosshair size={12} /><span>Weapon</span></span>
          <IconSelectField
            value={state.weaponKey}
            onChange={(v) => onChange({ weaponKey: v })}
            options={weaponOptions}
            ariaLabel="Weapon"
            stepLabels={{ previous: 'Previous weapon', next: 'Next weapon' }}
            searchPlaceholder="Filter weapons..."
          />
        </div>

        <Control group label={<><Droplets size={12} /><span>Wear</span></>}>
          <WearSliderField
            value={state.wearIndex}
            names={manifest.wearNames}
            onChange={(wearIndex) => onChange({ wearIndex })}
          />
        </Control>

        <Control group label={<><Users size={12} /><span>Team</span></>}>
          <TeamToggle
            team={state.team}
            disabled={!hasTeamTextures && state.sheen !== 'team_shine'}
            disabledReason="This warpaint uses one shared texture; team choice only affects the Team Shine sheen"
            onChange={(t) => onChange({ team: t })}
          />
        </Control>

        <Control group label={<><Hash size={12} /><span>Seed</span></>}>
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

        {state.preset === CUSTOM_LIGHTING_ID && (
          <LightingRigSummary
            store={lightingStore}
            onTogglePanel={onToggleLightingPanel}
            onSelectLight={onSelectLight}
          />
        )}

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

      {previewControls}

      {/* First Person has its own camera, so none of these apply there. */}
      {!firstPersonActive && (
        <InspectorSection title="Camera">
          <Control label={<><Camera size={12} /><span>View angle</span></>}>
            <SelectField
              value={viewAngle}
              onChange={onViewAngle}
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
              markers={[54, 70, 90]}
            />
          </Control>

          <Control group label={<span>Projection</span>}>
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

        </InspectorSection>
      )}

      <InspectorSection title="Capture">
        {/* First Person renders a live view, not the inspect pose an animated turntable needs, so it can only capture images. */}
        {!firstPersonActive && (
          <Control group label={<span>Output</span>}>
            <div className="ui-toggle-group" role="group" aria-label="Output">
              <button
                type="button"
                className="ui-toggle-btn"
                data-pressed={state.captureFormat === 'image' || undefined}
                aria-pressed={state.captureFormat === 'image'}
                onClick={() => onChange({ captureFormat: 'image' })}
              >
                Image
              </button>
              <button
                type="button"
                className="ui-toggle-btn"
                data-pressed={state.captureFormat === 'animated' || undefined}
                aria-pressed={state.captureFormat === 'animated'}
                onClick={() => onChange({ captureFormat: 'animated' })}
              >
                Animated
              </button>
            </div>
          </Control>
        )}

        {captureFormat === 'image' && (
          <Control label={<span>Image size</span>}>
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

          <Control label={<span>Frame rate</span>}>
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
              <div className="ui-toggle-group" role="group" aria-label="Background">
                <button
                  type="button"
                  className="ui-toggle-btn"
                  data-pressed={state.turntableTransparent || undefined}
                  aria-pressed={state.turntableTransparent}
                  onClick={() => onChange({ turntableTransparent: true })}
                >
                  Transparent
                </button>
                <button
                  type="button"
                  className="ui-toggle-btn"
                  data-pressed={!state.turntableTransparent || undefined}
                  aria-pressed={!state.turntableTransparent}
                  onClick={() => onChange({ turntableTransparent: false })}
                >
                  Solid
                </button>
              </div>
            </Control>
          )}

          {(formatInfo.alpha === null || !state.turntableTransparent) && (
            <Control group label={<span>Background color</span>}>
              <div className="inspector-color-row">
                <input
                  className="lighting-color-swatch"
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

          <div className={`capture-estimate${turntableOverDiscordLimit ? ' is-over' : ''}`}>
            <span>{turntableFrames} frames</span>
            <span className="capture-estimate-size">~{turntableEstimatedMb} MB</span>
            {turntableOverDiscordLimit && <span className="capture-estimate-note">Likely over Discord's 10 MB upload limit</span>}
          </div>
        </>}
      </InspectorSection>
    </>
  );
}
