/**
 * Writes a proto_defs container with one extra war paint spliced into it, so a
 * paint the viewer only knows about in memory can exist in someone's game.
 *
 * The container is the flat block format src/protodefs/container.ts reads:
 * repeated { int32 defType; int32 numDefs; numDefs * (int32 size; byte[size]) }
 * until EOF. This module is its inverse, plus the defindex bookkeeping a splice
 * needs.
 *
 * Two rules keep this honest:
 *
 *  1. Blocks that are not being changed are copied byte for byte, never decoded
 *     and re-encoded. A container holds 250 paint definitions and 800-odd
 *     operations of Valve's data; round-tripping all of that through protobufjs
 *     would risk changing bytes for no reason (field ordering, defaults, unknown
 *     fields). Only the one or two messages being added are ever serialized.
 *  2. The output must reproduce its input exactly when nothing is spliced. The
 *     verification harness asserts that against the real 9.8 MB file, so the
 *     writer cannot drift from the parser.
 *
 * A container in tf/custom/ SHADOWS the game's own copy rather than merging with
 * it, so the base has to be a complete file: either the snapshot the site ships
 * (public/data/protodefs-full.bin) or the player's own.
 */

import { Root } from 'protobufjs/light';
import type { INamespace, Type } from 'protobufjs/light';
import schemaJson from '../protodefs/schema.generated.json';

/** Container defType values, mirroring src/protodefs/decoder.ts DEF_TYPE. */
/** @public Used by tools/verify/protodefs-write.mjs through its generated SSR entry. */
export const DEF_TYPE_PAINTKIT_OPERATION = 7;
/** @public Used by tools/verify/protodefs-write.mjs through its generated SSR entry. */
export const DEF_TYPE_PAINTKIT_DEFINITION = 9;

const MSG_FOR_DEFTYPE: Record<number, string> = {
  6: 'CMsgPaintKit_Variables',
  7: 'CMsgPaintKit_Operation',
  8: 'CMsgPaintKit_ItemDefinition',
  9: 'CMsgPaintKit_Definition',
};

/**
 * One block as it appears in the file. Kept as an ordered list rather than a
 * map by defType (which is all the reader needs) because rewriting a container
 * has to put the blocks back in the order they were found, or the output would
 * differ from the input for no reason.
 */
export interface ProtoDefGroup {
  defType: number;
  payloads: Uint8Array[];
}

const MAX_NUM_DEFS_PER_BLOCK = 1_000_000;

/** Order-preserving parse, for rewriting rather than reading. */
export function parseProtoDefGroups(bytes: Uint8Array): ProtoDefGroup[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const groups: ProtoDefGroup[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const defType = view.getInt32(offset, true);
    const numDefs = view.getInt32(offset + 4, true);
    offset += 8;
    if (numDefs < 0 || numDefs > MAX_NUM_DEFS_PER_BLOCK) {
      throw new Error(`Suspicious numDefs=${numDefs} at offset ${offset - 4} (defType=${defType}).`);
    }
    const payloads: Uint8Array[] = [];
    for (let index = 0; index < numDefs; index += 1) {
      if (offset + 4 > bytes.length) {
        throw new Error(`Truncated container: expected a size field at offset ${offset}.`);
      }
      const size = view.getInt32(offset, true);
      offset += 4;
      if (size < 0 || offset + size > bytes.length) {
        throw new Error(`Bad size=${size} at offset ${offset - 4}: runs past the end of the buffer.`);
      }
      payloads.push(bytes.subarray(offset, offset + size));
      offset += size;
    }
    groups.push({ defType, payloads });
  }
  return groups;
}

/** @public Used by tools/verify/protodefs-write.mjs through its generated SSR entry. */
export function writeProtoDefGroups(groups: readonly ProtoDefGroup[]): Uint8Array {
  let total = 0;
  for (const group of groups) {
    total += 8;
    for (const payload of group.payloads) total += 4 + payload.length;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let offset = 0;
  for (const group of groups) {
    view.setInt32(offset, group.defType, true);
    view.setInt32(offset + 4, group.payloads.length, true);
    offset += 8;
    for (const payload of group.payloads) {
      view.setInt32(offset, payload.length, true);
      offset += 4;
      out.set(payload, offset);
      offset += payload.length;
    }
  }
  return out;
}

let cachedRoot: Root | null = null;

function loadRoot(): Root {
  if (!cachedRoot) cachedRoot = Root.fromJSON(schemaJson as unknown as INamespace);
  return cachedRoot;
}

/** Serializes one decoded message back to the bytes a container block holds. */
function encodeProtoDefMessage(defType: number, value: Record<string, unknown>): Uint8Array {
  const typeName = MSG_FOR_DEFTYPE[defType];
  if (!typeName) throw new Error(`No message mapping for defType ${defType}.`);
  const message: Type = loadRoot().lookupType(typeName);
  // fromObject before verify: the decoded shape uses plain numbers and strings
  // where the schema wants enums and longs, exactly as decodeType() produced it.
  const prepared = message.fromObject(value);
  const invalid = message.verify(prepared);
  if (invalid) throw new Error(`This war paint's definition does not fit the game's schema: ${invalid}`);
  return message.encode(prepared).finish();
}

function headerDefindex(value: Record<string, unknown>): number | undefined {
  const header = value.header;
  if (header === null || typeof header !== 'object') return undefined;
  const defindex = (header as Record<string, unknown>).defindex;
  return typeof defindex === 'number' ? defindex : undefined;
}

/** Reads every defindex a container already uses for one defType. */
/** @public Used by tools/verify/protodefs-write.mjs through its generated SSR entry. */
export function usedDefindexes(groups: readonly ProtoDefGroup[], defType: number): Set<number> {
  const typeName = MSG_FOR_DEFTYPE[defType];
  if (!typeName) throw new Error(`No message mapping for defType ${defType}.`);
  const message: Type = loadRoot().lookupType(typeName);
  const used = new Set<number>();
  for (const group of groups) {
    if (group.defType !== defType) continue;
    for (const payload of group.payloads) {
      // Only the header is of interest, but protobuf has no way to stop early,
      // so this decodes the message and reads the one field.
      const decoded = message.toObject(message.decode(payload), { longs: Number, enums: Number, defaults: false });
      const defindex = headerDefindex(decoded as Record<string, unknown>);
      if (defindex !== undefined) used.add(defindex);
    }
  }
  return used;
}

function nextFreeDefindex(used: ReadonlySet<number>): number {
  let candidate = 0;
  for (const value of used) if (value >= candidate) candidate = value + 1;
  return candidate;
}

/** Sets a message's own defindex, leaving every reference it holds alone. */
function setHeaderDefindex(value: Record<string, unknown>, defindex: number): void {
  const header = value.header;
  if (header === null || typeof header !== 'object') {
    throw new Error('This message has no header to assign a defindex to.');
  }
  (header as Record<string, unknown>).defindex = defindex;
}

/**
 * Re-points a definition's `operation_template` reference at a new operation.
 *
 * Deliberately narrow. A definition is full of defindexes that mean different
 * things: `item_definition_template` refs into defType 8, `operation_template`
 * into defType 7, and its own header id. Rewriting every field called
 * "defindex" that happens to hold a given number would corrupt all of them the
 * moment the number is a common one like 0, so only `operation_template`
 * objects still pointing at `from` are moved. A paint that reuses a stock
 * operation keeps pointing at it, which is what a paint built on a Valve
 * template needs.
 */
function retargetOperation(value: unknown, from: number, to: number): void {
  if (Array.isArray(value)) {
    for (const entry of value) retargetOperation(entry, from, to);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const current = record[key];
    if (current === null || typeof current !== 'object') continue;
    if (key === 'operation_template') {
      const reference = current as Record<string, unknown>;
      if (reference.defindex === from) reference.defindex = to;
      continue;
    }
    retargetOperation(current, from, to);
  }
}

/**
 * Writes the canonical localization token for the final defindex.
 *
 * The token is the paint's display name in game, and its text embeds the kit's
 * defindex: "9_431_field { field_number: 2 }" resolves through
 * resource/tf_proto_obj_defs_<language>.txt. Point it at the new id so the name
 * this pack ships (see src/export/localization.ts) is the one the game looks up.
 *
 * Do not try to replace the previous numeric id in the string. Community JSON
 * definitions commonly retain an authored placeholder such as
 * "9_###_field { field_number: 2 }" even after their header.defindex has been
 * assigned a synthetic numeric id by the importer. Constructing the token from
 * the final id handles both compiled VPDs and those JSON fragments.
 */
function retargetLocToken(definition: Record<string, unknown>, to: number): void {
  definition.loc_desctoken = `9_${to}_field { field_number: 2 }`;
}

export type SpliceMode = 'append' | 'overwrite';

export interface SpliceProtoDefsOptions {
  /** A complete container: the shipped snapshot, or the player's own file. */
  baseBytes: Uint8Array;
  /** Decoded CMsgPaintKit_Operation for the paint being added. */
  operation: Record<string, unknown>;
  /** Decoded CMsgPaintKit_Definition for the paint being added. */
  definition: Record<string, unknown>;
  /**
   * 'append' adds the paint under a fresh defindex, which is the shape a
   * submission or a shared pack wants and which needs a plugin to equip in
   * game. 'overwrite' writes it over a paint kit that already exists, so an
   * item the player already owns renders as theirs.
   */
  mode: SpliceMode;
  /** Paint kit defindex to replace. Required when mode is 'overwrite'. */
  targetDefindex?: number;
}

export interface SpliceProtoDefsResult {
  bytes: Uint8Array;
  /** Defindex the paint kit ended up at, i.e. what names it in game. */
  paintkitDefindex: number;
  operationDefindex: number;
  /** True when an existing kit was replaced rather than a new one added. */
  replaced: boolean;
}

export function spliceProtoDefs(options: SpliceProtoDefsOptions): SpliceProtoDefsResult {
  const groups = parseProtoDefGroups(options.baseBytes);
  // Deep copy: the caller's decoded messages belong to the loaded container and
  // must not acquire the ids this splice picks.
  const operation = structuredClone(options.operation);
  const definition = structuredClone(options.definition);

  const oldOperationDefindex = headerDefindex(operation);
  const oldPaintkitDefindex = headerDefindex(definition);
  if (oldOperationDefindex === undefined) throw new Error("This war paint's operation has no defindex to rewrite.");
  if (oldPaintkitDefindex === undefined) throw new Error("This war paint's definition has no defindex to rewrite.");

  const operationDefindex = nextFreeDefindex(usedDefindexes(groups, DEF_TYPE_PAINTKIT_OPERATION));
  let paintkitDefindex: number;
  let replaced = false;
  if (options.mode === 'overwrite') {
    if (options.targetDefindex === undefined) {
      throw new Error('Choose which war paint to overwrite.');
    }
    paintkitDefindex = options.targetDefindex;
    replaced = true;
  } else {
    paintkitDefindex = nextFreeDefindex(usedDefindexes(groups, DEF_TYPE_PAINTKIT_DEFINITION));
  }

  // Each of these touches exactly one thing: the operation's own id, the
  // definition's pointer at that operation, the definition's own id, and the
  // name token that embeds it. Nothing else in either message is rewritten.
  setHeaderDefindex(operation, operationDefindex);
  retargetOperation(definition, oldOperationDefindex, operationDefindex);
  setHeaderDefindex(definition, paintkitDefindex);
  retargetLocToken(definition, paintkitDefindex);

  const operationPayload = encodeProtoDefMessage(DEF_TYPE_PAINTKIT_OPERATION, operation);
  const definitionPayload = encodeProtoDefMessage(DEF_TYPE_PAINTKIT_DEFINITION, definition);

  const spliced = groups.map((group) => {
    if (group.defType === DEF_TYPE_PAINTKIT_OPERATION) {
      return { defType: group.defType, payloads: [...group.payloads, operationPayload] };
    }
    if (group.defType === DEF_TYPE_PAINTKIT_DEFINITION) {
      if (!replaced) return { defType: group.defType, payloads: [...group.payloads, definitionPayload] };
      const message: Type = loadRoot().lookupType(MSG_FOR_DEFTYPE[DEF_TYPE_PAINTKIT_DEFINITION]);
      let found = false;
      const payloads = group.payloads.map((payload) => {
        const decoded = message.toObject(message.decode(payload), { longs: Number, enums: Number, defaults: false });
        if (headerDefindex(decoded as Record<string, unknown>) !== paintkitDefindex) return payload;
        found = true;
        return definitionPayload;
      });
      if (!found) {
        throw new Error(`No war paint with defindex ${paintkitDefindex} exists in these definitions to overwrite.`);
      }
      return { defType: group.defType, payloads };
    }
    return group;
  });

  return { bytes: writeProtoDefGroups(spliced), paintkitDefindex, operationDefindex, replaced };
}
