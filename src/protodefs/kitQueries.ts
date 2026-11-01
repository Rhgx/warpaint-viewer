// Kit queries over a decoded container: bundles, weapon slots, recipes and provenance.
import { many } from './messages';
import { resolveOne } from './recipeResolver';
import { traceResolvedValues } from './provenanceTrace';
import { slotSourcePath, type DecodedContainer } from './decoderShared';
import type {
  ProtoDefKitBundle, ProtoDefKitWeaponSlot, ProtoDefOperationScope, ProtoDefRecipe, ProtoDefRecipeWithProvenance,
} from './types';

// Wear levels a per-wear paint authors, Factory New (0) through Battle Scarred (4).
const WEAR_LEVELS = 5;

/**
 * The definition and operation of one kit as plain decoded objects, for
 * src/export/protoWrite.ts to re-encode. The operation is found through the definition's
 * own operation_template, so a paint reusing a stock operation resolves to that operation.
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
 * Everything needed to re-create one kit from JSON fragments. A per-wear paint resolves
 * each (weapon slot, wear) to the operation resolveOne() would pick, clamping to the last
 * wear entry. Null when a referenced operation or item definition is missing.
 */
export function extractKitBundle(decoded: DecodedContainer, defindex: number): ProtoDefKitBundle | null {
  const top = extractKitMessages(decoded, defindex);
  if (top) return { definition: top.definition, operations: [top.operation], itemDefinitions: [], scopes: [] };

  const kit = decoded.kitsByDefindex.get(defindex);
  // A top-level reference that extractKitMessages could not resolve is a dangling pointer, not a per-wear paint.
  if (!kit || kit.def.operation_template || kit.slots.length === 0) return null;

  const operations: Record<string, unknown>[] = [];
  const operationIndexByDefindex = new Map<number, number>();
  const itemDefinitions: Record<string, unknown>[] = [];
  const itemDefinitionDefindexes = new Set<number>();
  const scopes: ProtoDefOperationScope[] = [];

  for (const slot of kit.slots) {
    const itemDefindex = slot.itemDef.header.defindex;
    if (!itemDefinitionDefindexes.has(itemDefindex)) {
      itemDefinitionDefindexes.add(itemDefindex);
      itemDefinitions.push(slot.itemDef as unknown as Record<string, unknown>);
    }
    const wears = many(slot.itemDef.definition);
    for (let wear = 0; wear < WEAR_LEVELS; wear += 1) {
      const entry = wears[Math.max(0, Math.min(wear, wears.length - 1))];
      const reference = entry?.operation_template;
      if (!reference) return null;
      const operation = decoded.ctx.opByIdx.get(reference.defindex);
      if (!operation) return null;
      let operationIndex = operationIndexByDefindex.get(reference.defindex);
      if (operationIndex === undefined) {
        operationIndex = operations.length;
        operations.push(operation as unknown as Record<string, unknown>);
        operationIndexByDefindex.set(reference.defindex, operationIndex);
      }
      scopes.push({ weaponKey: slot.weaponKey, wear, operationIndex });
    }
  }

  return { definition: kit.def as unknown as Record<string, unknown>, operations, itemDefinitions, scopes };
}

/**
 * Every weapon slot on one kit's definition, with the weapon it paints and its authored
 * path. Reads the slots resolved at open() time, so an editor holding only the exported
 * messages can still find each slot's weapon.
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
 * Like resolveKitRecipe, plus a trace of which authored field supplied each operation
 * value. Use resolveKitRecipe when editor diagnostics are not needed.
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
