import type { ProtoDefKit, ProtoDefSource } from './types';

export async function partitionResolvableKits(
  source: Pick<ProtoDefSource, 'resolveRecipe'>,
  kits: readonly ProtoDefKit[],
): Promise<{ loadable: ProtoDefKit[]; quarantined: ProtoDefKit[] }> {
  const results = await Promise.all(kits.map(async (kit) => {
    const weaponKey = kit.weapons[0];
    if (!weaponKey) return false;
    try {
      return Boolean(await source.resolveRecipe(kit.defindex, weaponKey, 'red', 0));
    } catch {
      return false;
    }
  }));

  return kits.reduce<{ loadable: ProtoDefKit[]; quarantined: ProtoDefKit[] }>(
    (groups, kit, index) => {
      groups[results[index] ? 'loadable' : 'quarantined'].push(kit);
      return groups;
    },
    { loadable: [], quarantined: [] },
  );
}
