// Tolerant reader for the JSON fragments modders publish: one protobuf message each,
// snake_case like decoder.ts's output, but pasted from a larger dump. So they may
// carry leading indentation, a trailing comma, and placeholder defindex tokens
// (###, &&&) in place of numbers. Output is plain objects for decoder.ts, which
// owns the cast into message types.
//
// Input is untrusted: fragments are size-capped and must be JSON objects.

import { printParseErrorCode, visit, type ParseErrorCode } from 'jsonc-parser';
import type { ProtoDefJsonFragment } from './types';
import { AppError, ERROR_CODES } from '../errors';

export type ProtoDefFragmentKind = 'operation' | 'definition' | 'itemDefinition';

export interface NormalizedProtoDefFragment {
  name: string;
  kind: ProtoDefFragmentKind;
  value: Record<string, unknown>;
}

// Generous next to real packs (the largest sample is about 250 KB). This bounds
// hostile input without rejecting anything a modder would paste.
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;

// Placeholder tokens get ids up here, far above any real defindex, so a synthetic id
// can never collide with a real one and stays recognisable in logs.
const SYNTHETIC_DEFINDEX_BASE = 900_000_000;

// Matches a numeric or placeholder defindex. The token stops at the next comma, brace,
// bracket or whitespace, where real files put one; placeholders are never quoted.
const DEFINDEX_FIELD = /"defindex"\s*:\s*([^,}\]\s]+)/g;

// Enum names map to numbers, as protobufjs does for decodeType(), so the JSON path
// produces the same shape. jsonExport.ts writes the names back out.
export const PROTO_DEF_TYPE_NUMBERS: Record<string, number> = {
  DEF_TYPE_QUEST_MAP_NODE: 0,
  DEF_TYPE_QUEST_THEME: 2,
  DEF_TYPE_QUEST_MAP_REGION: 3,
  DEF_TYPE_QUEST: 4,
  DEF_TYPE_QUEST_OBJECTIVE: 5,
  DEF_TYPE_PAINTKIT_VARIABLES: 6,
  DEF_TYPE_PAINTKIT_OPERATION: 7,
  DEF_TYPE_PAINTKIT_ITEM_DEFINITION: 8,
  DEF_TYPE_PAINTKIT_DEFINITION: 9,
  DEF_TYPE_HEADER_ONLY: 10,
  DEF_TYPE_QUEST_MAP_STORE_ITEM: 11,
  DEF_TYPE_QUEST_MAP_STAR_TYPE: 12,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Community files are pasted into a bigger dump: strip the leading
// indentation and the trailing comma that made that valid there, nothing else.
function trimFragment(text: string): string {
  return text.trim().replace(/,\s*$/, '');
}

function placeholderTokensIn(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(DEFINDEX_FIELD)) {
    if (!/^\d+$/.test(match[1])) tokens.push(match[1]);
  }
  return tokens;
}

// Every token must already be in ids (both callers fill it from the same scan), so a
// miss is an internal error, not bad input.
function substitutePlaceholders(text: string, ids: Map<string, number>): string {
  return text.replace(DEFINDEX_FIELD, (whole, token: string) => {
    if (/^\d+$/.test(token)) return whole;
    const id = ids.get(token);
    if (id === undefined) throw new Error(`Internal error: no id assigned for placeholder defindex token "${token}".`);
    return `"defindex": ${id}`;
  });
}

function coerceEnumStrings(value: unknown): unknown {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = coerceEnumStrings(value[i]);
    return value;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const raw = value[key];
      value[key] = (key === 'type' && typeof raw === 'string' && Object.hasOwn(PROTO_DEF_TYPE_NUMBERS, raw))
        ? PROTO_DEF_TYPE_NUMBERS[raw]
        : coerceEnumStrings(raw);
    }
  }
  return value;
}

function jsonError(text: string) {
  let firstError: { code: ParseErrorCode; offset: number; line: number; column: number } | undefined;
  visit(text, {
    onError(code, offset, _length, line, column) {
      firstError ??= { code, offset, line: line + 1, column: column + 1 };
    },
  }, { disallowComments: true, allowTrailingComma: false });
  return firstError;
}

function parseFragmentJson(name: string, jsonText: string): Record<string, unknown> {
  let value: unknown;
  try {
    // Keep native JSON semantics and speed; only diagnose rejected input with jsonc-parser.
    value = JSON.parse(jsonText);
  } catch (cause) {
    const error = jsonError(jsonText);
    const message = error ? printParseErrorCode(error.code) : String(cause);
    const context = `File: ${name}\nParser: ${message}`;
    const sourceLocation = error && { line: error.line, column: error.column };
    if (error && message === 'UnexpectedEndOfString') {
      throw new AppError(
        ERROR_CODES.definitionJsonUnterminatedString,
        'Missing closing quotation mark.',
        {
          technicalDetail: `${context}\nThe reported position may only be where parsing stopped; the actual mistake can be earlier in the file.`,
          path: name,
          location: sourceLocation,
          cause,
        },
      );
    }
    if (error && error.offset >= jsonText.length) {
      throw new AppError(
        ERROR_CODES.definitionJsonIncomplete,
        'Incomplete JSON.',
        { technicalDetail: context, path: name, location: sourceLocation, cause },
      );
    }
    throw new AppError(
      ERROR_CODES.definitionJsonSyntax,
      'This file contains invalid JSON. Check the reported area for a missing comma, quotation mark, bracket, or brace.',
      { technicalDetail: context, path: name, location: sourceLocation, cause },
    );
  }
  if (!isPlainObject(value)) {
    const got = value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
    throw new AppError(
      ERROR_CODES.definitionJsonNotObject,
      `This file must contain one JSON object, but it contains ${got}.`,
      { technicalDetail: `Expected one proto_defs JSON object in ${name}; received ${got}.`, path: name },
    );
  }
  return coerceEnumStrings(value) as Record<string, unknown>;
}

// An operation has a top-level operation_node; a definition has a weapon slot carrying
// item_definition_template; an item definition has item_definition_index and a
// definition array. Checked in that order, since the later shapes also have a header.
function classifyShape(value: Record<string, unknown>): ProtoDefFragmentKind | null {
  const opNode = value.operation_node;
  if (Array.isArray(opNode) ? opNode.length > 0 : isPlainObject(opNode)) return 'operation';
  const header = value.header;
  if (isPlainObject(header) && header.defindex !== undefined) {
    // The repeated `item` field holds its slots as an array; named weapon fields hold one.
    const isWeaponSlot = (v: unknown) => isPlainObject(v) && 'item_definition_template' in v;
    const hasWeaponSlot = Object.values(value).some((v) => (Array.isArray(v) ? v.some(isWeaponSlot) : isWeaponSlot(v)));
    if (hasWeaponSlot) return 'definition';
    if (value.item_definition_index !== undefined && Array.isArray(value.definition)) return 'itemDefinition';
  }
  return null;
}

function checkSize(name: string, text: string): void {
  if (text.length > MAX_FRAGMENT_BYTES) {
    throw new AppError(
      ERROR_CODES.definitionJsonTooLarge,
      'This definition file is too large to import. Definition JSON files must be 8 MB or smaller.',
      { technicalDetail: `${name} is ${text.length.toLocaleString()} bytes; the limit is ${MAX_FRAGMENT_BYTES.toLocaleString()} bytes.`, path: name },
    );
  }
}

/**
 * Classifies one fragment by shape alone, since packs name these files inconsistently.
 * Returns null for anything that fails to parse or matches neither shape, rather than
 * throwing, because callers scan whole archives mostly full of unrelated files.
 */
export function classifyProtoDefFragment(text: string): ProtoDefFragmentKind | null {
  if (text.length > MAX_FRAGMENT_BYTES) return null;
  try {
    const trimmed = trimFragment(text);
    const ids = new Map<string, number>();
    let next = SYNTHETIC_DEFINDEX_BASE;
    for (const token of placeholderTokensIn(trimmed)) {
      if (!ids.has(token)) ids.set(token, (next += 1));
    }
    const value = parseFragmentJson('fragment', substitutePlaceholders(trimmed, ids));
    return classifyShape(value);
  } catch {
    return null;
  }
}

/**
 * Normalizes and classifies one pack's fragments together, so a placeholder token gets
 * the same synthetic id in every file it appears in (an operation's header and the
 * definition that points at it). Matching is by exact token text, so two packs using
 * "###" are never linked.
 *
 * Throws on a fragment that is too large, fails to parse, or matches neither shape:
 * the caller has chosen these files for import, so a bad one should surface as an error.
 */
export function normalizeProtoDefFragments(fragments: ProtoDefJsonFragment[]): NormalizedProtoDefFragment[] {
  for (const fragment of fragments) checkSize(fragment.name, fragment.text);
  const trimmed = fragments.map((fragment) => ({ name: fragment.name, text: trimFragment(fragment.text) }));

  const ids = new Map<string, number>();
  let next = SYNTHETIC_DEFINDEX_BASE;
  for (const { text } of trimmed) {
    for (const token of placeholderTokensIn(text)) {
      if (!ids.has(token)) ids.set(token, (next += 1));
    }
  }

  return trimmed.map(({ name, text }) => {
    const value = parseFragmentJson(name, substitutePlaceholders(text, ids));
    const kind = classifyShape(value);
    if (!kind) {
      throw new AppError(
        ERROR_CODES.definitionUnknownFragment,
        'This file does not look like a war paint operation or definition file. Make sure both exported definition JSON files were selected.',
        { technicalDetail: `${name} has neither a top-level operation_node nor a weapon slot carrying item_definition_template.`, path: name },
      );
    }
    return { name, kind, value };
  });
}
