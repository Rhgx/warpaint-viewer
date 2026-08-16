import type { ResolvedNode } from '../compositor/resolve';

const BLACK_PIXEL = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%221%22 height=%221%22%3E%3Cpath d=%22M0 0h1v1H0z%22/%3E%3C/svg%3E';

function blackBackground(): ResolvedNode {
  return {
    type: 'texture_lookup',
    texture: BLACK_PIXEL,
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

/**
 * A single authored layer can appear in an early technical wear branch and
 * again in the final colour branch. Both occurrences share a source key, but
 * the later one is the texture the user recognises on the finished paint.
 */
export function preferredLayerOccurrenceIndex(
  targets: readonly { readonly sourceKey: string }[],
  active: { readonly sourceKey: string } | null,
): number {
  if (!active) return -1;
  let result = -1;
  targets.forEach((target, index) => {
    if (target.sourceKey === active.sourceKey) result = index;
  });
  return result;
}

/** Active texture and its adjacent select mask, aligned with the editor's layer traversal. */
export function collectResolvedLayerIsolationNodes(
  node: ResolvedNode,
  output: (ResolvedNode | undefined)[] = [],
): (ResolvedNode | undefined)[] {
  if (node.type === 'select') output.push(undefined);
  if ('nodes' in node) node.nodes.forEach((child, index) => {
    if (child.type !== 'select') {
      collectResolvedLayerIsolationNodes(child, output);
      return;
    }
    const preceding = index > 0 ? node.nodes[index - 1] : undefined;
    output.push(preceding && (
      preceding.type === 'texture_lookup'
      || preceding.type === 'combine_multiply'
      || preceding.type === 'combine_add'
      || preceding.type === 'combine_lerp'
    ) ? {
      type: 'combine_lerp',
      black: 0,
      white: 1,
      gamma: 1,
      rotationDeg: 0,
      translateU: 0,
      translateV: 0,
      scale: 1,
      flipU: false,
      flipV: false,
      nodes: [blackBackground(), preceding, child],
    } : undefined);
  });
  return output;
}
