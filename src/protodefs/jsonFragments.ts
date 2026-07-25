// Tolerant reader for the JSON fragments war paint modders actually publish.
// They are not proto_defs containers: they are one protobuf message each,
// serialized to JSON with the same snake_case shape decodeType() produces
// (src/protodefs/decoder.ts), but authored to be pasted into a bigger
// decompiled dump rather than parsed standalone. In practice that means:
//   - leading indentation from wherever the snippet was cut out of
//   - a trailing comma, because the next thing in the dump followed it
//   - a placeholder token (###, &&&, ...) in place of "defindex": <number>
//     wherever the mod's own tool hasn't assigned a real one yet
// This module turns one or many such fragments into plain objects shaped
// exactly like decodeType()'s output, so decoder.ts can build a
// DecodedContainer from them without caring where they came from. It is pure
// text/JSON handling with no protobuf schema knowledge, which is also why the
// interfaces it produces are typed as Record<string, unknown>: decoder.ts owns
// the cast into its message shapes, same as it already trusts decodeType()'s.
//
// This parses files a user drags in, so untrusted input rules apply: fragments
// are size-capped, and anything that isn't a JSON object after normalization
// is rejected with a specific error rather than passed through.

import type { ProtoDefJsonFragment } from './types';

export type ProtoDefFragmentKind = 'operation' | 'definition';

export interface NormalizedProtoDefFragment {
  name: string;
  kind: ProtoDefFragmentKind;
  value: Record<string, unknown>;
}

// Generous relative to the real files this is modeled on (the largest of the
// six sample community packs is ~250 KB): this bounds runaway/hostile input
// without rejecting anything a modder would plausibly paste.
const MAX_FRAGMENT_BYTES = 8 * 1024 * 1024;

// Placeholder defindex tokens are assigned ids up here: far above any real
// defindex (stock ids top out in the low thousands, and mod authors who pick
// their own numbers also use small ones, e.g. 9991), so a synthetic id can
// never collide with a real one, and stays recognizable as synthetic if it
// ever surfaces in a log or error message.
const SYNTHETIC_DEFINDEX_BASE = 900_000_000;

// Matches "defindex": 123 and the placeholder form "defindex": ###. The token
// capture stops at the next comma, brace, bracket or whitespace, which is
// exactly where the real files put one (placeholders are never quoted).
const DEFINDEX_FIELD = /"defindex"\s*:\s*([^,}\]\s]+)/g;

// CMsgProtoDefID.type (ProtoDefTypes in schema.generated.json) is an enum on
// the wire; decodeType() always resolves it to a number via protobufjs
// (TO_OBJECT_OPTIONS uses enums: Number), so the JSON path has to do the same
// translation to produce an equivalent shape, even though nothing in
// decoder.ts currently branches on the value.
const PROTO_DEF_TYPE_NUMBERS: Record<string, number> = {
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

// Every non-numeric defindex token found by placeholderTokensIn() must already
// be in `ids` before this runs (both call sites populate it from the same
// scan), so a lookup miss here means that invariant broke, not bad input.
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
      value[key] = (key === 'type' && typeof raw === 'string' && raw in PROTO_DEF_TYPE_NUMBERS)
        ? PROTO_DEF_TYPE_NUMBERS[raw]
        : coerceEnumStrings(raw);
    }
  }
  return value;
}

function parseFragmentJson(name: string, jsonText: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`"${name}" is not valid JSON once its placeholder defindex tokens are filled in: ${message}`);
  }
  if (!isPlainObject(value)) {
    const got = value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
    throw new Error(`"${name}" must decode to a single JSON object (a proto_defs fragment), got ${got}.`);
  }
  return coerceEnumStrings(value) as Record<string, unknown>;
}

// An OPERATION fragment has a top-level operation_node; a DEFINITION fragment
// has a header plus at least one field that is itself an object carrying
// item_definition_template (a weapon slot). Checked in that order because an
// operation fragment also has a header, but never a weapon slot.
function classifyShape(value: Record<string, unknown>): ProtoDefFragmentKind | null {
  const opNode = value.operation_node;
  if (Array.isArray(opNode) ? opNode.length > 0 : isPlainObject(opNode)) return 'operation';
  const header = value.header;
  if (isPlainObject(header) && header.defindex !== undefined) {
    const hasWeaponSlot = Object.values(value).some((v) => isPlainObject(v) && 'item_definition_template' in v);
    if (hasWeaponSlot) return 'definition';
  }
  return null;
}

function checkSize(name: string, text: string): void {
  if (text.length > MAX_FRAGMENT_BYTES) {
    throw new Error(`"${name}" is ${text.length.toLocaleString()} bytes, over the ${(MAX_FRAGMENT_BYTES / (1024 * 1024)).toFixed(0)} MB limit for a proto_defs JSON fragment.`);
  }
}

/**
 * Classifies one JSON fragment by shape alone, without linking it to anything
 * else. Real packs name these files inconsistently (operation.json,
 * operation_template.json, <PackName>_Operation.json, ...), so this is how the
 * importer tells an operation file from a definition file inside a ZIP.
 * Returns null for anything that fails to parse or matches neither shape,
 * rather than throwing: callers are expected to be scanning a whole archive
 * looking for the files that matter, most of which are not proto_defs at all.
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
 * Normalizes and classifies a batch of fragments together, so a placeholder
 * token (###, &&&, ...) appearing in more than one file - an operation's own
 * header.defindex and the definition that points at it through
 * operation_template.defindex - is assigned the SAME synthetic id everywhere
 * it appears. Matching is by the token's exact text, never by position or
 * file order: two different packs each using "###" for their own placeholder
 * must not be linked to each other, which is why this takes one pack's files
 * at a time rather than every fragment ever seen.
 *
 * Throws (rather than skipping) on a fragment that is too large, fails to
 * parse, or matches neither shape: unlike classifyProtoDefFragment, a caller
 * of this function has already decided these specific files are the ones to
 * import, so a bad one should surface as an import error, not silently
 * vanish from the result.
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
      throw new Error(`"${name}" is neither an operation fragment (no top-level operation_node) nor a definition fragment (no weapon slot carrying item_definition_template).`);
    }
    return { name, kind, value };
  });
}
