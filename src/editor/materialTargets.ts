import type { ProtoDefKitMessages, ProtoDefKitWeaponSlot } from '../protodefs/types';
import { asItem } from '../protodefs/messages';
import type { WeaponMaterialTarget } from './mutations';

/** One weapon's current material_override state, ready for a provenance-correct write. */
export interface WeaponMaterialTargetInfo {
  readonly weaponKey: string;
  readonly target: WeaponMaterialTarget;
  /** The authored override path, or null when this weapon uses its stock material. */
  readonly overridePath: string | null;
}

/** Reads the value at a slot path (['definition', ...]) off the kit's two editable messages. */
function readAtSlotPath(definition: Record<string, unknown>, path: readonly string[]): unknown {
  if (path[0] !== 'definition') return undefined;
  let cursor: unknown = definition;
  for (const part of path.slice(1)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      cursor = Number.isInteger(index) ? cursor[index] : undefined;
    } else if (cursor && typeof cursor === 'object') {
      cursor = (cursor as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cursor;
}

/**
 * Reads each resolved weapon slot's current item_data.material_override off
 * the definition message, using the exact authored path the decoder resolved
 * for that slot (getKitWeaponSlots in src/protodefs/decoder.ts), covering
 * both named weapon-slot fields and repeated `item` entries alike. A weapon
 * with no resolved slot on this kit simply does not appear.
 */
export function discoverWeaponMaterialTargets(
  messages: ProtoDefKitMessages,
  slots: readonly ProtoDefKitWeaponSlot[],
): WeaponMaterialTargetInfo[] {
  const definition = messages.definition as Record<string, unknown>;
  const targets: WeaponMaterialTargetInfo[] = [];
  for (const slot of slots) {
    const item = asItem(readAtSlotPath(definition, slot.path));
    if (!item) continue;
    const override = item.data?.material_override;
    targets.push({
      weaponKey: slot.weaponKey,
      target: { weaponKey: slot.weaponKey, path: slot.path },
      overridePath: typeof override === 'string' && override.trim() ? override.trim() : null,
    });
  }
  return targets;
}
