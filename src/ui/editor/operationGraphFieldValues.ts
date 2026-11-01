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
  /** Background catalogue, shown only once someone searches, so a big library never buries the open paint's files. */
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

/** Every kind writes one authored `VarFieldMsg`, so the kind only chooses the control. */
export type GraphFieldKind = 'texture' | 'range' | 'vector' | 'toggle' | 'text';

const GRAPH_NUMERIC_FIELD_KEYS = [
  'float',
  'double',
  'uint32',
  'uint64',
  'sint32',
  'sint64',
] as const;

/** A `"min max"` range needs a string or variable field; numeric protobuf slots would reject two numbers. */
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

/** Splits a path label into file name and folder; leading with the name makes long shared prefixes scannable. */
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
  const segment = splitGraphOptionLabel(label).name;
  if (segment.startsWith(query)) return 1;
  if (label.startsWith(query)) return 2;
  if (label.includes(query)) return 3;
  if (option.detail?.toLocaleLowerCase().includes(query)) return 4;
  return -1;
}

/**
 * Case-insensitive ranked filter. With no query only suggestions show; typing adds
 * the secondary catalogue, ranked underneath.
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
