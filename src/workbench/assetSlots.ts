import type { RecipeNode } from '../compositor/types';
import type { WearRecipe } from './types';

export type SlotGroup = 'artwork' | 'mask' | 'support';

export interface AssetSlot {
  ref: string;
  kind: 'texture' | 'mask' | 'sticker' | 'sticker-mask';
  group: SlotGroup;
  /** Optional phong mask shown and edited as a companion of this sticker. */
  specularRef?: string;
}

/** Source convention for the optional phong/specular companion to a sticker. */
export function stickerSpecularRef(baseRef: string): string {
  const extensionIndex = baseRef.lastIndexOf('.');
  const slashIndex = Math.max(baseRef.lastIndexOf('/'), baseRef.lastIndexOf('\\'));
  return extensionIndex > slashIndex
    ? `${baseRef.slice(0, extensionIndex)}_s${baseRef.slice(extensionIndex)}`
    : `${baseRef}_s`;
}

export function collectSlots(recipes: WearRecipe[]): AssetSlot[] {
  if (recipes.length === 0) return [];
  type Draft = Omit<AssetSlot, 'group'>;
  const slots = new Map<string, Draft>();
  const add = (ref: string | undefined, kind: AssetSlot['kind'], specularRef?: string) => {
    if (!ref) return;
    const existing = slots.get(ref);
    if (!existing) slots.set(ref, { ref, kind, ...(specularRef ? { specularRef } : {}) });
    else if (specularRef && !existing.specularRef) slots.set(ref, { ...existing, specularRef });
  };
  const visit = (current: RecipeNode) => {
    switch (current.type) {
      case 'texture_lookup':
        add(current.texture, 'texture');
        break;
      case 'select':
        add(current.groups, 'mask');
        break;
      case 'apply_sticker':
        for (const sticker of current.stickers ?? []) {
          add(sticker.base, 'sticker', sticker.spec ?? stickerSpecularRef(sticker.base));
        }
        current.nodes.forEach(visit);
        break;
      default:
        current.nodes.forEach(visit);
    }
  };
  for (const entry of recipes) visit(entry.recipe);
  const priority = (slot: Draft) => {
    const ref = slot.ref.toLowerCase();
    if (ref.includes('/patterns/workshop/')) return 0;
    if (ref.includes('/patterns/') && !ref.includes('/blank')) return 1;
    if (slot.kind === 'sticker' && !ref.includes('/blank')) return 2;
    if (ref.includes('albedo')) return 3;
    if (slot.kind === 'mask' || slot.kind === 'sticker-mask') return 4;
    if (ref.includes('ao') || ref.includes('wearblend') || ref.includes('/blank')) return 6;
    return 5;
  };
  return [...slots.values()]
    .sort((a, b) => priority(a) - priority(b))
    .map((slot) => {
      const rank = priority(slot);
      const group: SlotGroup = rank <= 2 ? 'artwork' : rank === 4 ? 'mask' : 'support';
      return { ...slot, group };
    });
}

/**
 * Marks inferred package companions as available without reading or decoding
 * them. Values intentionally retain the canonical ref so normal compositor
 * resolution stays lazy and seed-selective.
 */
export function collectPackageStickerSpecularOverrides(
  recipes: WearRecipe[],
  hasTexture: (ref: string) => boolean,
): Record<string, string> {
  return Object.fromEntries(collectSlots(recipes).flatMap((slot) => (
    slot.specularRef && hasTexture(slot.specularRef)
      ? [[slot.specularRef, slot.specularRef]]
      : []
  )));
}
