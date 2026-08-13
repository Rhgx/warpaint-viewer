// Pure proto_defs decoder + recipe resolver. No DOM, no worker globals: this
// module only touches its arguments and the bundled schema/proto runtime, so
// it can run identically on the main thread, inside protodefs.worker.ts, or
// (for tools/verify/protodefs.mjs) inside a Node-side SSR bundle.
//
// This is a behavioural port of three Node pipeline files:
//   tools/lib/proto.mjs     -> loadRoot/decodeType (protobufjs/light instead of full protobufjs)
//   tools/lib/resolve.mjs   -> buildIndex/resolveRecipe and all its parse helpers
//   tools/extract/warpaints.mjs -> collectSlots, pickPaintIconRef/PAINT_ICON_JUNK, and the
//                              per-kit weapon/perWear/isNew bookkeeping in the main loop
//
// Deliberately NOT ported: addImplicitStickerSpecs (tools/extract/warpaints.mjs). That rule needs
// to check whether a `<base>_s` texture actually exists in the mounted Source package,
// which this module has no access to; the caller applies it afterwards on the main thread.

import { Root } from 'protobufjs/light';
import type { INamespace, Type } from 'protobufjs/light';
import type { RecipeNode } from '../compositor/types';
import type {
  ProtoDefIndex, ProtoDefJsonFragment, ProtoDefKit, ProtoDefKitWeaponSlot, ProtoDefOpenOptions, ProtoDefRecipe,
  ProtoDefRecipeWithProvenance, ProtoDefValueProvenance, ProtoDefValueTrace,
} from './types';
import { parseContainer } from './container';
import { normalizeProtoDefFragments } from './jsonFragments';
import schemaJson from './schema.generated.json';
import {
  asItem, many,
  type CombineStageMsg, type HeaderMsg, type ItemDefinitionMsg, type ItemMsg,
  type Many, type OperationMsg, type OperationNodeMsg, type OperationStageMsg,
  type PaintkitDefinitionMsg, type VarDefMsg, type VarFieldMsg,
} from './messages';
import {
  applyVarDefOverrides, applyVarFieldOverrides, buildVarDict, parseBool,
  parseInverseRange, parseRange, parseRangeDiv255, parseVec2, texturePublicPath,
  varFieldValue, type VarEntry,
} from './values';
import { buildResolveCtx, type ResolveCtx } from './resolve';

// ---------------------------------------------------------------------------
// Container defType values (tools/lib/proto.mjs DEF_TYPE / MSG_FOR_DEFTYPE).
// ---------------------------------------------------------------------------

const DEF_TYPE = {
  PAINTKIT_VARIABLES: 6,
  PAINTKIT_OPERATION: 7,
  PAINTKIT_ITEM_DEFINITION: 8,
  PAINTKIT_DEFINITION: 9,
} as const;

const MSG_FOR_DEFTYPE: Record<number, string> = {
  6: 'CMsgPaintKit_Variables',
  7: 'CMsgPaintKit_Operation',
  8: 'CMsgPaintKit_ItemDefinition',
  9: 'CMsgPaintKit_Definition',
};

// The paint tool, 15 stock, repeated `item`, and workshop weapon slot field names on
// CMsgPaintKit_Definition (tools/lib/resolve.mjs WEAPON_SLOTS).
const WEAPON_SLOTS = [
  'paintkit_tool', 'flamethrower', 'grenadelauncher', 'knife', 'medigun', 'minigun', 'pistol', 'revolver',
  'rocketlauncher', 'scattergun', 'shotgun', 'smg', 'sniperrifle', 'stickybomb_launcher',
  'ubersaw', 'wrench', 'amputator', 'atom_launcher', 'back_scratcher', 'battleaxe',
  'bazaar_sniper', 'blackbox', 'claidheamohmor', 'crusaders_crossbow', 'degreaser',
  'demo_cannon', 'demo_sultan_sword', 'detonator', 'gatling_gun', 'holymackerel', 'jag',
  'lochnload', 'powerjack', 'quadball', 'reserve_shooter', 'riding_crop', 'russian_riot',
  'scimitar', 'scorch_shot', 'shortstop', 'soda_popper', 'tele_shotgun', 'tomislav',
  'trenchgun', 'winger_pistol',
];

// Cap on how many isNew kits get an iconRef resolved during open(), so importing
// a large container stays fast (each one resolves and walks a full recipe tree).
const ICON_REF_CAP = 64;

// ---------------------------------------------------------------------------
// Loosely-typed shapes of the protobufjs-decoded messages. toObject() is called
// with { arrays: false }, so a repeated field with exactly one entry decodes to
// the bare value rather than a one-element array; `Many<T>` models that and
// `many()` normalizes it back to an array, mirroring the `Array.isArray(x) ? x
// : [x]` checks in tools/extract/warpaints.mjs and tools/lib/resolve.mjs.
// ---------------------------------------------------------------------------

// One slot on a paintkit definition: a named field or a repeated `item` entry,
// resolved to the weapon it paints (tools/extract/warpaints.mjs collectSlots + the
// itemDef/weaponKey resolution inlined into the extract main loop).
interface ResolvedSlot {
  item: ItemMsg;
  itemDef: ItemDefinitionMsg;
  weaponKey: string;
}

// ---------------------------------------------------------------------------
// Schema loading + raw decode (tools/lib/proto.mjs loadRoot/decodeType).
// ---------------------------------------------------------------------------

let cachedRoot: Root | null = null;

function loadRoot(): Root {
  if (cachedRoot) return cachedRoot;
  cachedRoot = Root.fromJSON(schemaJson as unknown as INamespace);
  return cachedRoot;
}

const TO_OBJECT_OPTIONS = {
  longs: Number, enums: Number, bytes: String, defaults: false, arrays: false, objects: false,
};

function decodeType<T>(root: Root, byType: Record<number, { buffer: Uint8Array }[]>, defType: number): T[] {
  const typeName = MSG_FOR_DEFTYPE[defType];
  if (!typeName) throw new Error(`No message mapping for defType ${defType}`);
  const Msg: Type = root.lookupType(typeName);
  const list = byType[defType] ?? [];
  const out: T[] = [];
  for (const { buffer } of list) {
    const decoded = Msg.decode(buffer);
    out.push(Msg.toObject(decoded, TO_OBJECT_OPTIONS) as T);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Value parsing helpers (tools/lib/resolve.mjs, verbatim behaviour).
// ---------------------------------------------------------------------------

// Convert a raw compositor texture reference (no "materials/" prefix, no ".vtf")
// into the public recipe path "textures/<path>.webp".
// ---------------------------------------------------------------------------
// Variable dictionary construction (tools/lib/resolve.mjs).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lookup index (tools/lib/resolve.mjs buildIndex).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Operation tree -> resolved RecipeNode tree (tools/lib/resolve.mjs).
// ---------------------------------------------------------------------------

const DEFAULTS = {
  adjustBlack: [0, 0] as [number, number],
  adjustOffset: [1, 1] as [number, number],
  adjustGamma: [1, 1] as [number, number],
  rotation: [0, 0] as [number, number],
  translateU: [0, 0] as [number, number],
  translateV: [0, 0] as [number, number],
  scaleUV: [1, 1] as [number, number],
};

function resolveTextureRef(
  stage: { texture?: VarFieldMsg; texture_red?: VarFieldMsg; texture_blue?: VarFieldMsg },
  dict: Map<string, VarEntry>,
  team: 'red' | 'blu',
): string | null {
  const chosen = team === 'blu' ? (stage.texture_blue ?? stage.texture) : (stage.texture_red ?? stage.texture);
  return texturePublicPath(varFieldValue(chosen, dict));
}

function commonTransforms(
  stage: {
    adjust_black?: VarFieldMsg; adjust_offset?: VarFieldMsg; adjust_gamma?: VarFieldMsg;
    rotation?: VarFieldMsg; translate_u?: VarFieldMsg; translate_v?: VarFieldMsg;
    scale_uv?: VarFieldMsg; flip_u?: VarFieldMsg; flip_v?: VarFieldMsg;
  },
  dict: Map<string, VarEntry>,
) {
  return {
    adjustBlack: parseRangeDiv255(varFieldValue(stage.adjust_black, dict), DEFAULTS.adjustBlack),
    adjustOffset: parseRangeDiv255(varFieldValue(stage.adjust_offset, dict), DEFAULTS.adjustOffset),
    adjustGamma: parseInverseRange(varFieldValue(stage.adjust_gamma, dict), DEFAULTS.adjustGamma),
    rotation: parseRange(varFieldValue(stage.rotation, dict), DEFAULTS.rotation) as [number, number],
    translateU: parseRange(varFieldValue(stage.translate_u, dict), DEFAULTS.translateU) as [number, number],
    translateV: parseRange(varFieldValue(stage.translate_v, dict), DEFAULTS.translateV) as [number, number],
    scaleUV: parseRange(varFieldValue(stage.scale_uv, dict), DEFAULTS.scaleUV) as [number, number],
    flipU: parseBool(varFieldValue(stage.flip_u, dict)),
    flipV: parseBool(varFieldValue(stage.flip_v, dict)),
  };
}

function resolveNodes(
  nodeList: Many<OperationNodeMsg>,
  ctx: ResolveCtx,
  dict: Map<string, VarEntry>,
  team: 'red' | 'blu',
  textureRefs: Set<string>,
): RecipeNode[] {
  const out: RecipeNode[] = [];
  for (const node of many(nodeList)) {
    if (node.operation_template) {
      const ref = ctx.opByIdx.get(node.operation_template.defindex);
      if (ref) {
        const inlined = resolveNodes(ref.operation_node, ctx, dict, team, textureRefs);
        for (const c of inlined) out.push(c);
      }
      continue;
    }
    if (node.stage) {
      const resolved = resolveStage(node.stage, ctx, dict, team, textureRefs);
      if (resolved) out.push(resolved);
    }
  }
  return out;
}

function resolveStage(
  stage: OperationStageMsg,
  ctx: ResolveCtx,
  dict: Map<string, VarEntry>,
  team: 'red' | 'blu',
  textureRefs: Set<string>,
): RecipeNode | null {
  if (stage.texture_lookup) {
    const s = stage.texture_lookup;
    const tex = resolveTextureRef(s, dict, team);
    if (tex) textureRefs.add(tex);
    return { type: 'texture_lookup', texture: tex ?? '', ...commonTransforms(s, dict) };
  }

  if (stage.combine_multiply || stage.combine_add || stage.combine_lerp) {
    const key = stage.combine_multiply ? 'combine_multiply' : stage.combine_add ? 'combine_add' : 'combine_lerp';
    const s = (stage.combine_multiply ?? stage.combine_add ?? stage.combine_lerp) as CombineStageMsg;
    return {
      type: key,
      ...commonTransforms(s, dict),
      nodes: resolveNodes(s.operation_node, ctx, dict, team, textureRefs),
    };
  }

  if (stage.select) {
    const s = stage.select;
    const groupsVal = varFieldValue(s.groups, dict);
    const groups = texturePublicPath(groupsVal);
    const select: Array<number | string> = [];
    for (const sel of many(s.select)) {
      const v = varFieldValue(sel, dict);
      const num = Number(v);
      select.push(Number.isFinite(num) ? num : (v as string));
    }
    // Zero is padding, not an actual group. An entirely empty selector emits
    // a constant black mask and never samples its groups texture in TF2. Some
    // authored operations leave the groups variable at a template path until
    // a weapon actually uses the selector, so loading it would fail a valid
    // recipe for no visual benefit.
    if (groups && select.some((value) => {
      const parsed = typeof value === 'number' ? value : parseInt(value, 10);
      return Number.isFinite(parsed) && parsed !== 0;
    })) textureRefs.add(groups);
    return { type: 'select', groups: groups ?? '', select };
  }

  if (stage.apply_sticker) {
    const s = stage.apply_sticker;
    const stickers = [];
    for (const st of many(s.sticker)) {
      const base = texturePublicPath(varFieldValue(st.base, dict));
      if (base) textureRefs.add(base);
      const rawWeight = varFieldValue(st.weight, dict);
      const weight = rawWeight === undefined || rawWeight.trim() === '' ? 1 : Number(rawWeight);
      const entry: { base: string; weight: number; spec?: string } = {
        base: base ?? '',
        weight: Number.isFinite(weight) ? weight : 1,
      };
      const specVal = varFieldValue(st.spec, dict);
      if (specVal) {
        const spec = texturePublicPath(specVal);
        if (spec) { entry.spec = spec; textureRefs.add(spec); }
      }
      stickers.push(entry);
    }
    return {
      type: 'apply_sticker',
      stickers,
      destTl: parseVec2(varFieldValue(s.dest_tl, dict), [0, 0]),
      destTr: parseVec2(varFieldValue(s.dest_tr, dict), [0, 0]),
      destBl: parseVec2(varFieldValue(s.dest_bl, dict), [0, 0]),
      adjustBlack: parseRangeDiv255(varFieldValue(s.adjust_black, dict), DEFAULTS.adjustBlack),
      adjustOffset: parseRangeDiv255(varFieldValue(s.adjust_offset, dict), DEFAULTS.adjustOffset),
      adjustGamma: parseInverseRange(varFieldValue(s.adjust_gamma, dict), DEFAULTS.adjustGamma),
      nodes: resolveNodes(s.operation_node, ctx, dict, team, textureRefs),
    };
  }

  return null;
}

// Resolve one (paintkitDef, slotItem, itemDef, wearIdx, team) into a recipe tree.
// Mirrors tools/lib/resolve.mjs resolveRecipe exactly, including its override order.
function resolveOne(
  paintkitDef: PaintkitDefinitionMsg,
  slotItem: ItemMsg,
  itemDef: ItemDefinitionMsg,
  wearIdx: number,
  team: 'red' | 'blu',
  ctx: ResolveCtx,
): { tree: RecipeNode; textureRefs: Set<string> } | null {
  let operationMsg: OperationMsg | null = null;
  let baseHeaderVars: Many<VarDefMsg> = paintkitDef.header.variables;
  if (paintkitDef.operation_template) {
    operationMsg = ctx.opByIdx.get(paintkitDef.operation_template.defindex) ?? null;
  }
  const defs = many(itemDef.definition);
  const clampedIdx = Math.max(0, Math.min(wearIdx, defs.length - 1));
  const perWearDef = defs[clampedIdx];
  if (perWearDef && perWearDef.operation_template) {
    const override = ctx.opByIdx.get(perWearDef.operation_template.defindex);
    if (override) {
      operationMsg = override;
      baseHeaderVars = override.header.variables;
    }
  }
  if (!operationMsg) return null;

  const dict = buildVarDict(baseHeaderVars);
  // Override order matches the SDK: item slot data vars, then item def header vars, then per-wear def vars.
  applyVarFieldOverrides(dict, slotItem.data?.variable);
  applyVarDefOverrides(dict, itemDef.header?.variables);
  if (perWearDef) applyVarFieldOverrides(dict, perWearDef.variable);

  const textureRefs = new Set<string>();
  const nodes = resolveNodes(operationMsg.operation_node, ctx, dict, team, textureRefs);
  // The operation root is an implicit list of nodes; a paintkit operation is a single tree,
  // so if there is exactly one root node use it directly, else wrap in a passthrough combine.
  let tree: RecipeNode;
  if (nodes.length === 1) tree = nodes[0];
  else tree = { type: 'combine_multiply', ...DEFAULTS, flipU: false, flipV: false, nodes };
  return { tree, textureRefs };
}

// ---------------------------------------------------------------------------
// Optional provenance tracing. This intentionally runs alongside (rather than
// inside) the resolver above: the production recipe path stays byte-for-byte
// behaviourally identical, while editor callers can opt in to source details.
// ---------------------------------------------------------------------------

interface TracedVarEntry extends VarEntry {
  provenance: ProtoDefValueProvenance;
}

type TracedDict = Map<string, TracedVarEntry>;

function manyEntryPath<T>(root: string[], source: Many<T>, index: number): string[] {
  return Array.isArray(source) ? [...root, String(index)] : root;
}

// Where one weapon slot's item message lives inside the definition message: a
// named WEAPON_SLOTS field, or a position in the repeated `item` array.
// Shared by the provenance tracer (traceResolvedValues) and the editor-facing
// slot list (getKitWeaponSlots) so both report the exact same authored path.
function slotSourcePath(paintkitDef: PaintkitDefinitionMsg, slotItem: ItemMsg): string[] {
  for (const name of WEAPON_SLOTS) {
    if (asItem(paintkitDef[name]) === slotItem) return ['definition', name];
  }
  const items = many(paintkitDef.item);
  const index = items.indexOf(slotItem);
  return index >= 0 ? manyEntryPath(['definition', 'item'], paintkitDef.item, index) : ['weaponSlot'];
}

function literalFieldValue(field: VarFieldMsg | undefined): string | undefined {
  return varFieldValue(field && { ...field, variable: undefined }, new Map());
}

function buildTracedVarDict(
  variables: Many<VarDefMsg>,
  sourceRoot: string[],
): TracedDict {
  const dict: TracedDict = new Map();
  many(variables).forEach((variable, index) => {
    const variablePath = manyEntryPath(sourceRoot, variables, index);
    dict.set(variable.name, {
      value: variable.value ?? '',
      canOverride: variable.inherit !== false,
      provenance: {
        variableName: variable.name,
        effectiveValue: variable.value ?? '',
        sourcePath: [...variablePath, 'value'],
        editableSourcePath: [...variablePath, 'value'],
        scope: 'global',
        canOverride: variable.inherit !== false,
      },
    });
  });
  return dict;
}

function applyTracedFieldOverrides(
  dict: TracedDict,
  fields: Many<VarFieldMsg>,
  sourceRoot: string[],
  scope: 'weapon' | 'wear',
): void {
  many(fields).forEach((field, index) => {
    const fieldPath = manyEntryPath(sourceRoot, fields, index);
    const entry = field.variable == null ? undefined : dict.get(field.variable);
    const value = literalFieldValue(field);
    if (!entry || !entry.canOverride || value === undefined) return;
    entry.value = value;
    entry.provenance = {
      variableName: field.variable,
      effectiveValue: value,
      sourcePath: fieldPath,
      // Weapon slots live inside the exported paint-kit definition, so edits
      // can be scoped to exactly that weapon. Wear/item-definition overrides
      // live in the shared base container and cannot be written safely.
      ...(sourceRoot[0] === 'definition' ? { editableSourcePath: fieldPath } : {}),
      scope,
      canOverride: entry.canOverride,
    };
  });
}

function applyTracedDefOverrides(
  dict: TracedDict,
  definitions: Many<VarDefMsg>,
  sourceRoot: string[],
): void {
  many(definitions).forEach((definition, index) => {
    const definitionPath = manyEntryPath(sourceRoot, definitions, index);
    const entry = dict.get(definition.name);
    if (!entry?.canOverride) return;
    const value = definition.value ?? '';
    entry.value = value;
    entry.provenance = {
      variableName: definition.name,
      effectiveValue: value,
      sourcePath: [...definitionPath, 'value'],
      scope: 'weapon',
      canOverride: entry.canOverride,
    };
  });
}

function traceField(
  field: VarFieldMsg | undefined,
  fieldPath: string[],
  dict: TracedDict,
  output: ProtoDefValueTrace[],
): void {
  if (!field) return;
  const variable = field.variable;
  const entry = variable === undefined ? undefined : dict.get(variable);
  if (entry) {
    output.push({ fieldPath, provenance: { ...entry.provenance, effectiveValue: entry.value } });
    return;
  }
  output.push({
    fieldPath,
    provenance: {
      ...(variable === undefined ? {} : { variableName: variable }),
      effectiveValue: literalFieldValue(field),
      sourcePath: fieldPath,
      scope: 'literal',
      canOverride: false,
    },
  });
}

function traceCommonTransforms(
  stage: {
    adjust_black?: VarFieldMsg; adjust_offset?: VarFieldMsg; adjust_gamma?: VarFieldMsg;
    rotation?: VarFieldMsg; translate_u?: VarFieldMsg; translate_v?: VarFieldMsg;
    scale_uv?: VarFieldMsg; flip_u?: VarFieldMsg; flip_v?: VarFieldMsg;
  },
  path: string[],
  dict: TracedDict,
  output: ProtoDefValueTrace[],
): void {
  for (const name of ['adjust_black', 'adjust_offset', 'adjust_gamma', 'rotation', 'translate_u', 'translate_v', 'scale_uv', 'flip_u', 'flip_v'] as const) {
    traceField(stage[name], [...path, name], dict, output);
  }
}

function traceNodes(
  nodes: Many<OperationNodeMsg>,
  ctx: ResolveCtx,
  dict: TracedDict,
  team: 'red' | 'blu',
  path: string[],
  output: ProtoDefValueTrace[],
  seenTemplates: Set<number>,
): void {
  many(nodes).forEach((node, index) => {
    const nodePath = manyEntryPath(path, nodes, index);
    if (node.operation_template) {
      const templateId = node.operation_template.defindex;
      const template = ctx.opByIdx.get(templateId);
      if (template && !seenTemplates.has(templateId)) {
        const nextSeen = new Set(seenTemplates);
        nextSeen.add(templateId);
        traceNodes(template.operation_node, ctx, dict, team, ['operationTemplate', String(templateId), 'operation_node'], output, nextSeen);
      }
      return;
    }
    const stage = node.stage;
    if (!stage) return;
    const stagePath = [...nodePath, 'stage'];
    if (stage.texture_lookup) {
      const value = stage.texture_lookup;
      const textureName = team === 'blu' && value.texture_blue ? 'texture_blue' : team === 'red' && value.texture_red ? 'texture_red' : 'texture';
      traceField(value[textureName], [...stagePath, 'texture_lookup', textureName], dict, output);
      traceCommonTransforms(value, [...stagePath, 'texture_lookup'], dict, output);
    } else if (stage.combine_multiply || stage.combine_add || stage.combine_lerp) {
      const name = stage.combine_multiply ? 'combine_multiply' : stage.combine_add ? 'combine_add' : 'combine_lerp';
      const value = stage[name];
      if (!value) return;
      traceCommonTransforms(value, [...stagePath, name], dict, output);
      traceNodes(value.operation_node, ctx, dict, team, [...stagePath, name, 'operation_node'], output, seenTemplates);
    } else if (stage.select) {
      traceField(stage.select.groups, [...stagePath, 'select', 'groups'], dict, output);
      const selectFields = stage.select.select;
      many(selectFields).forEach((field, selectIndex) => traceField(
        field,
        manyEntryPath([...stagePath, 'select', 'select'], selectFields, selectIndex),
        dict,
        output,
      ));
    } else if (stage.apply_sticker) {
      const value = stage.apply_sticker;
      const stickers = value.sticker;
      many(stickers).forEach((sticker, stickerIndex) => {
        const stickerPath = manyEntryPath([...stagePath, 'apply_sticker', 'sticker'], stickers, stickerIndex);
        for (const name of ['base', 'weight', 'spec'] as const) traceField(sticker[name], [...stickerPath, name], dict, output);
      });
      for (const name of ['dest_tl', 'dest_tr', 'dest_bl', 'adjust_black', 'adjust_offset', 'adjust_gamma'] as const) {
        traceField(value[name], [...stagePath, 'apply_sticker', name], dict, output);
      }
      traceNodes(value.operation_node, ctx, dict, team, [...stagePath, 'apply_sticker', 'operation_node'], output, seenTemplates);
    }
  });
}

function traceResolvedValues(
  paintkitDef: PaintkitDefinitionMsg,
  slotItem: ItemMsg,
  itemDef: ItemDefinitionMsg,
  wearIdx: number,
  team: 'red' | 'blu',
  ctx: ResolveCtx,
): ProtoDefValueTrace[] {
  let operationMsg: OperationMsg | null = null;
  let headerVariables = paintkitDef.header.variables;
  let headerPath = ['definition', 'header', 'variables'];
  if (paintkitDef.operation_template) operationMsg = ctx.opByIdx.get(paintkitDef.operation_template.defindex) ?? null;
  const definitions = many(itemDef.definition);
  const clampedIdx = Math.max(0, Math.min(wearIdx, definitions.length - 1));
  const perWearDef = definitions[clampedIdx];
  if (perWearDef?.operation_template) {
    const override = ctx.opByIdx.get(perWearDef.operation_template.defindex);
    if (override) {
      operationMsg = override;
      headerVariables = override.header.variables;
      headerPath = ['operation', 'header', 'variables'];
    }
  }
  if (!operationMsg) return [];

  const dict = buildTracedVarDict(headerVariables, headerPath);
  const slotPath = slotSourcePath(paintkitDef, slotItem);
  applyTracedFieldOverrides(dict, slotItem.data?.variable, [...slotPath, 'data', 'variable'], 'weapon');
  applyTracedDefOverrides(dict, itemDef.header?.variables, ['itemDefinition', String(itemDef.header.defindex), 'header', 'variables']);
  if (perWearDef) {
    const wearPath = manyEntryPath(
      ['itemDefinition', String(itemDef.header.defindex), 'definition'],
      itemDef.definition,
      clampedIdx,
    );
    applyTracedFieldOverrides(dict, perWearDef.variable, [...wearPath, 'variable'], 'wear');
  }

  const output: ProtoDefValueTrace[] = [];
  traceNodes(operationMsg.operation_node, ctx, dict, team, ['operation', 'operation_node'], output, new Set([operationMsg.header.defindex]));
  return output;
}

// ---------------------------------------------------------------------------
// Slot collection (tools/extract/warpaints.mjs collectSlots + the itemDef/weaponKey
// resolution inlined into its main loop).
// ---------------------------------------------------------------------------

function collectRawSlots(def: PaintkitDefinitionMsg): ItemMsg[] {
  const slots: ItemMsg[] = [];
  for (const name of WEAPON_SLOTS) {
    const item = asItem(def[name]);
    if (item) slots.push(item);
  }
  for (const item of many(def.item)) {
    if (item && item.item_definition_template) slots.push(item);
  }
  return slots;
}

// Resolve every slot on a definition to the weapon it paints, using the
// items_game item-definition-index -> weaponKey map the caller supplies.
// Slots whose item definition template is missing, or whose items_game index
// has no catalogued weapon, are dropped; the latter's index is reported back
// so the caller can show it as an unsupported reference.
function resolveSlots(
  def: PaintkitDefinitionMsg,
  ctx: ResolveCtx,
  weaponsByItemDef: Record<string, string>,
  unsupportedItemDefs: number[],
): ResolvedSlot[] {
  const resolved: ResolvedSlot[] = [];
  for (const item of collectRawSlots(def)) {
    const itemDef = ctx.itemDefByIdx.get(item.item_definition_template.defindex);
    if (!itemDef) continue;
    const weaponKey = weaponsByItemDef[String(itemDef.item_definition_index)];
    if (!weaponKey) {
      unsupportedItemDefs.push(itemDef.item_definition_index);
      continue;
    }
    resolved.push({ item, itemDef, weaponKey });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Paintkit thumbnail texture picking (tools/extract/warpaints.mjs pickPaintIconRef).
// ---------------------------------------------------------------------------

const PAINT_ICON_JUNK = /blank_|paint_dirt|paint_blood|paint_scratches|_wearblend|_ao\.|_albedo\./;

function pickPaintIconRef(tree: RecipeNode): string | undefined {
  const ordered: string[] = [];
  const walk = (n: RecipeNode | null | undefined): void => {
    if (!n) return;
    if (n.type === 'texture_lookup' && n.texture) ordered.push(n.texture);
    if ('nodes' in n && Array.isArray(n.nodes)) n.nodes.forEach(walk);
  };
  walk(tree);
  const usable = ordered.filter((r) => !PAINT_ICON_JUNK.test(r));
  // Stock paints keep their artwork under textures/patterns/, but a community
  // author is free to invent a directory (one ships textures/invisible_warpaint/),
  // so fall back to any texture that is not one of the weapon's own maps rather
  // than leaving those paints without a thumbnail.
  const patterns = usable.filter((r) => r.startsWith('textures/patterns/'));
  const candidates = patterns.length
    ? patterns
    : usable.filter((r) => !r.startsWith('textures/models/'));
  // Solid color fills are a last resort; a real pattern identifies the paint.
  return candidates.find((r) => !/\/solid_/.test(r)) ?? candidates[0] ?? undefined;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface DecodedContainer {
  kitsByDefindex: Map<number, { def: PaintkitDefinitionMsg; slots: ResolvedSlot[] }>;
  ctx: ResolveCtx;
  index: ProtoDefIndex;
}

// Decoded contents of one container, before the definitions are resolved into
// kits: shared by the binary path (decodeProtoDefs, decodes every defType out
// of one .vpd) and the JSON path (decodeProtoDefsFromJson, decodes only
// defTypes 6/7/8 out of public/data/protodefs-base.bin and takes defType 9
// from community fragments instead - see decodeBaseContainer's caller).
interface RawDecoded {
  variables: { header: HeaderMsg }[];
  operations: OperationMsg[];
  itemDefs: ItemDefinitionMsg[];
  defs: PaintkitDefinitionMsg[];
  countsByType: Record<number, number>;
}

function decodeBaseContainer(bytes: Uint8Array): RawDecoded {
  const root = loadRoot();
  const { byType } = parseContainer(bytes);

  const countsByType: Record<number, number> = {};
  for (const [defType, list] of Object.entries(byType)) countsByType[Number(defType)] = list.length;

  return {
    variables: decodeType<{ header: HeaderMsg }>(root, byType, DEF_TYPE.PAINTKIT_VARIABLES),
    operations: decodeType<OperationMsg>(root, byType, DEF_TYPE.PAINTKIT_OPERATION),
    itemDefs: decodeType<ItemDefinitionMsg>(root, byType, DEF_TYPE.PAINTKIT_ITEM_DEFINITION),
    defs: decodeType<PaintkitDefinitionMsg>(root, byType, DEF_TYPE.PAINTKIT_DEFINITION),
    countsByType,
  };
}

// Resolves every slot of every definition into a kit. This is the part that is
// identical regardless of where the raw definitions came from: a whole .vpd,
// or protodefs-base.bin plus community JSON fragments layered on top.
function assembleDecoded(raw: RawDecoded, options: ProtoDefOpenOptions): DecodedContainer {
  const { variables, operations, itemDefs, defs, countsByType } = raw;
  const ctx = buildResolveCtx(operations, itemDefs, variables);
  const builtInIds = new Set(options.builtInIds);

  const kitsByDefindex = new Map<number, { def: PaintkitDefinitionMsg; slots: ResolvedSlot[] }>();
  const kits: ProtoDefKit[] = [];
  let iconRefBudget = ICON_REF_CAP;

  for (const def of defs) {
    const defindex = def.header.defindex;
    const unsupportedItemDefs: number[] = [];
    const slots = resolveSlots(def, ctx, options.weaponsByItemDef, unsupportedItemDefs);
    if (!slots.length) continue;

    kitsByDefindex.set(defindex, { def, slots });

    const weapons = [...new Set(slots.map((s) => s.weaponKey))].sort();
    // Cheap proxy for the build pipeline's per-wear rule (see ProtoDefKit.perWear):
    // any slot's item definition template offering more than one per-wear entry.
    const perWear = slots.some((s) => many(s.itemDef.definition).length > 1);
    const isNew = !builtInIds.has(defindex);

    let iconRef: string | undefined;
    if (isNew && iconRefBudget > 0) {
      iconRefBudget -= 1;
      const first = slots[0];
      const r = resolveOne(def, first.item, first.itemDef, 0, 'red', ctx);
      if (r) iconRef = pickPaintIconRef(r.tree);
    }

    kits.push({
      defindex,
      name: def.header.name || `paintkit_${defindex}`,
      weapons,
      hasTeamTextures: !!def.has_team_textures,
      perWear,
      isNew,
      unsupportedItemDefs: [...new Set(unsupportedItemDefs)],
      ...(iconRef ? { iconRef } : {}),
    });
  }

  kits.sort((a, b) => a.defindex - b.defindex);

  return { kitsByDefindex, ctx, index: { kits, countsByType } };
}

export function decodeProtoDefs(bytes: Uint8Array, options: ProtoDefOpenOptions): DecodedContainer {
  return assembleDecoded(decodeBaseContainer(bytes), options);
}

// Later entries win on a shared defindex, so a fragment can override a stock
// operation or item definition of the same id (only operations do in
// practice today: the two fragment kinds classifyProtoDefFragment recognises
// never carry a standalone item definition, but this stays generic rather
// than special-cased to that).
function mergeByDefindex<T extends { header: HeaderMsg }>(base: T[], overlay: T[]): T[] {
  if (overlay.length === 0) return base;
  const map = new Map<number, T>();
  for (const item of base) map.set(item.header.defindex, item);
  for (const item of overlay) map.set(item.header.defindex, item);
  return [...map.values()];
}

/**
 * Assembles a DecodedContainer from community JSON fragments (see
 * src/protodefs/jsonFragments.ts for their tolerant parsing) layered over the
 * stock operations/item definitions/variables in baseBytes - normally
 * public/data/protodefs-base.bin, which carries exactly those defTypes
 * (see tools/extract/warpaints.mjs stepProtodefsBase). baseBytes never carries defType
 * 9 (paintkit definitions), so every kit this returns comes from a fragment.
 */
export function decodeProtoDefsFromJson(
  baseBytes: Uint8Array,
  fragments: ProtoDefJsonFragment[],
  options: ProtoDefOpenOptions,
): DecodedContainer {
  if (fragments.length === 0) throw new Error('No proto_defs JSON fragments were supplied.');
  const base = decodeBaseContainer(baseBytes);
  const normalized = normalizeProtoDefFragments(fragments);

  const fragmentOperations: OperationMsg[] = [];
  const fragmentDefs: PaintkitDefinitionMsg[] = [];
  for (const fragment of normalized) {
    // Trusted only as far as decodeType()'s own output is: both are plain
    // objects shaped by an external, snake_case schema, never a class instance.
    if (fragment.kind === 'operation') fragmentOperations.push(fragment.value as unknown as OperationMsg);
    else fragmentDefs.push(fragment.value as unknown as PaintkitDefinitionMsg);
  }

  return assembleDecoded({
    variables: base.variables,
    operations: mergeByDefindex(base.operations, fragmentOperations),
    itemDefs: base.itemDefs,
    defs: mergeByDefindex(base.defs, fragmentDefs),
    countsByType: base.countsByType,
  }, options);
}

/**
 * The two messages the export builder needs to splice a kit into someone's
 * proto_defs: the paint kit definition and the operation it reads.
 *
 * Returned as plain decoded objects, the same shape decodeType() produces, so
 * src/export/protoWrite.ts can re-encode them with the same schema. The
 * operation is looked up through the definition's own `operation_template`
 * pointer, which is how a paint that reuses a stock Valve operation still
 * resolves: it comes back with whatever operation the definition names, stock
 * or authored.
 */
export function extractKitMessages(
  decoded: DecodedContainer,
  defindex: number,
): { definition: Record<string, unknown>; operation: Record<string, unknown> } | null {
  const kit = decoded.kitsByDefindex.get(defindex);
  if (!kit) return null;
  const definition = kit.def as unknown as Record<string, unknown>;
  const reference = definition.operation_template;
  const operationDefindex = reference !== null && typeof reference === 'object'
    ? (reference as Record<string, unknown>).defindex
    : undefined;
  if (typeof operationDefindex !== 'number') return null;
  const operation = decoded.ctx.opByIdx.get(operationDefindex);
  if (!operation) return null;
  return { definition, operation: operation as unknown as Record<string, unknown> };
}

/**
 * Every weapon slot on one kit's definition, resolved to the weapon it paints
 * and its authored location (see slotSourcePath). Reuses the slot/weaponKey
 * resolution collectRawSlots + resolveSlots already computed at open() time
 * (kit.slots on DecodedContainer) rather than re-deriving it, so an editor
 * that only received the exported definition/operation messages can still
 * discover which weapon each authored slot paints.
 */
export function getKitWeaponSlots(decoded: DecodedContainer, defindex: number): ProtoDefKitWeaponSlot[] {
  const kit = decoded.kitsByDefindex.get(defindex);
  if (!kit) return [];
  return kit.slots.map((slot) => ({
    weaponKey: slot.weaponKey,
    path: slotSourcePath(kit.def, slot.item),
  }));
}

export function resolveKitRecipe(
  decoded: DecodedContainer,
  defindex: number,
  weaponKey: string,
  team: 'red' | 'blu',
  wearIndex: number,
): ProtoDefRecipe | null {
  const kit = decoded.kitsByDefindex.get(defindex);
  if (!kit) return null;
  const slot = kit.slots.find((s) => s.weaponKey === weaponKey);
  if (!slot) return null;
  const resolved = resolveOne(kit.def, slot.item, slot.itemDef, wearIndex, team, decoded.ctx);
  if (!resolved) return null;
  return { tree: resolved.tree, textureRefs: [...resolved.textureRefs] };
}

/**
 * Resolve normally, with an opt-in trace of which authored field supplied every
 * operation value.  Existing callers should keep using resolveKitRecipe when
 * they do not need editor diagnostics.
 */
export function resolveKitRecipeWithProvenance(
  decoded: DecodedContainer,
  defindex: number,
  weaponKey: string,
  team: 'red' | 'blu',
  wearIndex: number,
): ProtoDefRecipeWithProvenance | null {
  const kit = decoded.kitsByDefindex.get(defindex);
  if (!kit) return null;
  const slot = kit.slots.find((entry) => entry.weaponKey === weaponKey);
  if (!slot) return null;
  const resolved = resolveOne(kit.def, slot.item, slot.itemDef, wearIndex, team, decoded.ctx);
  if (!resolved) return null;
  return {
    tree: resolved.tree,
    textureRefs: [...resolved.textureRefs],
    provenance: traceResolvedValues(kit.def, slot.item, slot.itemDef, wearIndex, team, decoded.ctx),
  };
}
