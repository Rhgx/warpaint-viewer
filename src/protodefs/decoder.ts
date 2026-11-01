// Pure proto_defs decoder and recipe resolver. No DOM or worker globals, so it runs on
// the main thread, in protodefs.worker.ts, or in a Node-side SSR bundle.
//
// A behavioural port of the Node pipeline (tools/lib/proto.mjs, tools/lib/resolve.mjs,
// tools/extract/warpaints.mjs). Not ported: addImplicitStickerSpecs, which must check the
// mounted package for `<base>_s` textures, so the caller applies it on the main thread.

import type { RecipeNode } from '../compositor/types';
import { buildResolveCtx, type ResolveCtx } from './resolve';
import { normalizeProtoDefFragments } from './jsonFragments';
import { asItem, many, type HeaderMsg, type ItemDefinitionMsg, type ItemMsg, type OperationMsg, type PaintkitDefinitionMsg } from './messages';
import { WEAPON_SLOTS, type DecodedContainer, type ResolvedSlot } from './decoderShared';
import { decodeBaseContainer, type RawDecoded } from './decodeContainer';
import { resolveOne } from './recipeResolver';
import type { ProtoDefJsonFragment, ProtoDefKit, ProtoDefOpenOptions } from './types';

// Cap on isNew kits given an iconRef during open(); each one walks a full recipe tree.
const ICON_REF_CAP = 64;

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

// Resolves each slot to the weapon it paints, via the caller's items_game index map. Slots
// with no item definition are dropped; unknown indexes are reported as unsupported.
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
  // Community packs may invent their own pattern directory, so fall back to any texture
  // that is not a weapon map rather than leaving the paint without a thumbnail.
  const patterns = usable.filter((r) => r.startsWith('textures/patterns/'));
  const candidates = patterns.length
    ? patterns
    : usable.filter((r) => !r.startsWith('textures/models/'));
  // Solid color fills are a last resort; a real pattern identifies the paint.
  return candidates.find((r) => !/\/solid_/.test(r)) ?? candidates[0] ?? undefined;
}

// The game composites each team's textures whatever has_team_textures says; that flag only
// shows the inspect panel's team buttons. Every wear is checked, since a later wear can name
// BLU textures alone.
function slotsDifferByTeam(def: PaintkitDefinitionMsg, slots: ResolvedSlot[], ctx: ResolveCtx): boolean {
  return slots.some(({ item, itemDef }) => {
    const wears = Math.max(1, many(itemDef.definition).length);
    for (let wear = 0; wear < wears; wear += 1) {
      const red = resolveOne(def, item, itemDef, wear, 'red', ctx);
      const blu = resolveOne(def, item, itemDef, wear, 'blu', ctx);
      if (JSON.stringify(red?.tree ?? null) !== JSON.stringify(blu?.tree ?? null)) return true;
    }
    return false;
  });
}

// Resolves every slot of every definition into a kit, whatever the raw source: a whole .vpd,
// or the base plus JSON fragments.
function assembleDecoded(raw: RawDecoded, options: ProtoDefOpenOptions): DecodedContainer {
  const { operations, itemDefs, defs, countsByType } = raw;
  const ctx = buildResolveCtx(operations, itemDefs);
  const builtInIds = new Set(options.builtInIds);

  const kitsByDefindex = new Map<number, { def: PaintkitDefinitionMsg; slots: ResolvedSlot[] }>();
  const kits: ProtoDefKit[] = [];
  let iconRefBudget = ICON_REF_CAP;

  for (const def of defs) {
    const defindex = def.header.defindex;
    const unsupportedItemDefs: number[] = [];
    const slots = resolveSlots(def, ctx, options.weaponsByItemDef, unsupportedItemDefs);
    kitsByDefindex.set(defindex, { def, slots });

    const weapons = [...new Set(slots.map((s) => s.weaponKey))].sort();
    const materialOverrides: Record<string, string> = {};
    for (const { item, weaponKey } of slots) {
      const override = item.data?.material_override;
      if (weaponKey !== 'paintkit_tool' && typeof override === 'string' && override) {
        materialOverrides[weaponKey] = override.toLowerCase();
      }
    }
    // Cheap proxy for the pipeline's per-wear rule: some slot offers more than one per-wear entry.
    const perWear = slots.some((s) => many(s.itemDef.definition).length > 1);
    const isNew = !builtInIds.has(defindex);
    // Resolving every slot, wear and team is costly, so only new paints pay for it.
    // Built-in paints take their team flag from the manifest.
    const teamsDiffer = isNew && options.computeTeamFlags !== false && !def.has_team_textures && slotsDifferByTeam(def, slots, ctx);

    let iconRef: string | undefined;
    if (isNew && slots.length > 0 && iconRefBudget > 0) {
      iconRefBudget -= 1;
      const first = slots[0];
      const r = resolveOne(def, first.item, first.itemDef, 0, 'red', ctx);
      if (r) iconRef = pickPaintIconRef(r.tree);
    }

    kits.push({
      defindex,
      name: def.header.name || `paintkit_${defindex}`,
      weapons,
      ...(Object.keys(materialOverrides).length ? { materialOverrides } : {}),
      hasTeamTextures: !!def.has_team_textures || teamsDiffer,
      teamButtonsHidden: !def.has_team_textures && teamsDiffer,
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
// operation, item definition or kit of the same id.
function mergeByDefindex<T extends { header: HeaderMsg }>(base: T[], overlay: T[]): T[] {
  if (overlay.length === 0) return base;
  const map = new Map<number, T>();
  for (const item of base) map.set(item.header.defindex, item);
  for (const item of overlay) map.set(item.header.defindex, item);
  return [...map.values()];
}

/**
 * Assembles a DecodedContainer from community JSON fragments layered over the stock
 * operations, item definitions and variables in baseBytes (public/data/protodefs-base.bin).
 * That base never carries defType 9, so every kit here comes from a fragment.
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
  const fragmentItemDefs: ItemDefinitionMsg[] = [];
  const fragmentDefs: PaintkitDefinitionMsg[] = [];
  for (const fragment of normalized) {
    // Trusted only as far as decodeType()'s own output is: both are plain
    // objects shaped by an external, snake_case schema, never a class instance.
    if (fragment.kind === 'operation') fragmentOperations.push(fragment.value as unknown as OperationMsg);
    else if (fragment.kind === 'itemDefinition') fragmentItemDefs.push(fragment.value as unknown as ItemDefinitionMsg);
    else fragmentDefs.push(fragment.value as unknown as PaintkitDefinitionMsg);
  }

  return assembleDecoded({
    operations: mergeByDefindex(base.operations, fragmentOperations),
    itemDefs: mergeByDefindex(base.itemDefs, fragmentItemDefs),
    defs: mergeByDefindex(base.defs, fragmentDefs),
    countsByType: base.countsByType,
  }, options);
}
