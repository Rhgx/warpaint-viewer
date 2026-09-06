import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { LightingStore } from '../../editor/lightingStore';
import { Copy, Eye, EyeOff, Plus, Redo2, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import {
  CUSTOM_LIGHT_POSITION_LIMIT,
  CUSTOM_LIGHT_RANGE_LIMIT,
  MAX_CUSTOM_LIGHTS,
  createDefaultCustomLightingRig,
  type CustomLight,
  type CustomLightType,
} from '../../viewer/customLighting';
import { SelectField } from '../common/controls';
import { ColorRow, LightIcon, LightTypeBadge, ScalarRow, VectorRow } from './lightingFields';
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
import './Lighting.css';

const INTENSITY_MAX = 10;
const RESET_ARM_MS = 3000;

interface LightingPanelProps {
  store: LightingStore;
}

// Name edits stay local until commit so clearing the field does not snap back
// to the validator's fallback name on every keystroke.
function NameInput({ light, onCommit }: { light: CustomLight; onCommit: (name: string) => void }) {
  const [draft, setDraft] = useState(light.name);
  useEffect(() => setDraft(light.name), [light.name]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== light.name) onCommit(next);
    else setDraft(light.name);
  };

  return (
    <input
      className="lighting-name-input"
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

/**
 * The lighting workspace, docked over the stage under the toolbar so the
 * controls sit beside the render they change. It is only mounted while the
 * Custom lighting preset is selected, and while it is open the viewport shows
 * light helpers and the move gizmo; closing it puts the viewport back to a
 * clean render without needing a separate edit mode.
 */
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

  // A closed panel keeps no half-finished affordances waiting for the reopen.
  useEffect(() => {
    if (open) return;
    setAddOpen(false);
    setResetArmed(false);
  }, [open]);

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

  // Reset is destructive and persists straight to storage, so it arms on the
  // first click and only fires on a second one.
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
    <section className="lighting-panel" data-open={open || undefined} aria-label="Custom lights">
      <header className="lighting-panel-head">
        <h2 className="lighting-panel-title">Lights</h2>
        <span className="lighting-panel-count">{rig.lights.length}/{MAX_CUSTOM_LIGHTS}</span>
        <button
          type="button"
          className="lighting-head-button"
          title="Undo lighting change (Ctrl+Z)"
          aria-label="Undo lighting change"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <Undo2 size={13} />
        </button>
        <button
          type="button"
          className="lighting-head-button"
          title="Redo lighting change (Ctrl+Y)"
          aria-label="Redo lighting change"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <Redo2 size={13} />
        </button>
        <button
          type="button"
          className="lighting-head-button"
          data-armed={resetArmed || undefined}
          title={resetArmed ? 'Click again to reset the rig' : 'Reset to the default rig'}
          aria-label={resetArmed ? 'Confirm reset to the default rig' : 'Reset to the default rig'}
          onClick={resetRig}
        >
          <RotateCcw size={13} />
        </button>
        <button
          type="button"
          className="lighting-head-button"
          title="Close lights panel"
          aria-label="Close lights panel"
          onClick={() => setOpen(false)}
        >
          <X size={14} />
        </button>
      </header>

      <div className="lighting-panel-body">
        <ul className="lighting-list">
          {rig.lights.map((light) => (
            <li key={light.id} className="lighting-list-row" data-selected={light.id === selectedLightId || undefined}>
              <button
                type="button"
                className="lighting-list-select"
                aria-pressed={light.id === selectedLightId}
                data-off={!light.enabled || undefined}
                onClick={() => onSelectedLightIdChange(light.id)}
              >
                <span
                  className="lighting-dot"
                  style={{ backgroundColor: light.color }}
                  data-off={!light.enabled || undefined}
                  aria-hidden="true"
                />
                <span className="lighting-list-name">{light.name}</span>
                <LightTypeBadge type={light.type} />
              </button>
              <button
                type="button"
                className="lighting-icon-button"
                title={light.enabled ? 'Turn off' : 'Turn on'}
                aria-label={light.enabled ? `Turn off ${light.name}` : `Turn on ${light.name}`}
                onClick={() => updateLight(light.id, (current) => ({ ...current, enabled: !current.enabled }))}
              >
                {light.enabled ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
            </li>
          ))}
        </ul>

        {rig.lights.length === 0 && (
          <p className="lighting-empty">No lights. The model is lit by ambient only.</p>
        )}

        <div
          className="lighting-add"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !addOpen) return;
            setAddOpen(false);
            addButtonRef.current?.focus();
          }}
        >
          <button
            ref={addButtonRef}
            type="button"
            className="lighting-add-button"
            aria-expanded={addOpen}
            disabled={full}
            title={full ? `Limit is ${MAX_CUSTOM_LIGHTS} lights` : undefined}
            onClick={() => setAddOpen((current) => !current)}
          >
            <Plus size={13} />
            <span>Add light</span>
          </button>
          {addOpen && !full && (
            <div className="lighting-add-menu">
              <span className="lighting-add-group">Roles</span>
              <div className="lighting-add-grid">
                {ROLE_TEMPLATES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="lighting-add-option"
                    onClick={() => addLight(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <span className="lighting-add-group">Blank</span>
              <div className="lighting-add-grid">
                {TYPE_TEMPLATES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className="lighting-add-option"
                    onClick={() => addLight(option.value)}
                  >
                    <LightIcon type={option.type} size={11} />
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {selected && (
          <div className="lighting-props">
            <NameInput
              key={selected.id}
              light={selected}
              onCommit={(name) => updateSelected((light) => ({ ...light, name }))}
            />

            <div className="lighting-row">
              <span className="lighting-scalar-label">Type</span>
              <SelectField
                value={selected.type}
                options={TYPE_OPTIONS}
                onChange={(value) => updateSelected((light) => changeLightType(light, value as CustomLightType))}
              />
            </div>

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
                  min={1}
                  max={90}
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
                  max={1}
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
                <div className="lighting-scalar">
                  <span className="lighting-scalar-label" title="Distance cutoff">Range</span>
                  <span className="lighting-scalar-note">Reaches everything</span>
                  <button
                    type="button"
                    className="lighting-range-toggle"
                    aria-pressed
                    title="Give this light a distance cutoff"
                    onClick={() => updateSelected((light) => (
                      'range' in light ? { ...light, range: DEFAULT_FINITE_RANGE } : light
                    ))}
                  >
                    &#8734;
                  </button>
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
                    <button
                      type="button"
                      className="lighting-range-toggle"
                      aria-pressed={false}
                      title="Remove the distance cutoff"
                      onClick={() => updateSelected((light) => ('range' in light ? { ...light, range: null } : light))}
                    >
                      &#8734;
                    </button>
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
                min={-1}
                max={1}
                onChange={(direction) => updateSelected((light) => (
                  light.type === 'directional' ? { ...light, direction } : light
                ))}
              />
            )}

            <p className="lighting-hint">
              {selected.type === 'directional'
                ? 'Drag the aim dot to swing the sun. Drag the background to orbit the rig.'
                : 'Drag the arrows to move this light, the aim dot to point it. Drag the background to orbit the rig.'}
            </p>

            <div className="lighting-props-actions">
              <button
                type="button"
                className="lighting-action-button"
                disabled={full}
                title={full ? `Limit is ${MAX_CUSTOM_LIGHTS} lights` : undefined}
                onClick={duplicateSelected}
              >
                <Copy size={12} />
                <span>Duplicate</span>
              </button>
              <button
                type="button"
                className="lighting-action-button lighting-delete-button"
                onClick={deleteSelected}
              >
                <Trash2 size={12} />
                <span>Delete</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
