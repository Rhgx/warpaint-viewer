import { Autocomplete } from '@base-ui/react/autocomplete';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Image as ImageIcon, Link2, Link2Off, Search, Variable, X } from 'lucide-react';
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
import './OperationGraphFields.css';

const MAX_VISIBLE_OPTIONS = 80;

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
 * A searchable dropdown for the values the graph already knows about.
 *
 * The parameters people change most (texture paths, group masks, variable
 * bindings) all come from a closed, discoverable set, so typing the exact
 * string should never be the only way in. Free text stays available for
 * texture-shaped fields because community packs ship paths the viewer has
 * not indexed yet.
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
  // Entries the list is deliberately holding back until somebody searches,
  // as opposed to matches that simply ran past the visible cap.
  const deferredCount = query ? 0 : options.length - matches.length;

  useEffect(() => {
    if (open) return;
    setInputValue(value);
    setDirty(false);
  }, [open, value]);

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
      className="graph-combobox nodrag nowheel"
      data-open={open ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
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
        <Autocomplete.InputGroup className="graph-combobox-control" onClick={() => setOpen(true)}>
          {leadingIcon === 'texture' && <ImageIcon className="graph-combobox-leading" size={12} aria-hidden />}
          {leadingIcon === 'variable' && <Variable className="graph-combobox-leading" size={12} aria-hidden />}
          <Autocomplete.Input
            className="graph-combobox-input"
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
            className="graph-combobox-toggle"
            tabIndex={-1}
            aria-label={`${ariaLabel} options`}
          >
            <ChevronDown size={12} aria-hidden />
          </Autocomplete.Trigger>
        </Autocomplete.InputGroup>
        <Autocomplete.Portal>
          <Autocomplete.Positioner
            className="graph-combobox-positioner nowheel"
            sideOffset={4}
            align="start"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
          >
            <Autocomplete.Popup className="graph-combobox-popover">
              <Autocomplete.List className="graph-combobox-list" aria-label={ariaLabel}>
                <Autocomplete.Empty className="graph-combobox-message">
                  {allowCustom ? 'No match. Press Enter to use what you typed.' : 'No match.'}
                </Autocomplete.Empty>
                {shown.map((option, index) => {
                  const heading = option.group && option.group !== shown[index - 1]?.group ? option.group : undefined;
                  const { name, directory } = splitGraphOptionLabel(option.label);
                  return (
                    <div key={`${option.group ?? ''}/${option.value}`}>
                      {heading && <div className="graph-combobox-group">{heading}</div>}
                      <Autocomplete.Item
                        value={option}
                        index={index}
                        className="graph-combobox-option"
                        title={option.label}
                      >
                        {option.thumbnailUrl && (
                          <img
                            className="graph-combobox-thumb"
                            src={option.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            draggable={false}
                            onError={(event) => { event.currentTarget.hidden = true; }}
                          />
                        )}
                        <span className="graph-combobox-option-text">
                          <span className="graph-combobox-name">{name}</span>
                          {directory && <span className="graph-combobox-path">{directory}</span>}
                        </span>
                        {option.detail && <span className="graph-combobox-detail">{option.detail}</span>}
                        {option.value === value && <Check className="graph-combobox-check" size={12} aria-hidden />}
                      </Autocomplete.Item>
                    </div>
                  );
                })}
              </Autocomplete.List>
              <div className="graph-combobox-footer">
                <span className="graph-combobox-status">
                  {query ? <Search size={10} aria-hidden /> : null}
                  {status}
                </span>
                <span className="graph-combobox-keys" aria-hidden>
                  <kbd>↑</kbd><kbd>↓</kbd> move <kbd>↵</kbd> pick <kbd>esc</kbd> cancel
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
    <input
      type="number"
      className="graph-number"
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

/**
 * The compositor reads these fields as `min max` and picks a value per seed, so
 * the control makes that the primary decision instead of leaving people to
 * discover that a space in a text box means "randomize".
 */
function GraphRangeInput({ numbers, ariaLabel, step, disabled, canVary, onCommit }: GraphRangeInputProps): React.JSX.Element {
  const min = numbers[0] ?? 0;
  const max = numbers.length > 1 ? numbers[1] : min;
  const varies = numbers.length > 1 && min !== max;
  return (
    <div className="graph-range" data-varies={varies ? 'true' : undefined}>
      <NumberEntry
        value={min}
        step={step}
        disabled={disabled}
        ariaLabel={varies ? `${ariaLabel} minimum` : ariaLabel}
        onCommit={(next) => onCommit(varies ? [next, max] : [next])}
      />
      {varies && (
        <>
          <span className="graph-range-separator" aria-hidden>…</span>
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
        <button
          type="button"
          className="graph-range-mode"
          disabled={disabled}
          title={varies ? 'Use one fixed value for every seed' : 'Let this value vary between seeds'}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onCommit(varies ? [min] : [min, min + Math.max(step, Math.abs(min) * 0.1 || step)]);
          }}
        >
          {varies ? 'Varies' : 'Fixed'}
        </button>
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
    <div className="graph-range">
      <span className="graph-axis" aria-hidden>U</span>
      <NumberEntry value={u} step={step} disabled={disabled} ariaLabel={`${ariaLabel} U`} onCommit={(next) => onCommit([next, v])} />
      <span className="graph-axis" aria-hidden>V</span>
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
    <div className="graph-segmented" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        data-active={!on ? 'true' : undefined}
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onCommit(false); }}
      >
        Off
      </button>
      <button
        type="button"
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

export interface GraphValueFieldProps {
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

/**
 * One authored stage parameter, entered with a control that matches what the
 * compositor actually accepts, and bindable to a declared variable without
 * losing sight of the value the binding resolves to.
 */
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

  useEffect(() => setPendingBinding(false), [boundVariable]);

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

  // A binding whose declaration lives outside this editor can still be
  // re-pointed or detached, but its value has to be read where it is declared.
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
          <input
            type="text"
            className="graph-text-input"
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
    <div className="graph-value-field nodrag" data-primary={primary ? 'true' : undefined}>
      <div className="graph-value-head">
        <span className="graph-value-label">{label}</span>
        <button
          type="button"
          className="graph-value-bind"
          data-active={bindingMode ? 'true' : undefined}
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
            ? <Link2Off size={13} strokeWidth={2.25} aria-hidden />
            : pendingBinding
              ? <X size={13} strokeWidth={2.25} aria-hidden />
              : <Link2 size={13} strokeWidth={2.25} aria-hidden />}
        </button>
      </div>
      {bindingMode && (
        <div className="graph-value-binding">
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
        <div className="graph-value-control">
          {boundVariable && (
            <span
              className="graph-value-scope"
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
        <p className="graph-value-warning">“{boundVariable}” is not declared by this paint kit.</p>
      )}
    </div>
  );
}
