import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { AlertTriangle, Check, ImageOff, RotateCcw, Search, X } from 'lucide-react';
import './MaterialOverridesPanel.css';

export interface MaterialWeaponRow {
  readonly key: string;
  readonly name: string;
  readonly thumbnail?: string | null;
  readonly overridePath?: string | null;
  readonly enabled: boolean;
  /** The referenced VMT is not in the mounted archive. */
  readonly missing?: boolean;
  /** e.g. "renders oddly in game" */
  readonly warning?: string | null;
}

export interface MaterialOverridesPanelProps {
  readonly weapons: readonly MaterialWeaponRow[];
  readonly presets: readonly { readonly id: string; readonly label: string }[];
  readonly activePresetId: string;
  readonly disabled?: boolean;
  readonly onActivePresetChange: (id: string) => void;
  readonly onToggleWeapon: (key: string, enabled: boolean) => void;
  readonly onSetWeapons: (keys: readonly string[], enabled: boolean) => void;
  readonly onApplyPreset: () => void;
  readonly onClearAll: () => void;
}

/**
 * A visible list of per-weapon material overrides with a preset button,
 * rather than a single "metallic shine" checkbox: a weapon with a warning
 * ships unchecked and stays that way through "Apply preset", so excluding it
 * is a fact the list shows rather than something the export decides quietly.
 */
export function MaterialOverridesPanel({
  weapons,
  presets,
  activePresetId,
  disabled = false,
  onActivePresetChange,
  onToggleWeapon,
  onSetWeapons,
  onApplyPreset,
  onClearAll,
}: MaterialOverridesPanelProps) {
  const [query, setQuery] = useState('');
  const [dragPreview, setDragPreview] = useState<{ enabled: boolean; keys: ReadonlySet<string> } | null>(null);
  const dragRef = useRef<{ enabled: boolean; keys: Set<string> } | null>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const overriddenCount = weapons.filter((weapon) => weapon.enabled).length;
  const missingCount = weapons.filter((weapon) => weapon.enabled && weapon.missing).length;
  const presetTargetCount = weapons.filter((weapon) => !weapon.warning).length;
  const visibleWeapons = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return weapons;
    return weapons.filter((weapon) => (
      weapon.name.toLocaleLowerCase().includes(needle)
      || weapon.key.toLocaleLowerCase().includes(needle)
    ));
  }, [query, weapons]);
  const displayedEnabled = useCallback((weapon: MaterialWeaponRow) => (
    dragPreview?.keys.has(weapon.key) ? dragPreview.enabled : weapon.enabled
  ), [dragPreview]);
  const visibleEnabledCount = visibleWeapons.filter(displayedEnabled).length;
  const allVisibleEnabled = visibleWeapons.length > 0 && visibleEnabledCount === visibleWeapons.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = visibleEnabledCount > 0 && !allVisibleEnabled;
    }
  }, [allVisibleEnabled, visibleEnabledCount]);

  const finishDrag = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    setDragPreview(null);
    onSetWeapons([...drag.keys], drag.enabled);
  }, [onSetWeapons]);

  useEffect(() => {
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    window.addEventListener('blur', finishDrag);
    return () => {
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      window.removeEventListener('blur', finishDrag);
    };
  }, [finishDrag]);

  const beginDrag = (event: PointerEvent<HTMLDivElement>, weapon: MaterialWeaponRow) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const drag = { enabled: !weapon.enabled, keys: new Set([weapon.key]) };
    dragRef.current = drag;
    setDragPreview({ enabled: drag.enabled, keys: new Set(drag.keys) });
  };

  const extendDrag = (weapon: MaterialWeaponRow) => {
    const drag = dragRef.current;
    if (!drag || drag.keys.has(weapon.key)) return;
    drag.keys.add(weapon.key);
    setDragPreview({ enabled: drag.enabled, keys: new Set(drag.keys) });
  };

  return (
    <div className="material-overrides-panel">
      <div className="material-overrides-panel-head">
        <span className="material-overrides-panel-title">
          Material overrides
          <small>written per weapon entry</small>
        </span>
        <span className="material-overrides-panel-head-spacer" />
        <select
          className="material-overrides-panel-preset-select"
          aria-label="Material preset"
          value={activePresetId}
          disabled={disabled || presets.length === 0}
          onChange={(event) => onActivePresetChange(event.target.value)}
        >
          {presets.map((preset) => (
            <option key={preset.id} value={preset.id}>{preset.label}</option>
          ))}
        </select>
        <button
          type="button"
          className="material-overrides-panel-apply"
          disabled={disabled || presets.length === 0}
          onClick={onApplyPreset}
        >
          Apply to {presetTargetCount} {presetTargetCount === 1 ? 'weapon' : 'weapons'}
        </button>
      </div>

      <div className="material-overrides-panel-tools">
        <label className="material-overrides-panel-search">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={query}
            disabled={disabled}
            placeholder="Search weapons"
            aria-label="Search material override weapons"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" aria-label="Clear weapon search" onClick={() => setQuery('')}>
              <X size={12} aria-hidden="true" />
            </button>
          ) : null}
        </label>
        <span className="material-overrides-panel-visible-count">
          {visibleWeapons.length} {visibleWeapons.length === 1 ? 'weapon' : 'weapons'}
        </span>
      </div>

      <div
        className="material-overrides-panel-list"
        role="group"
        aria-label="Weapon material overrides"
        title="Drag across rows to select or deselect multiple weapons"
        data-dragging={dragPreview ? '' : undefined}
      >
        <label className="material-overrides-panel-select-all-row">
          <input
            ref={selectAllRef}
            type="checkbox"
            checked={allVisibleEnabled}
            disabled={disabled || visibleWeapons.length === 0}
            aria-label={query ? 'Select all matching weapons' : 'Select all weapons'}
            onChange={(event) => onSetWeapons(
              visibleWeapons.map((weapon) => weapon.key),
              event.target.checked,
            )}
          />
          <span className="material-overrides-panel-select-all-mark" aria-hidden="true">
            <Check size={12} />
          </span>
          <span className="material-overrides-panel-select-all-label">
            {query ? 'Select all matches' : 'Select all weapons'}
          </span>
          <span className="material-overrides-panel-select-all-count">
            {visibleEnabledCount} / {visibleWeapons.length}
          </span>
        </label>
        {visibleWeapons.map((weapon) => {
          const enabled = displayedEnabled(weapon);
          const pathText = enabled ? (weapon.overridePath ?? '(preset will be applied)') : 'no override';
          const pathEmpty = !enabled || !weapon.overridePath;
          let flag: ReactNode = null;
          if (enabled && weapon.missing !== undefined) {
            flag = weapon.missing
              ? (
                <span className="material-overrides-panel-flag" data-kind="warn">
                  <AlertTriangle size={11} aria-hidden="true" /> not in the mounted archive
                </span>
              )
              : (
                <span className="material-overrides-panel-flag" data-kind="ok">
                  <Check size={11} aria-hidden="true" /> found
                </span>
              );
          } else if (weapon.warning) {
            flag = (
              <span className="material-overrides-panel-flag" data-kind="warn">
                <AlertTriangle size={11} aria-hidden="true" /> {weapon.warning}
              </span>
            );
          }
          return (
            <div
              className="material-overrides-panel-row"
              key={weapon.key}
              data-drag-preview={dragPreview?.keys.has(weapon.key) ? '' : undefined}
              onPointerDown={(event) => beginDrag(event, weapon)}
              onPointerEnter={() => extendDrag(weapon)}
            >
              <input
                type="checkbox"
                aria-label={`Override ${weapon.name}`}
                checked={enabled}
                disabled={disabled}
                onChange={(event) => onToggleWeapon(weapon.key, event.target.checked)}
              />
              <span className="material-overrides-panel-thumb" aria-hidden="true">
                {weapon.thumbnail ? <img src={weapon.thumbnail} alt="" draggable={false} /> : <ImageOff size={13} aria-hidden="true" />}
              </span>
              <span className="material-overrides-panel-name">{weapon.name}</span>
              <span className="material-overrides-panel-path" data-empty={pathEmpty ? '' : undefined}>{pathText}</span>
              {flag}
            </div>
          );
        })}
        {visibleWeapons.length === 0 ? (
          <div className="material-overrides-panel-empty">No weapons match “{query.trim()}”.</div>
        ) : null}
      </div>

      <div className="material-overrides-panel-foot">
        <span>{overriddenCount} of {weapons.length} weapons overridden</span>
        {missingCount > 0 ? (
          <span className="material-overrides-panel-flag" data-kind="warn">
            <AlertTriangle size={11} aria-hidden="true" /> {missingCount} material{missingCount === 1 ? '' : 's'} missing from the export
          </span>
        ) : null}
        <span className="material-overrides-panel-foot-spacer" />
        <button
          type="button"
          className="material-overrides-panel-clear"
          disabled={disabled || overriddenCount === 0}
          onClick={onClearAll}
        >
          <RotateCcw size={12} aria-hidden="true" /> Clear all overrides
        </button>
      </div>
    </div>
  );
}
