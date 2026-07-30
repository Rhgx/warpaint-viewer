import { many, type Many, type VarDefMsg, type VarFieldMsg } from './messages';

export interface VarEntry {
  value: string;
  canOverride: boolean;
}

function toNums(str: string | undefined): number[] {
  if (str == null) return [];
  return String(str).trim().split(/\s+/).filter(Boolean).map(Number);
}

export function parseRange(str: string | undefined, dflt: [number, number] | null): [number, number] | null {
  const n = toNums(str);
  if (n.length === 0) return dflt ? [...dflt] : null;
  if (n.length === 1) return [n[0], n[0]];
  return [n[0], n[1]];
}

export function parseRangeDiv255(str: string | undefined, dflt: [number, number]): [number, number] {
  const range = parseRange(str, null);
  return range ? [range[0] / 255, range[1] / 255] : [...dflt];
}

export function parseInverseRange(str: string | undefined, dflt: [number, number]): [number, number] {
  const range = parseRange(str, null);
  if (!range) return [...dflt];
  const inverse = (value: number) => (value === 0 ? 0 : 1 / value);
  return [inverse(range[0]), inverse(range[1])];
}

export function parseVec2(str: string | undefined, dflt: [number, number]): [number, number] {
  const n = toNums(str);
  if (n.length >= 2) return [n[0], n[1]];
  if (n.length === 1) return [n[0], n[0]];
  return [...dflt];
}

export function parseBool(str: string | undefined): boolean {
  if (str == null) return false;
  const value = String(str).trim().toLowerCase();
  return value === '1' || value === 'true';
}

export function texturePublicPath(ref: string | undefined | null): string | null {
  if (!ref) return null;
  let path = String(ref).trim().replace(/\\/g, '/');
  path = path.replace(/^materials\//i, '').replace(/\.(vtf|tga|psd|png|webp)$/i, '');
  return `textures/${path}.webp`.toLowerCase();
}

export function varFieldValue(field: VarFieldMsg | undefined, dict: Map<string, VarEntry>): string | undefined {
  if (field == null) return undefined;
  if (field.variable) {
    const entry = dict.get(field.variable);
    if (entry !== undefined) return entry.value;
  }
  if (field.string !== undefined) return field.string;
  for (const key of ['float', 'double', 'uint32', 'uint64', 'sint32', 'sint64', 'bool'] as const) {
    if (field[key] !== undefined) return String(field[key]);
  }
  return undefined;
}

export function buildVarDict(baseHeaderVars: Many<VarDefMsg>): Map<string, VarEntry> {
  const dict = new Map<string, VarEntry>();
  for (const variable of many(baseHeaderVars)) {
    dict.set(variable.name, { value: variable.value ?? '', canOverride: variable.inherit !== false });
  }
  return dict;
}

export function applyVarFieldOverrides(dict: Map<string, VarEntry>, fields: Many<VarFieldMsg>): void {
  for (const field of many(fields)) {
    const entry = field.variable == null ? undefined : dict.get(field.variable);
    if (!entry || !entry.canOverride) continue;
    const value = varFieldValue({ ...field, variable: undefined }, dict);
    if (value !== undefined) entry.value = value;
  }
}

export function applyVarDefOverrides(dict: Map<string, VarEntry>, definitions: Many<VarDefMsg>): void {
  for (const definition of many(definitions)) {
    const entry = dict.get(definition.name);
    if (entry?.canOverride) entry.value = definition.value ?? '';
  }
}
