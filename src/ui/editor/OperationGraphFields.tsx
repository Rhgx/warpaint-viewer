import { Autocomplete } from '@base-ui/react/autocomplete';
import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Image as ImageIcon, Link2, Link2Off, Search, Variable, X } from 'lucide-react';

import {
  operationGraphVarFieldScalarKey,
  type OperationGraphParameterValue,
} from '../../editor/graph';
import type { VarFieldMsg } from '../../protodefs/messages';
import {
  filterGraphOptions,
  formatGraphNumber,
  parseNumberList,
  varFieldLiteralText,
  splitGraphOptionLabel,
  varFieldSupportsRange,
  type GraphComboboxOption,
  type GraphFieldKind,
  type GraphVariableOption,
} from './operationGraphFieldValues';
import { ControlLabel } from '../common/controls';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { Input } from '../primitives/Input';
import { Kbd } from '../primitives/Kbd';
import { EDITOR_NUMBER } from './editorStyles';

const MAX_VISIBLE_OPTIONS = 80;

// Node fields stay at their dense height: react-flow lays nodes out from their measured size.
const NODE_INPUT = 'h-6 min-h-0 min-w-0 px-1.25 py-0 [font-family:inherit] text-10.5 text-text tabular-nums disabled:cursor-default disabled:opacity-45 disabled:hover:border-border';
const RANGE = 'flex min-w-0 flex-1 items-center gap-1';
const AXIS = 'w-2 flex-none text-9 font-[650] text-dim';
const POPUP_DETAIL = 'text-dim group-data-highlighted:text-inherit';
const COMBOBOX_KEY = 'min-w-3.25 border-border bg-panel px-0.75 py-0 text-8.5';
const SEGMENT = 'h-5.5 min-w-8.5 cursor-pointer border-0 border-border bg-panel px-1.75 text-9.5 font-[650] text-dim transition-fast focus-ring not-last:border-r not-disabled:not-data-active:hover:bg-panel-2 not-disabled:not-data-active:hover:text-text focus-visible:-outline-offset-2 disabled:cursor-default disabled:opacity-45 data-active:bg-accent data-active:text-accent-text disabled:data-active:bg-panel-2 disabled:data-active:text-text';

interface GraphComboboxProps {
  readonly value: string;
  readonly options: readonly GraphComboboxOption[];
  readonly ariaLabel: string;
  readonly placeholder?: string;
  /** Allows values outside the option list, which texture paths need. */
  readonly allowCustom?: boolean;
  readonly disabled?: boolean;
  readonly leadingIcon?: 'texture' | 'variable';
  readonly onCommit: (value: string) => void;
}

/**
 * Searchable dropdown for values the graph already knows. Free text stays available
 * for texture fields, since community packs ship paths the viewer has not indexed.
 */
function GraphCombobox({
  value,
  options,
  ariaLabel,
  placeholder,
  allowCustom = false,
  disabled = false,
  leadingIcon,
  onCommit,
}: GraphComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [inputValue, setInputValue] = useState(value);
  const [dirty, setDirty] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const query = dirty ? inputValue : '';
  const matches = useMemo(() => filterGraphOptions(options, query), [options, query]);
  const shown = useMemo(() => matches.slice(0, MAX_VISIBLE_OPTIONS), [matches]);
  const hiddenCount = matches.length - shown.length;
  // Entries held back until a search, as opposed to matches cut off by the visible cap.
  const deferredCount = query ? 0 : options.length - matches.length;

  const [synced, setSynced] = useState({ open, value });
  if (synced.open !== open || synced.value !== value) {
    setSynced({ open, value });
    if (!open) {
      setInputValue(value);
      setDirty(false);
    }
  }

  const commit = (next: string): void => {
    setOpen(false);
    setInputValue(next);
    setDirty(false);
    if (next !== value) onCommit(next);
  };
  const status = deferredCount > 0
    ? `Search for ${deferredCount} more`
    : hiddenCount > 0
      ? `${shown.length} of ${matches.length}`
      : `${matches.length} option${matches.length === 1 ? '' : 's'}`;

  return (
    <div
      ref={rootRef}
      className="relative min-w-0 flex-1 nodrag nowheel"
    >
      <Autocomplete.Root<GraphComboboxOption>
        value={inputValue}
        open={open}
        items={options}
        filteredItems={shown}
        filter={null}
        disabled={disabled}
        autoHighlight="always"
        itemToStringValue={(option) => option.value}
        openOnInputClick
        onValueChange={(next, details) => {
          setInputValue(next);
          if (details.reason === 'input-change') setDirty(true);
          if (details.reason === 'item-press') commit(next);
        }}
        onOpenChange={(next, details) => {
          if (!next && details.reason === 'focus-out' && rootRef.current?.contains(document.activeElement)) {
            setOpen(true);
            return;
          }
          if (!next && details.reason === 'focus-out' && allowCustom && dirty) {
            commit(inputValue.trim());
            return;
          }
          setOpen(next);
          if (!next) {
            setInputValue(value);
            setDirty(false);
          }
        }}
      >
        <Autocomplete.InputGroup
          className={cn(
            'flex h-6 min-w-0 items-center gap-1 rounded-sm border border-border bg-panel pr-0.5 pl-1.25 transition-fast has-focus-visible:outline-2 has-focus-visible:outline-offset-0 has-focus-visible:outline-accent',
            disabled ? 'opacity-45' : 'hover:border-strong',
          )}
          onClick={() => setOpen(true)}
        >
          {leadingIcon === 'texture' && <ImageIcon className="flex-none text-dim" size={12} aria-hidden />}
          {leadingIcon === 'variable' && <Variable className="flex-none text-dim" size={12} aria-hidden />}
          <Autocomplete.Input
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 [font-family:inherit] text-10.5 text-ellipsis text-text outline-none placeholder:text-dim"
            placeholder={placeholder}
            spellCheck={false}
            aria-label={ariaLabel}
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              // The canvas owns Delete, F and Ctrl+D; typing here must never reach it.
              event.stopPropagation();
              if (event.key === 'Enter' && allowCustom && shown.length === 0) {
                event.preventDefault();
                commit(inputValue.trim());
              }
            }}
          />
          <Autocomplete.Trigger
            className="inline-flex h-5 w-4.5 flex-none cursor-pointer items-center justify-center rounded-sm border-0 bg-transparent p-0 text-dim not-disabled:hover:bg-panel-2 not-disabled:hover:text-text disabled:cursor-default"
            tabIndex={-1}
            aria-label={`${ariaLabel} options`}
          >
            <ChevronDown size={12} aria-hidden />
          </Autocomplete.Trigger>
        </Autocomplete.InputGroup>
        <Autocomplete.Portal>
          <Autocomplete.Positioner
            // The list takes the room it needs; matching the field width would squeeze the path and hints.
            className="z-1100 w-[max(var(--anchor-width),320px)] max-w-(--available-width) nowheel"
            sideOffset={4}
            align="start"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <Autocomplete.Popup className="flex w-full flex-col overflow-hidden rounded-md border border-strong bg-panel shadow-pop">
              <Autocomplete.List
                // The scroll padding keeps a scrolled-to row clear of the sticky group heading.
                className="scrollbar-slim max-h-[min(254px,var(--available-height,254px))] scroll-pt-5.5 overflow-y-auto overscroll-contain"
                aria-label={ariaLabel}
              >
                <Autocomplete.Empty className="px-2.25 py-2 text-10 leading-[1.4] text-dim empty:p-0">
                  {allowCustom ? 'No match. Press Enter to use what you typed.' : 'No match.'}
                </Autocomplete.Empty>
                {shown.map((option, index) => {
                  const heading = option.group && option.group !== shown[index - 1]?.group ? option.group : undefined;
                  const { name, directory } = splitGraphOptionLabel(option.label);
                  return (
                    <div key={`${option.group ?? ''}/${option.value}`}>
                      {/* Sticky headings keep the list's place visible while scrolling hundreds of paths. */}
                      {heading && <div className="sticky top-0 z-1 border-b border-border/60 bg-panel-2 px-2.25 pt-1.25 pb-0.75 text-9 font-semibold text-dim">{heading}</div>}
                      <Autocomplete.Item
                        value={option}
                        index={index}
                        className="group flex min-h-7.5 cursor-pointer items-center gap-1.75 px-2.25 py-0.75 text-text outline-none data-highlighted:bg-accent data-highlighted:text-accent-text"
                        title={option.label}
                      >
                        {option.thumbnailUrl && (
                          <img
                            className="size-5.5 flex-none rounded-xs border border-border bg-panel-2 object-cover"
                            src={option.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            draggable={false}
                            onError={(event) => { event.currentTarget.hidden = true; }}
                          />
                        )}
                        <span className="grid min-w-0 flex-1 gap-px">
                          <span className="truncate text-11">{name}</span>
                          {directory && <span className={cn('truncate text-left text-9 [direction:rtl]', POPUP_DETAIL)}>{directory}</span>}
                        </span>
                        {option.detail && <span className={cn('max-w-[40%] flex-none truncate text-9.5 tabular-nums', POPUP_DETAIL)}>{option.detail}</span>}
                        {option.value === value && <Check className="flex-none text-accent group-data-highlighted:text-inherit" size={12} aria-hidden />}
                      </Autocomplete.Item>
                    </div>
                  );
                })}
              </Autocomplete.List>
              <div className="flex min-h-5.5 flex-none items-center justify-between gap-2.5 border-t border-border bg-panel-2/55 px-2 py-0.75 text-9 whitespace-nowrap text-dim">
                {/* The count yields first when space is tight; the key hints are the part nobody can guess. */}
                <span className="inline-flex min-w-0 items-center gap-0.75 truncate">
                  {query ? <Search size={10} aria-hidden /> : null}
                  {status}
                </span>
                <span className="inline-flex flex-none items-center gap-0.75" aria-hidden>
                  <Kbd className={COMBOBOX_KEY}>↑</Kbd><Kbd className={COMBOBOX_KEY}>↓</Kbd> move <Kbd className={COMBOBOX_KEY}>↵</Kbd> pick <Kbd className={COMBOBOX_KEY}>esc</Kbd> cancel
                </span>
              </div>
            </Autocomplete.Popup>
          </Autocomplete.Positioner>
        </Autocomplete.Portal>
      </Autocomplete.Root>
    </div>
  );
}


interface NumberEntryProps {
  readonly value: number;
  readonly ariaLabel: string;
  readonly step: number;
  readonly disabled: boolean;
  readonly onCommit: (value: number) => void;
}

function NumberEntry({ value, ariaLabel, step, disabled, onCommit }: NumberEntryProps): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Input
      type="number"
      className={cn(NODE_INPUT, EDITOR_NUMBER, 'flex-1')}
      step={step}
      value={draft ?? formatGraphNumber(value)}
      disabled={disabled}
      aria-label={ariaLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        const next = draft === null ? value : Number(draft);
        setDraft(null);
        if (Number.isFinite(next) && next !== value) onCommit(next);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') { setDraft(null); event.currentTarget.blur(); }
      }}
    />
  );
}

interface GraphRangeInputProps {
  readonly numbers: readonly number[];
  readonly ariaLabel: string;
  readonly step: number;
  readonly disabled: boolean;
  /** Ranges are authored as `"min max"`, which only a string-backed field can hold. */
  readonly canVary: boolean;
  readonly onCommit: (numbers: readonly number[]) => void;
}

/** The compositor picks a value per seed from `min max`, so the range is the primary control. */
function GraphRangeInput({ numbers, ariaLabel, step, disabled, canVary, onCommit }: GraphRangeInputProps): React.JSX.Element {
  const min = numbers[0] ?? 0;
  const max = numbers.length > 1 ? numbers[1] : min;
  const varies = numbers.length > 1 && min !== max;
  return (
    <div className={RANGE}>
      <NumberEntry
        value={min}
        step={step}
        disabled={disabled}
        ariaLabel={varies ? `${ariaLabel} minimum` : ariaLabel}
        onCommit={(next) => onCommit(varies ? [next, max] : [next])}
      />
      {varies && (
        <>
          <span className="flex-none text-9 text-dim" aria-hidden>…</span>
          <NumberEntry
            value={max}
            step={step}
            disabled={disabled}
            ariaLabel={`${ariaLabel} maximum`}
            onCommit={(next) => onCommit([min, next])}
          />
        </>
      )}
      {canVary && (
        <Button
          variant={varies ? 'primary' : 'default'}
          size="sm"
          // One width, so that the field beside it stays put between Fixed and Varies.
          className={cn('min-h-6 w-10 min-w-0 flex-none px-0 text-9 font-[650]', varies && 'disabled:border-border disabled:bg-panel-2 disabled:text-text')}
          disabled={disabled}
          title={varies ? 'Use one fixed value for every seed' : 'Let this value vary between seeds'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onCommit(varies ? [min] : [min, min + Math.max(step, Math.abs(min) * 0.1 || step)]);
          }}
        >
          {varies ? 'Varies' : 'Fixed'}
        </Button>
      )}
    </div>
  );
}

interface GraphVectorInputProps {
  readonly numbers: readonly number[];
  readonly ariaLabel: string;
  readonly step: number;
  readonly disabled: boolean;
  readonly onCommit: (numbers: readonly number[]) => void;
}

function GraphVectorInput({ numbers, ariaLabel, step, disabled, onCommit }: GraphVectorInputProps): React.JSX.Element {
  const u = numbers[0] ?? 0;
  const v = numbers[1] ?? 0;
  return (
    <div className={RANGE}>
      <span className={AXIS} aria-hidden>U</span>
      <NumberEntry value={u} step={step} disabled={disabled} ariaLabel={`${ariaLabel} U`} onCommit={(next) => onCommit([next, v])} />
      <span className={AXIS} aria-hidden>V</span>
      <NumberEntry value={v} step={step} disabled={disabled} ariaLabel={`${ariaLabel} V`} onCommit={(next) => onCommit([u, next])} />
    </div>
  );
}

interface GraphToggleProps {
  readonly on: boolean;
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly onCommit: (on: boolean) => void;
}

function GraphToggle({ on, ariaLabel, disabled, onCommit }: GraphToggleProps): React.JSX.Element {
  return (
    <div className="inline-flex overflow-hidden rounded-sm border border-border" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className={SEGMENT}
        data-active={!on ? 'true' : undefined}
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onCommit(false); }}
      >
        Off
      </button>
      <button
        type="button"
        className={SEGMENT}
        data-active={on ? 'true' : undefined}
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onCommit(true); }}
      >
        On
      </button>
    </div>
  );
}

interface GraphValueFieldProps {
  readonly label: string;
  readonly kind: GraphFieldKind;
  readonly field?: VarFieldMsg;
  readonly variables: readonly GraphVariableOption[];
  readonly textureOptions?: readonly GraphComboboxOption[];
  readonly step?: number;
  readonly readOnly?: boolean;
  /** Marks the value people came to this node to change. */
  readonly primary?: boolean;
  readonly onChange: (value: OperationGraphParameterValue) => void;
}

/** One authored stage parameter: a control matching what the compositor accepts, bindable to a variable. */
export function GraphValueField({
  label,
  kind,
  field,
  variables,
  textureOptions,
  step = 0.01,
  readOnly = false,
  primary = false,
  onChange,
}: GraphValueFieldProps): React.JSX.Element {
  const boundVariable = field?.variable;
  const [pendingBinding, setPendingBinding] = useState(false);
  const bindingMode = Boolean(boundVariable) || pendingBinding;

  const [syncedBinding, setSyncedBinding] = useState(boundVariable);
  if (syncedBinding !== boundVariable) {
    setSyncedBinding(boundVariable);
    setPendingBinding(false);
  }

  const declaration = boundVariable
    ? variables.find((variable) => variable.name === boundVariable)
    : undefined;
  const effectiveText = boundVariable ? declaration?.value ?? '' : varFieldLiteralText(field);
  const scalarKey = operationGraphVarFieldScalarKey(field);
  const canVary = varFieldSupportsRange(field);
  const numbers = parseNumberList(effectiveText) ?? [0];

  const emitLiteral = (value: string | number | boolean): void => {
    onChange({ mode: 'literal', value, preserveVariable: Boolean(boundVariable) });
  };
  const emitNumbers = (next: readonly number[]): void => {
    if (next.length > 1) emitLiteral(next.map(formatGraphNumber).join(' '));
    else if (!boundVariable && scalarKey && scalarKey !== 'string' && scalarKey !== 'bool') emitLiteral(next[0] ?? 0);
    else emitLiteral(formatGraphNumber(next[0] ?? 0));
  };

  const variableOptions = useMemo((): GraphComboboxOption[] => variables.map((variable) => ({
    value: variable.name,
    label: variable.name,
    ...(variable.value ? { detail: variable.value } : {}),
    ...(variable.scope ? { group: variable.scope } : {}),
  })), [variables]);

  // A binding declared outside this editor can be re-pointed, but its value is read where it is declared.
  const declarationLocked = Boolean(boundVariable) && declaration?.editable === false;
  const controlsDisabled = readOnly || declarationLocked;
  const bindingActionLabel = boundVariable
    ? `Unlink from ${boundVariable} and keep ${effectiveText} on this node`
    : pendingBinding
      ? 'Cancel linking this value'
      : variables.length === 0
        ? 'No variables available to link'
        : 'Link this value to a variable';

  const valueControl = ((): React.JSX.Element => {
    const ariaLabel = boundVariable ? `${label} value of ${boundVariable}` : label;
    switch (kind) {
      case 'texture':
        return (
          <GraphCombobox
            value={effectiveText}
            options={textureOptions ?? []}
            ariaLabel={ariaLabel}
            placeholder="Choose a texture"
            leadingIcon="texture"
            allowCustom
            disabled={controlsDisabled}
            onCommit={(next) => emitLiteral(next)}
          />
        );
      case 'range':
        return (
          <GraphRangeInput
            numbers={numbers}
            ariaLabel={ariaLabel}
            step={step}
            disabled={controlsDisabled}
            canVary={canVary}
            onCommit={emitNumbers}
          />
        );
      case 'vector':
        return <GraphVectorInput numbers={numbers} ariaLabel={ariaLabel} step={step} disabled={controlsDisabled} onCommit={emitNumbers} />;
      case 'toggle':
        return (
          <GraphToggle
            on={effectiveText === '1' || effectiveText.toLocaleLowerCase() === 'true'}
            ariaLabel={ariaLabel}
            disabled={controlsDisabled}
            onCommit={(on) => emitLiteral(scalarKey === 'bool' && !boundVariable ? on : on ? '1' : '0')}
          />
        );
      default:
        return (
          <Input
            type="text"
            className={cn(NODE_INPUT, 'flex-1')}
            value={effectiveText}
            disabled={controlsDisabled}
            aria-label={ariaLabel}
            onPointerDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
            onChange={(event) => emitLiteral(event.target.value)}
          />
        );
    }
  })();

  return (
    <div className="grid gap-0.75 border-t border-border/70 px-2 py-1.5 nodrag first:border-t-0 data-primary:bg-accent/5" data-primary={primary ? 'true' : undefined}>
      <div className="flex min-h-4 items-center gap-1.5">
        <ControlLabel className="block min-w-0 flex-1 truncate">{label}</ControlLabel>
        <Button
          variant="toggle"
          size="icon-sm"
          // The transparent ring gives the small button a larger target without growing the row.
          className="relative size-5.5 not-aria-pressed:text-dim before:absolute before:-inset-1.25"
          disabled={readOnly || (!bindingMode && variables.length === 0)}
          title={bindingActionLabel}
          aria-label={bindingActionLabel}
          aria-pressed={bindingMode}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            if (!bindingMode) { setPendingBinding(true); return; }
            if (boundVariable) onChange({ mode: 'literal', value: effectiveText, preserveVariable: false });
            setPendingBinding(false);
          }}
        >
          {boundVariable
            ? <Link2 size={13} strokeWidth={2.25} aria-hidden />
            : pendingBinding
              ? <X size={13} strokeWidth={2.25} aria-hidden />
              : <Link2Off size={13} strokeWidth={2.25} aria-hidden />}
        </Button>
      </div>
      {bindingMode && (
        <div>
          <GraphCombobox
            value={boundVariable ?? ''}
            options={variableOptions}
            ariaLabel={`${label} variable`}
            placeholder="Choose a variable"
            leadingIcon="variable"
            disabled={readOnly}
            onCommit={(name) => { if (name) onChange({ mode: 'variable', name }); }}
          />
        </div>
      )}
      {(!bindingMode || boundVariable) && (
        <div className="flex min-w-0 items-center gap-1.25">
          {boundVariable && (
            <span
              className="flex-none rounded-sm border border-border bg-panel-2 px-1 py-px text-8.5 font-[650] tracking-[.03em] text-dim uppercase"
              data-locked={declarationLocked ? 'true' : undefined}
              title={declarationLocked
                ? `${boundVariable} is declared by ${declaration?.scope ?? 'another definition'} and is read-only here`
                : `Changing this edits ${boundVariable} everywhere it is used`}
            >
              {declarationLocked ? declaration?.scope ?? 'Declared' : 'Variable'}
            </span>
          )}
          {valueControl}
        </div>
      )}
      {boundVariable && declaration === undefined && variables.length > 0 && (
        <p className="m-0 flex items-start gap-1 text-9 leading-[1.35] text-warn">
          <AlertTriangle className="mt-px flex-none" size={10} aria-hidden />
          “{boundVariable}” is not declared by this paint kit.
        </p>
      )}
    </div>
  );
}
