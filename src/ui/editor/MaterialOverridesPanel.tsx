import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Check, ImageOff, RotateCcw } from 'lucide-react';

import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { COMPACT_INPUTS, SearchField } from '../primitives/Input';
import { InlineNotice } from '../primitives/Notice';
import { PATH_TEXT } from '../primitives/textStyles';
import { Select, SelectItem, SelectItemText, SelectPopup, SelectTrigger, SelectValue } from '../primitives/Select';
import { EDITOR_BUTTON, EDITOR_CHECKBOX, EDITOR_HEAD, EDITOR_TITLE } from './editorStyles';

const FLAG_OK = 'inline-flex items-center gap-1 rounded-sm bg-pass/12 px-1.75 py-px text-10 font-semibold whitespace-nowrap text-pass forced-colors:border forced-colors:border-[CanvasText]';


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

/** Per-weapon overrides as a list, so a weapon with a warning stays visibly unchecked through Apply preset. */
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
    <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden', COMPACT_INPUTS)} data-slot="material-overrides">
      <div className={EDITOR_HEAD}>
        <span className={EDITOR_TITLE}>
          Material Overrides
        </span>
        <span className="flex-1" />
        <Select
          value={activePresetId}
          disabled={disabled || presets.length === 0}
          onValueChange={(next) => {
            if (next !== null) onActivePresetChange(next);
          }}
        >
          <SelectTrigger className="w-auto min-w-0 py-0" aria-label="Material preset">
            <SelectValue>{() => presets.find((preset) => preset.id === activePresetId)?.label ?? ''}</SelectValue>
          </SelectTrigger>
          <SelectPopup className="text-11">
            {presets.map((preset) => (
              <SelectItem key={preset.id} value={preset.id}><SelectItemText>{preset.label}</SelectItemText></SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Button
          variant="primary"
          size="compact"
          className="whitespace-nowrap"
          disabled={disabled || presets.length === 0}
          onClick={onApplyPreset}
        >
          Apply to {presetTargetCount} {presetTargetCount === 1 ? 'Weapon' : 'Weapons'}
        </Button>
      </div>

      <div className="flex min-h-9 flex-none items-center gap-2 border-b border-border px-3 py-1.25">
        <SearchField
          className="w-[min(260px,45%)] min-w-37.5 max-[900px]:w-[min(220px,60%)]"
          value={query}
          onChange={setQuery}
          placeholder="Filter weapons..."
          label="Filter material override weapons"
          disabled={disabled}
          // SearchField clears on Escape. Marked handled, so that the same key does not also close the drawer.
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) event.preventDefault();
          }}
        />
        <span className="text-11 whitespace-nowrap text-dim">
          {visibleWeapons.length} {visibleWeapons.length === 1 ? 'weapon' : 'weapons'}
        </span>
      </div>

      <div
        className="scrollbar-slim flex-1 overflow-auto"
        role="group"
        aria-label="Weapon material overrides"
        title="Drag across rows to select or deselect multiple weapons"
        data-dragging={dragPreview ? '' : undefined}
      >
        <label className="sticky top-0 z-2 grid min-h-9 cursor-pointer grid-cols-[18px_28px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border bg-panel-2 px-3 py-1 select-none has-disabled:cursor-default has-disabled:opacity-45">
          <input
            ref={selectAllRef}
            type="checkbox"
            className={EDITOR_CHECKBOX}
            checked={allVisibleEnabled}
            disabled={disabled || visibleWeapons.length === 0}
            aria-label={query ? 'Select All Matching Weapons' : 'Select All Weapons'}
            onChange={(event) => onSetWeapons(
              visibleWeapons.map((weapon) => weapon.key),
              event.target.checked,
            )}
          />
          <span aria-hidden="true" />
          <span className="text-11.5 font-[650] text-text">
            {query ? 'Select All Matches' : 'Select All Weapons'}
          </span>
          <span className="text-11 text-dim tabular-nums">
            {visibleEnabledCount} of {visibleWeapons.length}
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
                <InlineNotice className="whitespace-nowrap">not in the mounted archive</InlineNotice>
              )
              : (
                <span className={FLAG_OK}>
                  <Check size={11} aria-hidden="true" /> found
                </span>
              );
          } else if (weapon.warning) {
            flag = (
              <InlineNotice className="whitespace-nowrap">{weapon.warning}</InlineNotice>
            );
          }
          return (
            <div
              className="grid min-h-9.5 cursor-pointer grid-cols-[18px_28px_minmax(120px,190px)_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-border/60 px-3 py-1 select-none hover:bg-panel-2 data-drag-preview:bg-[color-mix(in_srgb,var(--accent)_10%,var(--panel-2))] max-[900px]:grid-cols-[18px_28px_minmax(0,1fr)_auto]"
              key={weapon.key}
              data-drag-preview={dragPreview?.keys.has(weapon.key) ? '' : undefined}
              onPointerDown={(event) => beginDrag(event, weapon)}
              onPointerEnter={() => extendDrag(weapon)}
            >
              <input
                type="checkbox"
                className={cn(EDITOR_CHECKBOX, 'pointer-events-none')}
                aria-label={`Override ${weapon.name}`}
                checked={enabled}
                disabled={disabled}
                onChange={(event) => onToggleWeapon(weapon.key, event.target.checked)}
              />
              <span className="grid size-7 place-items-center overflow-hidden rounded-sm border border-border bg-panel-2 text-dim" aria-hidden="true">
                {weapon.thumbnail ? <img className="size-full object-cover" src={weapon.thumbnail} alt="" draggable={false} /> : <ImageOff size={13} aria-hidden="true" />}
              </span>
              <span className="truncate text-11.5 text-text">{weapon.name}</span>
              <span className={cn('truncate text-dim max-[900px]:hidden', pathEmpty ? 'text-11 italic' : PATH_TEXT)}>{pathText}</span>
              {flag}
            </div>
          );
        })}
        {visibleWeapons.length === 0 ? (
          <div className="grid min-h-22 place-items-center p-4 text-11 text-dim">No weapons match “{query.trim()}”.</div>
        ) : null}
      </div>

      <div className="flex flex-none flex-wrap items-center gap-2.5 border-t border-border px-3 py-2.25 text-11 text-dim">
        <span>{overriddenCount} of {weapons.length} weapons overridden</span>
        {missingCount > 0 ? (
          <InlineNotice>{missingCount} material{missingCount === 1 ? '' : 's'} missing from the export</InlineNotice>
        ) : null}
        <span className="flex-1" />
        <Button
          variant="danger"
          size="compact"
          className={EDITOR_BUTTON}
          disabled={disabled || overriddenCount === 0}
          onClick={onClearAll}
        >
          <RotateCcw size={12} aria-hidden="true" /> Clear All Overrides
        </Button>
      </div>
    </div>
  );
}
