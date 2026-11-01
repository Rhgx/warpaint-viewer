import type { RecipeNode } from '../../compositor/types';
import type { ResolvedNode, ResolvedSticker } from '../../compositor/resolve';
import { protoTextureReference } from '../sticker/stickerTargets';

interface ResolvedGroupSelect {
  groups: string;
  select: number[];
  textureRef?: string;
}

function resolvedTextureReferences(node: RecipeNode): string[] {
  if (node.type === 'texture_lookup') return [node.texture];
  return 'nodes' in node ? node.nodes.flatMap(resolvedTextureReferences) : [];
}

export function collectResolvedGroupSelects(node: RecipeNode, output: ResolvedGroupSelect[] = []): ResolvedGroupSelect[] {
  if (node.type === 'select') output.push({ groups: node.groups, select: node.select.map(Number) });
  if ('nodes' in node) node.nodes.forEach((child, index) => {
    if (child.type !== 'select') {
      collectResolvedGroupSelects(child, output);
      return;
    }
    const refs = index > 0 ? resolvedTextureReferences(node.nodes[index - 1]) : [];
    output.push({
      groups: child.groups,
      select: child.select.map(Number),
      ...(refs.length > 0 ? { textureRef: refs.at(-1) } : {}),
    });
  });
  return output;
}

/** A texture or combine that can supply the texture a following select masks. Generic, so callers keep their node type. */
export function isLayerSourceNode<T extends { readonly type: string }>(
  node: T,
): node is Extract<T, { type: 'texture_lookup' | 'combine_multiply' | 'combine_add' | 'combine_lerp' }> {
  return node.type === 'texture_lookup'
    || node.type === 'combine_multiply'
    || node.type === 'combine_add'
    || node.type === 'combine_lerp';
}

/** Same traversal as collectResolvedGroupSelects(), returning each select's preceding texture or combine node. Position-aligned with it. */
export function collectRecipeLayerNodes(node: RecipeNode, output: (RecipeNode | undefined)[] = []): (RecipeNode | undefined)[] {
  if (node.type === 'select') output.push(undefined);
  if ('nodes' in node) node.nodes.forEach((child, index) => {
    if (child.type !== 'select') {
      collectRecipeLayerNodes(child, output);
      return;
    }
    const preceding = index > 0 ? node.nodes[index - 1] : undefined;
    output.push(preceding && isLayerSourceNode(preceding) ? preceding : undefined);
  });
  return output;
}

export function findRecipeTextureNode(node: RecipeNode, textureRef: string): RecipeNode | null {
  let result: RecipeNode | null = node.type === 'texture_lookup'
    && protoTextureReference(node.texture) === protoTextureReference(textureRef)
    ? node
    : null;
  if ('nodes' in node) {
    for (const child of node.nodes) result = findRecipeTextureNode(child, textureRef) ?? result;
  }
  return result;
}

export function collectResolvedLayerTextureNodes(
  node: ResolvedNode,
  output: (Extract<ResolvedNode, { type: 'texture_lookup' | 'combine_multiply' | 'combine_add' | 'combine_lerp' }> | undefined)[] = [],
): (Extract<ResolvedNode, { type: 'texture_lookup' | 'combine_multiply' | 'combine_add' | 'combine_lerp' }> | undefined)[] {
  if (node.type === 'select') output.push(undefined);
  if ('nodes' in node) node.nodes.forEach((child, index) => {
    if (child.type !== 'select') {
      collectResolvedLayerTextureNodes(child, output);
      return;
    }
    const preceding = index > 0 ? node.nodes[index - 1] : undefined;
    output.push(preceding && isLayerSourceNode(preceding) ? preceding : undefined);
  });
  return output;
}

export function collectAppliedStickers(node: ResolvedNode, output: ResolvedSticker[] = []): ResolvedSticker[] {
  if (node.type === 'apply_sticker') output.push(node);
  if ('nodes' in node) for (const child of node.nodes) collectAppliedStickers(child, output);
  return output;
}
