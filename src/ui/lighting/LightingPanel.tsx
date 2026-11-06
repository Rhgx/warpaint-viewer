import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Copy, Eye, EyeOff, Lightbulb, Plus, Redo2, RotateCcw, Trash2, Undo2, X } from 'lucide-react';

import type { LightingStore } from '../../viewer/lighting/lightingStore';
import {
  CUSTOM_DIRECTION_LIMIT,
  CUSTOM_LIGHT_POSITION_LIMIT,
  CUSTOM_LIGHT_RANGE_LIMIT,
  CUSTOM_SOFTNESS_MAX,
  MAX_CUSTOM_LIGHTS,
  MAX_SPOT_ANGLE_DEGREES,
  MIN_SPOT_ANGLE_DEGREES,
  createDefaultCustomLightingRig,
  type CustomLight,
  type CustomLightType,
} from '../../viewer/lighting/customLightingModel';
import { SelectField } from '../common/controls';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { Input } from '../primitives/Input';
import { Slider } from '../primitives/Slider';
import { ColorRow, FieldRow, LightDot, LightIcon, LightTypeBadge, ScalarRow, VectorRow } from './lightingFields';
import {
  DEFAULT_FINITE_RANGE,
  ROLE_TEMPLATES,
  TYPE_OPTIONS,
  TYPE_TEMPLATES,
  changeLightType,
  nextLightId,
  templateLight,
  uniqueLightName,
  type LightTemplate,
} from './lightingRig';
import { SECTION_TITLE } from '../primitives/textStyles';

const INTENSITY_MAX = 10;
const RESET_ARM_MS = 3000;

const HEAD_BUTTON = 'size-5.5 flex-none touch:size-9';
const ADD_GROUP = 'text-10 text-dim not-first:mt-0.75';
const ADD_OPTION = 'h-5.5 min-h-0 min-w-0 gap-0.75 bg-panel px-1 text-10 text-text touch:h-9';
const ACTION_BUTTON = 'flex-1 gap-1 bg-panel text-10 not-disabled:hover:bg-panel-2 touch:min-h-9';
const RANGE_TOGGLE = 'h-5 w-5.5 flex-none bg-panel text-12 leading-none text-dim touch:size-9';

interface LightingPanelProps {
  store: LightingStore;
}

// Name edits stay local until commit, so clearing the field does not snap back to the fallback name.
function NameInput({ light, onCommit }: { light: CustomLight; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(light.name);
  const [syncedName, setSyncedName] = useState(light.name);
  if (syncedName !== light.name) {
    setSyncedName(light.name);
    setDraft(light.name);
  }

  const commit = () => {
    const next = draft.trim();
    if (next && next !== light.name) onCommit(next);
    else setDraft(light.name);
  };

  return (
    <Input
      className="h-5.5 min-h-0 min-w-0 px-1.5 py-0 [font-family:inherit] text-11 font-semibold text-text focus:border-accent touch:h-8"
      value={draft}
      maxLength={64}
      aria-label="Light name"
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(light.name);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

/** Lighting workspace over the stage, mounted for the Custom preset; open, it shows light helpers. */
export function LightingPanel({ store }: LightingPanelProps) {
  const rig = useStore(store, (state) => state.rig);
  const open = useStore(store, (state) => state.open);
  const selectedLightId = useStore(store, (state) => state.selectedLightId);
  const canUndo = useStore(store, (state) => state.canUndo);
  const canRedo = useStore(store, (state) => state.canRedo);
  const { apply: onChange, preview: onPreviewChange, undo: onUndo, redo: onRedo,
    select: onSelectedLightIdChange, setOpen, deleteSelected, duplicateSelected } = store.getState();
  const [addOpen, setAddOpen] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);
  const resetTimer = useRef(0);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => () => {
    window.clearTimeout(resetTimer.current);
  }, []);

  // Closing drops any half-finished affordance, so reopening starts clean.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setAddOpen(false);
      setResetArmed(false);
    }
  }

  const selected = rig.lights.find((light) => light.id === selectedLightId) ?? null;
  const full = rig.lights.length >= MAX_CUSTOM_LIGHTS;

  const updateLight = (id: string, updater: (light: CustomLight) => CustomLight) => {
    onChange({ ...rig, lights: rig.lights.map((light) => (light.id === id ? updater(light) : light)) });
  };

  const updateSelected = (updater: (light: CustomLight) => CustomLight) => {
    if (selected) updateLight(selected.id, updater);
  };

  const previewSelected = (updater: (light: CustomLight) => CustomLight) => {
    if (!selected) return;
    onPreviewChange({
      ...rig,
      lights: rig.lights.map((light) => (light.id === selected.id ? updater(light) : light)),
    });
  };

  const addLight = (template: LightTemplate) => {
    if (full) return;
    const id = nextLightId(rig.lights, template);
    const light = templateLight(template, id);
    onChange({ ...rig, lights: [...rig.lights, { ...light, name: uniqueLightName(rig.lights, light.name) }] });
    onSelectedLightIdChange(id);
    setAddOpen(false);
  };

  // Reset is destructive and saves straight to storage, so it arms on the first click.
  const resetRig = () => {
    window.clearTimeout(resetTimer.current);
    if (!resetArmed) {
      setResetArmed(true);
      resetTimer.current = window.setTimeout(() => setResetArmed(false), RESET_ARM_MS);
      return;
    }
    const next = createDefaultCustomLightingRig();
    setResetArmed(false);
    onChange(next);
    onSelectedLightIdChange(next.lights[0]?.id ?? null);
  };

  return (
    // Docked under the stage toolbar: its top offset is the button height plus padding, border and an 8px gap. Inset past the panel edge handle, which is 20px wide, so that it never covers the handle.
    // On a phone in portrait it docks along the bottom of the canvas instead, clear of the tab strip.
    <section
      className="absolute top-[calc(28px+var(--stage-toolbar-btn))] right-6.5 z-4 hidden max-h-[calc(100%-76px)] w-[min(248px,calc(100vw-16px))] flex-col rounded-md border border-strong bg-panel/92 text-11 text-text shadow-pop backdrop-blur-[8px] data-open:flex touch:w-[min(300px,calc(100vw-16px))] docked:right-2.5 mobile:top-[calc(26px+var(--stage-toolbar-btn)+env(safe-area-inset-top))] mobile:right-[calc(8px+env(safe-area-inset-right))] mobile:max-h-[calc(100%-34px-var(--stage-toolbar-btn)-env(safe-area-inset-top))] phone-portrait:top-auto phone-portrait:right-2 phone-portrait:bottom-2 phone-portrait:left-2 phone-portrait:max-h-[45%] phone-portrait:w-auto"
      data-slot="lighting-panel"
      data-open={open || undefined}
      aria-label="Custom lights"
    >
      <header className="flex flex-none items-center gap-1.5 border-b border-border py-1 pr-1 pl-2.25">
        <Lightbulb size={14} className="flex-none text-dim" aria-hidden="true" />
        <h2 className={cn('m-0', SECTION_TITLE)}>Lights</h2>
        <span className="mr-auto text-10 text-dim tabular-nums">{rig.lights.length} of {MAX_CUSTOM_LIGHTS}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className={HEAD_BUTTON}
          title="Undo lighting change (Ctrl+Z)"
          aria-label="Undo lighting change"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 size={13} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className={HEAD_BUTTON}
          title="Redo lighting change (Ctrl+Y)"
          aria-label="Redo lighting change"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 size={13} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className={cn(HEAD_BUTTON, 'data-armed:bg-panel-2 data-armed:text-fail not-disabled:data-armed:hover:text-fail')}
          data-armed={resetArmed || undefined}
          title={resetArmed ? 'Click again to reset the rig' : 'Reset to the default rig'}
          aria-label={resetArmed ? 'Confirm reset to the default rig' : 'Reset to the default rig'}
          onClick={resetRig}
        >
          <RotateCcw size={13} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className={HEAD_BUTTON}
          title="Close lights panel"
          aria-label="Close lights panel"
          onClick={() => setOpen(false)}
        >
          <X size={14} />
        </Button>
      </header>

      <div className="scrollbar-slim flex flex-col gap-1.5 overflow-y-auto p-1.75 mobile:overscroll-contain" data-slot="lighting-panel-body">
        <ul className="m-0 flex list-none flex-col gap-px p-0">
          {rig.lights.map((light) => (
            <li
              key={light.id}
              className="flex items-center pr-px transition-fast data-selected:bg-accent-soft data-selected:shadow-[inset_2px_0_0_var(--accent)]"
              data-slot="lighting-row"
              data-selected={light.id === selectedLightId || undefined}
            >
              <button
                type="button"
                className="flex h-6.5 min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent pr-1 pl-1.75 text-left text-11 text-text focus-ring focus-visible:-outline-offset-2 data-off:text-dim touch:h-10.5"
                data-slot="lighting-row-select"
                aria-pressed={light.id === selectedLightId}
                data-off={!light.enabled || undefined}
                onClick={() => onSelectedLightIdChange(light.id)}
              >
                <LightDot color={light.color} off={!light.enabled} />
                <span className="min-w-0 flex-1 truncate in-data-selected:font-semibold">{light.name}</span>
                <LightTypeBadge type={light.type} />
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                className="flex-none touch:size-9"
                data-slot="lighting-row-visibility"
                title={light.enabled ? 'Turn off' : 'Turn on'}
                aria-label={light.enabled ? `Turn off ${light.name}` : `Turn on ${light.name}`}
                onClick={() => updateLight(light.id, (current) => ({ ...current, enabled: !current.enabled }))}
              >
                {light.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </Button>
            </li>
          ))}
        </ul>

        {rig.lights.length === 0 && (
          <p className="m-0 px-1.5 py-2 text-center text-10.5 text-dim">No lights. The model is lit by ambient only.</p>
        )}

        <div
          className="flex flex-col gap-1.25"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !addOpen) return;
            setAddOpen(false);
            addButtonRef.current?.focus();
          }}
        >
          <Button
            ref={addButtonRef}
            size="sm"
            className="border-dashed border-strong bg-transparent px-2 text-10.5 not-disabled:hover:border-solid not-disabled:hover:bg-panel-2 aria-expanded:border-solid aria-expanded:border-accent aria-expanded:text-text touch:min-h-9"
            data-slot="lighting-add"
            aria-expanded={addOpen}
            disabled={full}
            title={full ? `Limit is ${MAX_CUSTOM_LIGHTS} lights` : undefined}
            onClick={() => setAddOpen((current) => !current)}
          >
            <Plus size={13} />
            <span>Add Light</span>
          </Button>
          {addOpen && !full && (
            <div className="flex flex-col gap-0.75 rounded-sm border border-border bg-panel-2 p-1.5">
              <span className={ADD_GROUP}>Roles</span>
              <div className="grid grid-cols-3 gap-1">
                {ROLE_TEMPLATES.map((option) => (
                  <Button
                    key={option.value}
                    size="sm"
                    className={ADD_OPTION}
                    data-slot="lighting-add-option"
                    onClick={() => addLight(option.value)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <span className={ADD_GROUP}>Blank</span>
              <div className="grid grid-cols-3 gap-1">
                {TYPE_TEMPLATES.map((option) => (
                  <Button
                    key={option.value}
                    size="sm"
                    className={ADD_OPTION}
                    data-slot="lighting-add-option"
                    onClick={() => addLight(option.value)}
                  >
                    <LightIcon type={option.type} size={11} />
                    <span>{option.label}</span>
                  </Button>
                ))}
              </div>
            </div>
          )}
        </div>

        {selected && (
          <div className="flex flex-col gap-1.25 border-t border-border pt-1.5">
            <NameInput
              key={selected.id}
              light={selected}
              onCommit={(name) => updateSelected((light) => ({ ...light, name }))}
            />

            <FieldRow label="Type">
              <SelectField
                className="min-h-5.5 min-w-0 flex-1 px-1.75 py-0.5 text-11 touch:min-h-control"
                value={selected.type}
                options={TYPE_OPTIONS}
                onChange={(value) => updateSelected((light) => changeLightType(light, value as CustomLightType))}
              />
            </FieldRow>

            <ColorRow
              value={selected.color}
              onPreviewChange={(color) => previewSelected((light) => ({ ...light, color }))}
              onChange={(color) => updateSelected((light) => ({ ...light, color }))}
            />

            <ScalarRow
              label="Bright"
              title="Brightness"
              value={Math.min(selected.intensity, INTENSITY_MAX)}
              min={0}
              max={INTENSITY_MAX}
              step={0.05}
              onPreviewChange={(intensity) => previewSelected((light) => ({ ...light, intensity }))}
              onChange={(intensity) => updateSelected((light) => ({ ...light, intensity }))}
            />

            {selected.type === 'spot' && (
              <>
                <ScalarRow
                  label="Cone"
                  title="Cone angle in degrees"
                  value={selected.angleDegrees}
                  min={MIN_SPOT_ANGLE_DEGREES}
                  max={MAX_SPOT_ANGLE_DEGREES}
                  step={1}
                  onPreviewChange={(angleDegrees) => previewSelected((light) => (
                    light.type === 'spot' ? { ...light, angleDegrees } : light
                  ))}
                  onChange={(angleDegrees) => updateSelected((light) => (
                    light.type === 'spot' ? { ...light, angleDegrees } : light
                  ))}
                />
                <ScalarRow
                  label="Soft"
                  title="Cone edge softness"
                  value={selected.softness}
                  min={0}
                  max={CUSTOM_SOFTNESS_MAX}
                  step={0.01}
                  onPreviewChange={(softness) => previewSelected((light) => (
                    light.type === 'spot' ? { ...light, softness } : light
                  ))}
                  onChange={(softness) => updateSelected((light) => (
                    light.type === 'spot' ? { ...light, softness } : light
                  ))}
                />
              </>
            )}

            {'range' in selected && (
              selected.range === null ? (
                <div className="flex flex-col gap-0.5">
                  <FieldRow label="Range" title="Distance cutoff">
                    <span className="min-w-0 flex-1 truncate text-right text-10 text-dim">Reaches everything</span>
                    <Button
                      variant="toggle"
                      size="icon-sm"
                      className={RANGE_TOGGLE}
                      data-slot="lighting-range-toggle"
                      aria-pressed
                      title="Give this light a distance cutoff"
                      onClick={() => updateSelected((light) => (
                        'range' in light ? { ...light, range: DEFAULT_FINITE_RANGE } : light
                      ))}
                    >
                      &#8734;
                    </Button>
                  </FieldRow>
                  {/* Stays in place so that turning the cutoff on moves nothing below it. */}
                  <Slider disabled value={CUSTOM_LIGHT_RANGE_LIMIT} min={0} max={CUSTOM_LIGHT_RANGE_LIMIT} step={0.1} ariaLabel="Distance cutoff" onChange={() => undefined} />
                </div>
              ) : (
                <ScalarRow
                  label="Range"
                  title="Distance cutoff"
                  value={selected.range}
                  min={0}
                  max={CUSTOM_LIGHT_RANGE_LIMIT}
                  step={0.1}
                  onPreviewChange={(range) => previewSelected((light) => (
                    'range' in light ? { ...light, range } : light
                  ))}
                  onChange={(range) => updateSelected((light) => ('range' in light ? { ...light, range } : light))}
                  trailing={(
                    <Button
                      variant="toggle"
                      size="icon-sm"
                      className={RANGE_TOGGLE}
                      data-slot="lighting-range-toggle"
                      aria-pressed={false}
                      title="Remove the distance cutoff"
                      onClick={() => updateSelected((light) => ('range' in light ? { ...light, range: null } : light))}
                    >
                      &#8734;
                    </Button>
                  )}
                />
              )
            )}

            {'position' in selected && (
              <VectorRow
                label="Place"
                value={selected.position}
                min={-CUSTOM_LIGHT_POSITION_LIMIT}
                max={CUSTOM_LIGHT_POSITION_LIMIT}
                onChange={(position) => updateSelected((light) => ('position' in light ? { ...light, position } : light))}
              />
            )}

            {selected.type === 'spot' && (
              <VectorRow
                label="Aim"
                value={selected.target}
                min={-CUSTOM_LIGHT_POSITION_LIMIT}
                max={CUSTOM_LIGHT_POSITION_LIMIT}
                onChange={(target) => updateSelected((light) => (light.type === 'spot' ? { ...light, target } : light))}
              />
            )}

            {selected.type === 'directional' && (
              <VectorRow
                label="Aim"
                value={selected.direction}
                min={-CUSTOM_DIRECTION_LIMIT}
                max={CUSTOM_DIRECTION_LIMIT}
                onChange={(direction) => updateSelected((light) => (
                  light.type === 'directional' ? { ...light, direction } : light
                ))}
              />
            )}

            <div className="flex gap-1.25 pt-0.5">
              <Button
                size="sm"
                className={ACTION_BUTTON}
                disabled={full}
                title={full ? `Limit is ${MAX_CUSTOM_LIGHTS} lights` : undefined}
                onClick={duplicateSelected}
              >
                <Copy size={12} />
                <span>Duplicate</span>
              </Button>
              <Button
                variant="danger"
                size="sm"
                className={ACTION_BUTTON}
                data-slot="lighting-delete"
                onClick={deleteSelected}
              >
                <Trash2 size={12} />
                <span>Delete</span>
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
