import type { VarFieldMsg } from '../../protodefs/messages';
import { operationGraphVarFieldScalarKey } from '../../editor/graph';

/** One entry in a graph combobox list. */
export interface GraphComboboxOption {
  readonly value: string;
  readonly label: string;
  /** Secondary text shown to the right of the label. */
  readonly detail?: string;
  /** Optional square preview. Hidden automatically when it fails to load. */
  readonly thumbnailUrl?: string;
  /** Options render in the order given, with a heading whenever this changes. */
  readonly group?: string;
  /**
   * Background catalogue rather than a suggestion. These are withheld until
   * somebody searches, and rank below everything else when they do, so a
   * shipped library of a thousand entries never buries the handful of files
   * the open paint actually uses.
   */
  readonly secondary?: boolean;
}

/** A declared variable offered as a binding target. */
export interface GraphVariableOption {
  readonly name: string;
  readonly value?: string;
  /** Where the declaration lives, shown so two scopes stay tellable apart. */
  readonly scope?: string;
  /** False when this editor cannot write the declaration in place. */
  readonly editable?: boolean;
}

/**
 * How a stage parameter should be entered. Every kind here still writes one
 * authored `VarFieldMsg`, so the choice is purely about the control.
 */
export type GraphFieldKind = 'texture' | 'range' | 'vector' | 'toggle' | 'text';

const GRAPH_NUMERIC_FIELD_KEYS = [
  'float',
  'double',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
] as const;

/**
 * Which scalar slot a field already occupies. Authoring must keep writing that
 * slot, because a numeric slot cannot hold the `"min max"` text the compositor
 * reads as a per-seed range.
 */
/**
 * Whether this field can hold a `"min max"` range. A field already occupying a
 * numeric protobuf slot cannot: writing two numbers there would be rejected by
 * the editing layer, so the control offers a fixed value only. A variable
 * declaration is always text, so binding re-opens the choice.
 */
export function varFieldSupportsRange(field: VarFieldMsg | undefined): boolean {
  if (field?.variable !== undefined) return true;
  const key = operationGraphVarFieldScalarKey(field);
  return key === undefined || key === 'string';
}

/** The literal a field carries, as text, ignoring any variable binding. */
export function varFieldLiteralText(field: VarFieldMsg | undefined): string {
  if (!field) return '';
  if (field.string !== undefined) return field.string;
  if (field.bool !== undefined) return field.bool ? '1' : '0';
  const numeric = GRAPH_NUMERIC_FIELD_KEYS.find((key) => field[key] !== undefined);
  return numeric ? String(field[numeric]) : '';
}

/** Splits an authored `"min max"` range, or a single number, into numbers. */
export function parseNumberList(text: string): number[] | null {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > 2) return null;
  const numbers = parts.map(Number);
  return numbers.every(Number.isFinite) ? numbers : null;
}

/**
 * Splits a path-shaped label into the part that identifies it and the folder
 * it sits in. Texture refs share long prefixes, so leading with the filename
 * is the difference between scanning a list and reading every row.
 */
export function splitGraphOptionLabel(label: string): { readonly name: string; readonly directory?: string } {
  const index = label.lastIndexOf('/');
  if (index < 0) return { name: label };
  return { name: label.slice(index + 1), directory: label.slice(0, index) };
}

/** Matches the precision the graph editing layer writes back. */
export function formatGraphNumber(value: number): string {
  return String(Math.round(value * 1e6) / 1e6);
}

function optionRank(option: GraphComboboxOption, query: string): number {
  const label = option.label.toLocaleLowerCase();
  if (label === query) return 0;
  const segment = label.slice(label.lastIndexOf('/') + 1);
  if (segment.startsWith(query)) return 1;
  if (label.startsWith(query)) return 2;
  if (label.includes(query)) return 3;
  if (option.detail?.toLocaleLowerCase().includes(query)) return 4;
  return -1;
}

/**
 * Case-insensitive ranked filter.
 *
 * With no query this offers only the suggestions: the refs the open paint
 * already uses and whatever the imported package ships, in authored order.
 * Typing opens the secondary catalogue too, still ranked underneath. A list
 * with nothing but secondary entries shows them rather than nothing.
 */
export function filterGraphOptions(
  options: readonly GraphComboboxOption[],
  query: string,
): readonly GraphComboboxOption[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) {
    const suggested = options.filter((option) => !option.secondary);
    return suggested.length > 0 ? suggested : options;
  }
  return options
    .map((option, index) => ({ option, index, rank: optionRank(option, normalized) }))
    .filter((entry) => entry.rank >= 0)
    .sort((left, right) => (
      Number(left.option.secondary ?? false) - Number(right.option.secondary ?? false)
      || left.rank - right.rank
      || left.index - right.index
    ))
    .map((entry) => entry.option);
}
