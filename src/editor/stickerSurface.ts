import type { ResolvedNode, ResolvedSticker, ResolvedTexture } from '../compositor/resolve';
import type { ApplyStickerNode, RecipeNode } from '../compositor/types';

const BLACK_PIXEL = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22%3E%3Cpath d=%22M0 0h1v1H0z%22/%3E%3C/svg%3E';
const WHITE_PIXEL = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22%3E%3Cpath fill=%22white%22 d=%22M0 0h1v1H0z%22/%3E%3C/svg%3E';

export interface ResolvedGroupStickerContext {
  /** Full paint with only the selected group sticker removed. */
  readonly base: ResolvedNode;
  /** Selector branch with only the selected group sticker removed. */
  readonly selectorBase: ResolvedNode;
  /** Full paint if this selector contributes zero at every UV. */
  readonly endpointZero: ResolvedNode;
  /** Full paint if this selector contributes one at every UV. */
  readonly endpointOne: ResolvedNode;
  readonly sticker: ResolvedSticker;
}

/** Clone only the resolved nodes whose source reference changes. */
export function mapResolvedTextureReferences(
  node: ResolvedNode,
  mapReference: (reference: string) => string,
): ResolvedNode {
  switch (node.type) {
    case 'texture_lookup': {
      const texture = mapReference(node.texture);
      return texture === node.texture ? node : { ...node, texture };
    }
    case 'select': {
      const groups = mapReference(node.groups);
      return groups === node.groups ? node : { ...node, groups };
    }
    case 'apply_sticker': {
      const base = mapReference(node.base);
      const spec = node.spec ? mapReference(node.spec) : undefined;
      const nodes = node.nodes.map((child) => mapResolvedTextureReferences(child, mapReference));
      return base === node.base && spec === node.spec && nodes.every((child, index) => child === node.nodes[index])
        ? node
        : { ...node, base, spec, nodes };
    }
    default: {
      const nodes = node.nodes.map((child) => mapResolvedTextureReferences(child, mapReference));
      return nodes.every((child, index) => child === node.nodes[index]) ? node : { ...node, nodes };
    }
  }
}

function constantResolvedTexture(texture: string): ResolvedTexture {
  return {
    type: 'texture_lookup',
    texture,
    black: 0,
    white: 1,
    gamma: 1,
    rotationDeg: 0,
    translateU: 0,
    translateV: 0,
    scale: 1,
    flipU: false,
    flipV: false,
  };
}

function replaceResolvedNode(root: ResolvedNode, path: readonly number[], replacement: ResolvedNode): ResolvedNode {
  if (path.length === 0) return replacement;
  if (!('nodes' in root)) return root;
  const [childIndex, ...remaining] = path;
  const child = root.nodes[childIndex];
  if (!child) return root;
  const nextChild = replaceResolvedNode(child, remaining, replacement);
  if (nextChild === child) return root;
  const nodes = root.nodes.slice();
  nodes[childIndex] = nextChild;
  return { ...root, nodes };
}

/**
 * Describe one group sticker without sampling its authored destination.
 *
 * A group sticker edits the selector branch of a combine_lerp. The old editor
 * cropped the final weapon at the authored destination, which permanently
 * baked in nearby stickers and permanently lost source pixels clipped by that
 * destination. These four resolved trees let the Viewer reconstruct the
 * selector change from the original mask at any destination instead.
 */
export function resolvedGroupStickerContext(
  root: ResolvedNode | null | undefined,
  target: ResolvedSticker | null | undefined,
): ResolvedGroupStickerContext | null {
  if (!root || !target) return null;
  let targetPath: number[] | null = null;
  let selectorPath: number[] | null = null;

  const visit = (node: ResolvedNode, path: number[], selectors: readonly number[][]): void => {
    if (targetPath) return;
    if (node === target) {
      targetPath = path;
      selectorPath = selectors.at(-1)?.slice() ?? null;
      return;
    }
    if (!('nodes' in node)) return;
    node.nodes.forEach((child, childIndex) => {
      const childPath = [...path, childIndex];
      const nextSelectors = node.type === 'combine_lerp' && childIndex === 2
        ? [...selectors, childPath]
        : selectors;
      visit(child, childPath, nextSelectors);
    });
  };

  visit(root, [], []);
  // TypeScript does not observe assignments made by the recursive closure.
  const foundTargetPath = targetPath as number[] | null;
  const foundSelectorPath = selectorPath as number[] | null;
  if (!foundTargetPath || !foundSelectorPath || !target.nodes[0]) return null;
  const selector = foundSelectorPath.reduce<ResolvedNode | null>((node, childIndex) => (
    node && 'nodes' in node ? node.nodes[childIndex] ?? null : null
  ), root);
  if (!selector) return null;
  const relativeTargetPath = foundTargetPath.slice(foundSelectorPath.length);
  const base = replaceResolvedNode(root, foundTargetPath, target.nodes[0]);
  const selectorBase = replaceResolvedNode(selector, relativeTargetPath, target.nodes[0]);
  return {
    base,
    selectorBase,
    endpointZero: replaceResolvedNode(root, foundSelectorPath, constantResolvedTexture(BLACK_PIXEL)),
    endpointOne: replaceResolvedNode(root, foundSelectorPath, constantResolvedTexture(WHITE_PIXEL)),
    sticker: target,
  };
}

/**
 * Convert a compositor render-target readback into the image rows used by the
 * 2D sticker canvas.
 *
 * WebGL returns render-target rows from its lower edge upwards. The
 * compositor's first row is nevertheless UV v=0: Source/glTF textures are
 * uploaded unflipped, so v=0 means the image's visual top. Canvas ImageData's
 * first row is visual top too. Keeping the rows in their original order makes
 * the 2D editor, compositor, and mesh all use one UV convention.
 */
export function compositorReadbackToEditorPixels(
  readback: Uint8ClampedArray,
  width: number,
  height: number,
  forceOpaque = true,
): Uint8ClampedArray {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('The composed surface has invalid dimensions.');
  }
  const expectedLength = width * height * 4;
  if (readback.length !== expectedLength) throw new Error('The composed surface readback has an invalid size.');
  const pixels = new Uint8ClampedArray(readback);
  // Ordinary compositor alpha carries a material mask rather than literal
  // image transparency. Isolated group-sticker artwork is the exception: its
  // alpha deliberately marks the affected local block.
  if (forceOpaque) {
    for (let alpha = 3; alpha < pixels.length; alpha += 4) pixels[alpha] = 255;
  }
  return pixels;
}

/**
 * The 2D canvas for an apply_sticker stage is its first child, not a leaf
 * chosen from somewhere below it. Keeping this as a tiny explicit helper
 * prevents the editor from regressing to a misleading arbitrary texture when
 * the child is a nested composite.
 */
export function preStickerSurface(stage: Pick<ApplyStickerNode, 'nodes'> | null | undefined): RecipeNode | null {
  return stage?.nodes[0] ?? null;
}

/**
 * Return the full paint recipe with exactly one depth-first apply_sticker
 * occurrence replaced by its own pre-sticker input. Outer combine stages and
 * every other sticker remain intact. This is the temporary 3D base used while
 * moving a decal: rendering the full recipe and adding another overlay would
 * otherwise leave the authored decal visible underneath its live position.
 */
export function recipeWithoutStickerOccurrence(root: RecipeNode | null | undefined, occurrence: number): RecipeNode | null {
  if (!root || !Number.isSafeInteger(occurrence) || occurrence < 0) return null;
  let index = 0;
  let removed = false;

  const visit = (node: RecipeNode): RecipeNode => {
    if (node.type === 'apply_sticker') {
      const thisOccurrence = index++;
      if (thisOccurrence === occurrence) {
        const base = node.nodes[0];
        if (!base) return node;
        removed = true;
        return base;
      }
      const nodes = node.nodes.map(visit);
      return nodes.some((child, childIndex) => child !== node.nodes[childIndex]) ? { ...node, nodes } : node;
    }
    if (node.type === 'combine_add' || node.type === 'combine_lerp' || node.type === 'combine_multiply') {
      const nodes = node.nodes.map(visit);
      return nodes.some((child, childIndex) => child !== node.nodes[childIndex]) ? { ...node, nodes } : node;
    }
    return node;
  };

  const result = visit(root);
  return removed ? result : null;
}
