import type { RecipeNode } from '../compositor/types';

/** Source derives an omitted sticker specular map from the sticker base name. */
export function applyImplicitStickerSpecs(
  node: RecipeNode,
  hasTexture: (reference: string) => boolean,
): number {
  let applied = 0;
  if (node.type === 'apply_sticker') {
    for (const sticker of node.stickers ?? []) {
      if (!sticker.base || sticker.spec) continue;
      const implicit = sticker.base.replace(/\.webp$/i, '_s.webp');
      if (!hasTexture(implicit)) continue;
      sticker.spec = implicit;
      applied += 1;
    }
  }
  if ('nodes' in node) {
    for (const child of node.nodes) applied += applyImplicitStickerSpecs(child, hasTexture);
  }
  return applied;
}
