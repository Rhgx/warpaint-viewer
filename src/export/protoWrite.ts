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
import type { ProtoDefKitBundle } from '../protodefs/types';

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

/** Item definitions are defType 8, mirroring src/protodefs/decoder.ts DEF_TYPE. */
const DEF_TYPE_PAINTKIT_ITEM_DEFINITION = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/** The entries of a decoded field as a list, since a single-entry repeated field can decode to the bare value. */
function entriesOf(value: unknown): Record<string, unknown>[] {
  const list: unknown[] = Array.isArray(value) ? value : [value];
  return list.filter(isRecord);
}

/** The `key` reference each entry of a field holds, e.g. the operation_template of every wear. */
function referencesIn(value: unknown, key: string): Record<string, unknown>[] {
  const references: Record<string, unknown>[] = [];
  for (const entry of entriesOf(value)) {
    const reference = entry[key];
    if (isRecord(reference)) references.push(reference);
  }
  return references;
}

/** Every weapon slot's item_definition_template, whether a named weapon field or an `item` entry. */
function slotTemplates(definition: Record<string, unknown>): Record<string, unknown>[] {
  return Object.values(definition).flatMap((value) => referencesIn(value, 'item_definition_template'));
}

function refDefindex(reference: Record<string, unknown>): number {
  if (typeof reference.defindex !== 'number') throw new Error('A reference in this war paint has no defindex.');
  return reference.defindex;
}

function messageDefindex(message: Record<string, unknown>): number {
  const defindex = headerDefindex(message);
  if (defindex === undefined) throw new Error('A message in this war paint has no defindex to rewrite.');
  return defindex;
}

function mappedDefindex(map: ReadonlyMap<number, number>, from: number): number {
  const to = map.get(from);
  if (to === undefined) throw new Error(`This war paint refers to defindex ${from}, which its bundle does not include.`);
  return to;
}

/** Decodes one block payload to plain objects, the same shape decodeType() produces. */
function decodeMessage(defType: number, payload: Uint8Array): Record<string, unknown> {
  const message: Type = loadRoot().lookupType(MSG_FOR_DEFTYPE[defType]);
  return message.toObject(message.decode(payload), { longs: Number, enums: Number, defaults: false });
}

/** Every message of one defType in the container, keyed by its defindex. */
function decodeGroup(groups: readonly ProtoDefGroup[], defType: number): Map<number, Record<string, unknown>> {
  const decoded = new Map<number, Record<string, unknown>>();
  for (const group of groups) {
    if (group.defType !== defType) continue;
    for (const payload of group.payloads) {
      const message = decodeMessage(defType, payload);
      const defindex = headerDefindex(message);
      if (defindex !== undefined) decoded.set(defindex, message);
    }
  }
  return decoded;
}

/** Pairs a bundle reference with a target one; a pairing that maps two things to one id would write one payload over the other. */
function pairDefindex(map: Map<number, number>, from: number, to: number): void {
  const existing = map.get(from);
  const conflict = (existing !== undefined && existing !== to)
    || [...map].some(([other, target]) => target === to && other !== from);
  if (conflict) throw new Error("This war paint's wear layout does not line up with the one it would overwrite.");
  map.set(from, to);
}

function itemDefinitionFor(items: ReadonlyMap<number, Record<string, unknown>>, template: Record<string, unknown>): Record<string, unknown> {
  const item = items.get(refDefindex(template));
  if (!item) throw new Error('A weapon slot in this war paint points at an item definition it does not include.');
  return item;
}

export interface SpliceProtoDefBundleOptions {
  /** A complete container: the shipped snapshot, or the player's own file. */
  baseBytes: Uint8Array;
  /** The paint to add or replace, as produced by extractKitBundle(). */
  bundle: ProtoDefKitBundle;
  /** Same meaning as SpliceProtoDefsOptions.mode. */
  mode: SpliceMode;
  /** Paint kit defindex to replace. Required when mode is 'overwrite'. */
  targetDefindex?: number;
}

export interface SpliceProtoDefBundleResult extends SpliceProtoDefsResult {
  /** Defindex each bundle operation was written at, in bundle.operations order. */
  operationDefindexes: number[];
  /** Defindex each bundle item definition was written at, in bundle.itemDefinitions order. */
  itemDefinitionDefindexes: number[];
}

interface SpliceIds {
  paintkitDefindex: number;
  /** Bundle operation defindex -> defindex it is written at. */
  operationMap: Map<number, number>;
  /** Bundle item definition defindex -> defindex it is written at. */
  itemDefinitionMap: Map<number, number>;
}

/** Fresh ids for an append: a running counter per defType, starting past what the container already uses. */
function allocateIds(bundle: ProtoDefKitBundle, groups: readonly ProtoDefGroup[]): SpliceIds {
  const operationMap = new Map<number, number>();
  const itemDefinitionMap = new Map<number, number>();
  let nextOperation = nextFreeDefindex(usedDefindexes(groups, DEF_TYPE_PAINTKIT_OPERATION));
  for (const operation of bundle.operations) {
    operationMap.set(messageDefindex(operation), nextOperation);
    nextOperation += 1;
  }
  let nextItem = nextFreeDefindex(usedDefindexes(groups, DEF_TYPE_PAINTKIT_ITEM_DEFINITION));
  for (const item of bundle.itemDefinitions) {
    itemDefinitionMap.set(messageDefindex(item), nextItem);
    nextItem += 1;
  }
  return {
    paintkitDefindex: nextFreeDefindex(usedDefindexes(groups, DEF_TYPE_PAINTKIT_DEFINITION)),
    operationMap,
    itemDefinitionMap,
  };
}

/**
 * Ids for an overwrite: the target's own item definitions and operations. Its
 * weapon slots are paired with the bundle's by items_game item_definition_index
 * (the same weapon in both), and each wear is paired by position.
 */
function pairWithTarget(
  bundle: ProtoDefKitBundle,
  target: { defindex: number; definition: Record<string, unknown> },
  groups: readonly ProtoDefGroup[],
): SpliceIds {
  const bundleItems = new Map<number, Record<string, unknown>>();
  for (const item of bundle.itemDefinitions) bundleItems.set(messageDefindex(item), item);
  const targetItems = decodeGroup(groups, DEF_TYPE_PAINTKIT_ITEM_DEFINITION);
  const bundleSlots = slotTemplates(bundle.definition).map((template) => itemDefinitionFor(bundleItems, template));
  const targetSlots = slotTemplates(target.definition).map((template) => itemDefinitionFor(targetItems, template));
  const operationMap = new Map<number, number>();
  const itemDefinitionMap = new Map<number, number>();
  if (bundleSlots.length !== targetSlots.length) {
    throw new Error("This war paint's weapon slots do not match the ones it would overwrite.");
  }
  for (const bundleItem of bundleSlots) {
    const targetItem = targetSlots.find((item) => item.item_definition_index === bundleItem.item_definition_index);
    if (!targetItem) throw new Error("This war paint's weapon slots do not match the ones it would overwrite.");
    const bundleWears = referencesIn(bundleItem.definition, 'operation_template');
    const targetWears = referencesIn(targetItem.definition, 'operation_template');
    if (bundleWears.length !== targetWears.length) {
      throw new Error("This war paint's wear count for a weapon does not match the one it would overwrite.");
    }
    itemDefinitionMap.set(messageDefindex(bundleItem), messageDefindex(targetItem));
    bundleWears.forEach((wear, index) => pairDefindex(operationMap, refDefindex(wear), refDefindex(targetWears[index])));
  }
  return { paintkitDefindex: target.defindex, operationMap, itemDefinitionMap };
}

/**
 * spliceProtoDefs for a paint that may be per-wear: its weapon slots point at
 * item definitions, and each item definition points at one operation per wear.
 *
 * A top-level paint (one operation, no item definitions) is handed to
 * spliceProtoDefs unchanged. Append writes every operation and item definition
 * under fresh ids. Overwrite replaces the target's own item definitions and
 * operations in place, so nothing new is allocated and nothing else changes.
 */
export function spliceProtoDefBundle(options: SpliceProtoDefBundleOptions): SpliceProtoDefBundleResult {
  const { bundle } = options;
  const topLevel = bundle.itemDefinitions.length === 0 && bundle.operations.length === 1;
  if (!topLevel && (bundle.operations.length === 0 || bundle.itemDefinitions.length === 0)) {
    throw new Error('This war paint has no operations or item definitions to splice.');
  }

  const groups = parseProtoDefGroups(options.baseBytes);
  const target = options.mode === 'overwrite' ? findOverwriteTarget(groups, options.targetDefindex) : undefined;
  if (target && Boolean(target.definition.operation_template) !== topLevel) {
    throw new Error('This war paint is top-level or per-wear, and the one it would overwrite is not.');
  }
  if (topLevel) {
    const result = spliceProtoDefs({
      baseBytes: options.baseBytes,
      operation: bundle.operations[0],
      definition: bundle.definition,
      mode: options.mode,
      targetDefindex: options.targetDefindex,
    });
    return { ...result, operationDefindexes: [result.operationDefindex], itemDefinitionDefindexes: [] };
  }

  const { paintkitDefindex, operationMap, itemDefinitionMap } = target
    ? pairWithTarget(bundle, target, groups)
    : allocateIds(bundle, groups);

  // Every payload is built from a copy, so the caller's bundle keeps its ids.
  const operationPayloads = new Map<number, Uint8Array>();
  for (const operation of bundle.operations) {
    const copy = structuredClone(operation);
    const defindex = mappedDefindex(operationMap, messageDefindex(operation));
    setHeaderDefindex(copy, defindex);
    operationPayloads.set(defindex, encodeProtoDefMessage(DEF_TYPE_PAINTKIT_OPERATION, copy));
  }

  const itemPayloads = new Map<number, Uint8Array>();
  for (const item of bundle.itemDefinitions) {
    const copy = structuredClone(item);
    const defindex = mappedDefindex(itemDefinitionMap, messageDefindex(item));
    setHeaderDefindex(copy, defindex);
    for (const wear of referencesIn(copy.definition, 'operation_template')) {
      wear.defindex = mappedDefindex(operationMap, refDefindex(wear));
    }
    itemPayloads.set(defindex, encodeProtoDefMessage(DEF_TYPE_PAINTKIT_ITEM_DEFINITION, copy));
  }

  const definition = structuredClone(bundle.definition);
  setHeaderDefindex(definition, paintkitDefindex);
  retargetLocToken(definition, paintkitDefindex);
  for (const template of slotTemplates(definition)) {
    template.defindex = mappedDefindex(itemDefinitionMap, refDefindex(template));
  }
  const definitionPayloads = new Map<number, Uint8Array>([
    [paintkitDefindex, encodeProtoDefMessage(DEF_TYPE_PAINTKIT_DEFINITION, definition)],
  ]);

  const placed = new Map<number, Map<number, Uint8Array>>([
    [DEF_TYPE_PAINTKIT_OPERATION, operationPayloads],
    [DEF_TYPE_PAINTKIT_ITEM_DEFINITION, itemPayloads],
    [DEF_TYPE_PAINTKIT_DEFINITION, definitionPayloads],
  ]);
  const total = [...placed.values()].reduce((sum, payloads) => sum + payloads.size, 0);
  let written = 0;
  const spliced = groups.map((group) => {
    const payloadsByDefindex = placed.get(group.defType);
    if (!payloadsByDefindex) return group;
    if (options.mode === 'append') {
      written += payloadsByDefindex.size;
      return { defType: group.defType, payloads: [...group.payloads, ...payloadsByDefindex.values()] };
    }
    const payloads = group.payloads.map((payload) => {
      const defindex = headerDefindex(decodeMessage(group.defType, payload));
      const replacement = defindex === undefined ? undefined : payloadsByDefindex.get(defindex);
      if (replacement === undefined) return payload;
      written += 1;
      return replacement;
    });
    return { defType: group.defType, payloads };
  });
  // Overwrite can only replace ids that exist, so a shortfall means the base is
  // not the container the target came from. Refuse rather than leave the new
  // operation or item definition unreferenced.
  if (written !== total) {
    throw new Error('The base definitions are missing a block or entry this war paint is written to.');
  }

  const operationDefindexes = bundle.operations.map((operation) => mappedDefindex(operationMap, messageDefindex(operation)));
  return {
    bytes: writeProtoDefGroups(spliced),
    paintkitDefindex,
    operationDefindex: operationDefindexes[0],
    replaced: options.mode === 'overwrite',
    operationDefindexes,
    itemDefinitionDefindexes: bundle.itemDefinitions.map((item) => mappedDefindex(itemDefinitionMap, messageDefindex(item))),
  };
}

function findOverwriteTarget(groups: readonly ProtoDefGroup[], targetDefindex: number | undefined): { defindex: number; definition: Record<string, unknown> } {
  if (targetDefindex === undefined) throw new Error('Choose which war paint to overwrite.');
  const definition = decodeGroup(groups, DEF_TYPE_PAINTKIT_DEFINITION).get(targetDefindex);
  if (!definition) {
    throw new Error(`No war paint with defindex ${targetDefindex} exists in these definitions to overwrite.`);
  }
  return { defindex: targetDefindex, definition };
}
