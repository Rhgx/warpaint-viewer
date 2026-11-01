import type { ProtoDefKitMessages } from '../../protodefs/types';
import { asItem, type ItemDataMsg, type ItemMsg } from '../../protodefs/messages';
import { EditorMutationAmbiguityError, cloneMessages } from '../mutationCore';

// Per-weapon material override mutations.

export interface WeaponMaterialTarget {
  /** The weapon this slot paints, e.g. "rocketlauncher". For display/lookup only. */
  weaponKey: string;
  /**
   * Exact authored slot location: ['definition', slotName] for a named field or
   * ['definition', 'item', index] for a repeated entry. From getKitWeaponSlots.
   */
  path: readonly string[];
}

export interface WeaponMaterialUpdate {
  target: WeaponMaterialTarget;
  overridePath: string | null;
}

/** Locates the item message a weapon-slot path names, so its data can be read or replaced. */
function weaponSlotItem(
  definition: Record<string, unknown>,
  path: readonly string[],
): { owner: Record<string, unknown>; key: string; item: ItemMsg } | null {
  if (path[0] !== 'definition' || path.length < 2) return null;
  let cursor: unknown = definition;
  const parts = path.slice(1);
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (cursor && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  if (!cursor || typeof cursor !== 'object') return null;
  const key = parts.at(-1)!;
  const owner = cursor as Record<string, unknown>;
  const item = asItem(owner[key]);
  return item ? { owner, key, item } : null;
}

/**
 * Writes or clears one weapon's item_data material_override. It is a plain string
 * on the weapon's own slot, not a shared variable, so it always writes the slot at target.path.
 */
export function setWeaponMaterialOverride(
  messages: ProtoDefKitMessages,
  target: WeaponMaterialTarget,
  overridePath: string | null,
): ProtoDefKitMessages {
  return setWeaponMaterialOverrides(messages, [{ target, overridePath }]);
}

/** Writes several per-weapon overrides through one cloned definition snapshot. */
export function setWeaponMaterialOverrides(
  messages: ProtoDefKitMessages,
  updates: readonly WeaponMaterialUpdate[],
): ProtoDefKitMessages {
  if (updates.length === 0) return messages;
  const next = cloneMessages(messages);
  const definition = next.definition as Record<string, unknown>;
  let changed = false;
  for (const { target, overridePath } of updates) {
    const located = weaponSlotItem(definition, target.path);
    if (!located) {
      throw new EditorMutationAmbiguityError(`Weapon "${target.weaponKey}" is not an editable slot on this definition.`);
    }
    const { owner, key, item } = located;
    const trimmed = overridePath?.trim() || null;
    const current = item.data?.material_override?.trim() || null;
    if (current === trimmed) continue;
    const data: ItemDataMsg = { ...item.data };
    if (trimmed) data.material_override = trimmed;
    else delete data.material_override;
    owner[key] = { ...item, data };
    changed = true;
  }
  return changed ? next : messages;
}
