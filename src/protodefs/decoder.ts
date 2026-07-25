// Pure proto_defs decoder + recipe resolver. No DOM, no worker globals: this
// module only touches its arguments and the bundled schema/proto runtime, so
// it can run identically on the main thread, inside protodefs.worker.ts, or
// (for tools/verify-protodefs.mjs) inside a Node-side SSR bundle.
//
// This is a behavioural port of three Node pipeline files:
//   tools/lib/proto.mjs     -> loadRoot/decodeType (protobufjs/light instead of full protobufjs)
//   tools/lib/resolve.mjs   -> buildIndex/resolveRecipe and all its parse helpers
//   tools/extract.mjs       -> collectSlots, pickPaintIconRef/PAINT_ICON_JUNK, and the
//                              per-kit weapon/perWear/isNew bookkeeping in the main loop
//
// Deliberately NOT ported: addImplicitStickerSpecs (tools/extract.mjs). That rule needs
// to check whether a `<base>_s` texture actually exists in the mounted Source package,
// which this module has no access to; the caller applies it afterwards on the main thread.

import { Root } from 'protobufjs/light';
import type { INamespace, Type } from 'protobufjs/light';
import type { RecipeNode } from '../compositor/types';
import type {
  ProtoDefIndex, ProtoDefJsonFragment, ProtoDefKit, ProtoDefOpenOptions, ProtoDefRecipe,
} from './types';
import { parseContainer } from './container';
import { normalizeProtoDefFragments } from './jsonFragments';
import schemaJson from './schema.generated.json';

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

// The 15 stock + repeated `item` + workshop weapon slot field names on
// CMsgPaintKit_Definition (tools/lib/resolve.mjs WEAPON_SLOTS).
const WEAPON_SLOTS = [
  'flamethrower', 'grenadelauncher', 'knife', 'medigun', 'minigun', 'pistol', 'revolver',
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
// : [x]` checks in tools/extract.mjs and tools/lib/resolve.mjs.
// ---------------------------------------------------------------------------

type Many<T> = T | T[] | undefined;

function many<T>(value: Many<T>): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

interface VarDefMsg {
  name: string;
  value?: string;
  inherit?: boolean;
}

interface VarFieldMsg {
  variable?: string;
  float?: number;
  double?: number;
  uint32?: number;
  uint64?: number;
  sint32?: number;
  sint64?: number;
  bool?: boolean;
  string?: string;
}

interface HeaderMsg {
  defindex: number;
  name?: string;
  variables?: Many<VarDefMsg>;
}

interface DefIdMsg {
  defindex: number;
  type?: number;
}

interface ItemDataMsg {
  can_apply_paintkit?: boolean;
  material_override?: string;
  variable?: Many<VarFieldMsg>;
}

interface ItemMsg {
  item_definition_template: DefIdMsg;
  data?: ItemDataMsg;
}

interface DefinitionEntryMsg {
  operation_template?: DefIdMsg;
  variable?: Many<VarFieldMsg>;
}

interface ItemDefinitionMsg {
  header: HeaderMsg;
  item_definition_index: number;
  variable_template?: DefIdMsg;
  definition?: Many<DefinitionEntryMsg>;
}

interface TextureStageMsg {
  texture?: VarFieldMsg;
  texture_red?: VarFieldMsg;
  texture_blue?: VarFieldMsg;
  adjust_black?: VarFieldMsg;
  adjust_offset?: VarFieldMsg;
  adjust_gamma?: VarFieldMsg;
  rotation?: VarFieldMsg;
  translate_u?: VarFieldMsg;
  translate_v?: VarFieldMsg;
  scale_uv?: VarFieldMsg;
  flip_u?: VarFieldMsg;
  flip_v?: VarFieldMsg;
}

interface CombineStageMsg {
  adjust_black?: VarFieldMsg;
  adjust_offset?: VarFieldMsg;
  adjust_gamma?: VarFieldMsg;
  rotation?: VarFieldMsg;
  translate_u?: VarFieldMsg;
  translate_v?: VarFieldMsg;
  scale_uv?: VarFieldMsg;
  flip_u?: VarFieldMsg;
  flip_v?: VarFieldMsg;
  operation_node?: Many<OperationNodeMsg>;
}

interface SelectStageMsg {
  groups?: VarFieldMsg;
  select?: Many<VarFieldMsg>;
}

interface StickerMsg {
  base?: VarFieldMsg;
  weight?: VarFieldMsg;
  spec?: VarFieldMsg;
}

interface StickerStageMsg {
  sticker?: Many<StickerMsg>;
  dest_tl?: VarFieldMsg;
  dest_tr?: VarFieldMsg;
  dest_bl?: VarFieldMsg;
  adjust_black?: VarFieldMsg;
  adjust_offset?: VarFieldMsg;
  adjust_gamma?: VarFieldMsg;
  operation_node?: Many<OperationNodeMsg>;
}

interface OperationStageMsg {
  texture_lookup?: TextureStageMsg;
  combine_add?: CombineStageMsg;
  combine_lerp?: CombineStageMsg;
  combine_multiply?: CombineStageMsg;
  select?: SelectStageMsg;
  apply_sticker?: StickerStageMsg;
}

interface OperationNodeMsg {
  stage?: OperationStageMsg;
  operation_template?: DefIdMsg;
}

interface OperationMsg {
  header: HeaderMsg;
  operation_node?: Many<OperationNodeMsg>;
}

interface PaintkitDefinitionMsg {
  header: HeaderMsg;
  loc_desctoken?: string;
  operation_template?: DefIdMsg;
  has_team_textures?: boolean;
  item?: Many<ItemMsg>;
  // Named weapon slot fields (see WEAPON_SLOTS), each an optional ItemMsg.
  [slotName: string]: unknown;
}

function asItem(value: unknown): ItemMsg | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<ItemMsg>;
  return candidate.item_definition_template ? (candidate as ItemMsg) : undefined;
}

// One slot on a paintkit definition: a named field or a repeated `item` entry,
// resolved to the weapon it paints (tools/extract.mjs collectSlots + the
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

function toNums(str: string | undefined): number[] {
  if (str == null) return [];
  return String(str).trim().split(/\s+/).filter((s) => s.length > 0).map(Number);
}

function parseRange(str: string | undefined, dflt: [number, number] | null): [number, number] | null {
  const n = toNums(str);
  if (n.length === 0) return dflt ? [dflt[0], dflt[1]] : null;
  if (n.length === 1) return [n[0], n[0]];
  return [n[0], n[1]];
}

function parseRangeDiv255(str: string | undefined, dflt: [number, number]): [number, number] {
  const r = parseRange(str, null);
  if (!r) return [dflt[0], dflt[1]];
  return [r[0] / 255, r[1] / 255];
}

function parseInverseRange(str: string | undefined, dflt: [number, number]): [number, number] {
  const r = parseRange(str, null);
  if (!r) return [dflt[0], dflt[1]];
  const inv = (v: number) => (v === 0 ? 0 : 1 / v);
  return [inv(r[0]), inv(r[1])];
}

function parseVec2(str: string | undefined, dflt: [number, number]): [number, number] {
  const n = toNums(str);
  if (n.length >= 2) return [n[0], n[1]];
  if (n.length === 1) return [n[0], n[0]];
  return [dflt[0], dflt[1]];
}

function parseBool(str: string | undefined): boolean {
  if (str == null) return false;
  const s = String(str).trim().toLowerCase();
  return s === '1' || s === 'true';
}

// Convert a raw compositor texture reference (no "materials/" prefix, no ".vtf")
// into the public recipe path "textures/<path>.webp".
function texturePublicPath(ref: string | undefined | null): string | null {
  if (!ref) return null;
  let p = String(ref).trim().replace(/\\/g, '/');
  p = p.replace(/^materials\//i, '');
  // Some workshop refs carry a stray source-image extension (e.g. foo.tga); strip any of them.
  p = p.replace(/\.(vtf|tga|psd|png|webp)$/i, '');
  return `textures/${p}.webp`;
}

// ---------------------------------------------------------------------------
// Variable dictionary construction (tools/lib/resolve.mjs).
// ---------------------------------------------------------------------------

interface VarEntry {
  value: string;
  canOverride: boolean;
}

function varFieldValue(field: VarFieldMsg | undefined, dict: Map<string, VarEntry>): string | undefined {
  if (field == null) return undefined;
  if (field.variable !== undefined && field.variable !== '') {
    const entry = dict.get(field.variable);
    if (entry !== undefined) return entry.value;
    // fall back to the field's own baked default value
  }
  if (field.string !== undefined) return field.string;
  if (field.float !== undefined) return String(field.float);
  if (field.double !== undefined) return String(field.double);
  if (field.uint32 !== undefined) return String(field.uint32);
  if (field.uint64 !== undefined) return String(field.uint64);
  if (field.sint32 !== undefined) return String(field.sint32);
  if (field.sint64 !== undefined) return String(field.sint64);
  if (field.bool !== undefined) return String(field.bool);
  return undefined;
}

function buildVarDict(baseHeaderVars: Many<VarDefMsg>): Map<string, VarEntry> {
  const dict = new Map<string, VarEntry>();
  for (const v of many(baseHeaderVars)) {
    dict.set(v.name, { value: v.value != null ? v.value : '', canOverride: v.inherit !== false });
  }
  return dict;
}

// Apply CMsgVarField overrides (variable=name, value in oneof) - only updates existing keys.
function applyVarFieldOverrides(dict: Map<string, VarEntry>, varFields: Many<VarFieldMsg>): void {
  for (const vf of many(varFields)) {
    const name = vf.variable;
    if (name == null) continue;
    const entry = dict.get(name);
    if (!entry || !entry.canOverride) continue;
    let val: string | undefined;
    if (vf.string !== undefined) val = vf.string;
    else if (vf.float !== undefined) val = String(vf.float);
    else if (vf.double !== undefined) val = String(vf.double);
    else if (vf.uint32 !== undefined) val = String(vf.uint32);
    else if (vf.uint64 !== undefined) val = String(vf.uint64);
    else if (vf.sint32 !== undefined) val = String(vf.sint32);
    else if (vf.sint64 !== undefined) val = String(vf.sint64);
    else if (vf.bool !== undefined) val = String(vf.bool);
    if (val === undefined) continue;
    if (entry.value !== val) entry.value = val;
  }
}

// Apply CMsgVariableDefinition overrides (name/value) - only updates existing keys.
function applyVarDefOverrides(dict: Map<string, VarEntry>, varDefs: Many<VarDefMsg>): void {
  for (const vd of many(varDefs)) {
    const entry = dict.get(vd.name);
    if (!entry || !entry.canOverride) continue;
    const val = vd.value != null ? vd.value : '';
    if (entry.value !== val) entry.value = val;
  }
}

// ---------------------------------------------------------------------------
// Lookup index (tools/lib/resolve.mjs buildIndex).
// ---------------------------------------------------------------------------

interface ResolveCtx {
  opByIdx: Map<number, OperationMsg>;
  itemDefByIdx: Map<number, ItemDefinitionMsg>;
  varByIdx: Map<number, { header: HeaderMsg }>;
}

function buildResolveCtx(operations: OperationMsg[], itemDefs: ItemDefinitionMsg[], variables: { header: HeaderMsg }[]): ResolveCtx {
  const opByIdx = new Map<number, OperationMsg>();
  for (const o of operations) opByIdx.set(o.header.defindex, o);
  const itemDefByIdx = new Map<number, ItemDefinitionMsg>();
  for (const it of itemDefs) itemDefByIdx.set(it.header.defindex, it);
  const varByIdx = new Map<number, { header: HeaderMsg }>();
  for (const v of variables) varByIdx.set(v.header.defindex, v);
  return { opByIdx, itemDefByIdx, varByIdx };
}

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
    if (groups) textureRefs.add(groups);
    const select: Array<number | string> = [];
    for (const sel of many(s.select)) {
      const v = varFieldValue(sel, dict);
      const num = Number(v);
      select.push(Number.isFinite(num) ? num : (v as string));
    }
    return { type: 'select', groups: groups ?? '', select };
  }

  if (stage.apply_sticker) {
    const s = stage.apply_sticker;
    const stickers = [];
    for (const st of many(s.sticker)) {
      const base = texturePublicPath(varFieldValue(st.base, dict));
      if (base) textureRefs.add(base);
      const entry: { base: string; weight: number; spec?: string } = {
        base: base ?? '',
        weight: Number(varFieldValue(st.weight, dict)) || 1,
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
// Slot collection (tools/extract.mjs collectSlots + the itemDef/weaponKey
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
// Paintkit thumbnail texture picking (tools/extract.mjs pickPaintIconRef).
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
 * (see tools/extract.mjs stepProtodefsBase). baseBytes never carries defType
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
