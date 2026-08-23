import type {
  OperationGraph,
  OperationGraphLayout,
  OperationGraphLayoutOptions,
  OperationGraphPosition,
} from './types';

const DEFAULT_HORIZONTAL_GAP = 32;
const DEFAULT_VERTICAL_GAP = 28;
const DEFAULT_OUTPUT_GAP = 32;
const DEFAULT_NODE_WIDTH = 240;
const DEFAULT_NODE_HEIGHT = 270;

/** Runtime dimensions used by the editor layout. They are never serialized. */
export interface OperationGraphNodeDimensions {
  readonly width: number;
  readonly height: number;
}

/** Optional sizing inputs layered on top of the stable graph layout options. */
export interface OperationGraphLayoutSizingOptions {
  /** Measured React Flow node boxes, keyed by stable operation graph ID. */
  readonly nodeDimensions?: Readonly<Record<string, OperationGraphNodeDimensions>>;
  /** Conservative fallback width for nodes that have not been measured yet. */
  readonly defaultNodeWidth?: number;
  /** Conservative fallback height for nodes that have not been measured yet. */
  readonly defaultNodeHeight?: number;
}

export type OperationGraphLayoutOptionsWithSizing = OperationGraphLayoutOptions & OperationGraphLayoutSizingOptions;

function orderedIncoming(graph: OperationGraph, nodeId: string) {
  return graph.edges
    .filter((edge) => edge.target === nodeId && edge.target !== graph.outputId)
    .sort((a, b) => a.inputIndex - b.inputIndex || a.id.localeCompare(b.id));
}

function positiveDimension(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Produce a deterministic left-to-right layout for an operation forest.
 *
 * Each root owns a vertical subtree slot. Children are stacked in authored
 * order inside that slot, and each parent is centered over the combined child
 * bounds. Slots are disjoint, so nodes at the same depth cannot overlap even
 * when a preview makes one card substantially taller than its siblings.
 */
export function layoutOperationGraph(
  graph: OperationGraph,
  options: OperationGraphLayoutOptionsWithSizing = {},
): OperationGraphLayout {
  const horizontalGap = positiveDimension(options.horizontalGap, DEFAULT_HORIZONTAL_GAP);
  const verticalGap = positiveDimension(options.verticalGap, DEFAULT_VERTICAL_GAP);
  const outputGap = positiveDimension(options.outputGap, DEFAULT_OUTPUT_GAP);
  const fallbackWidth = positiveDimension(options.defaultNodeWidth, DEFAULT_NODE_WIDTH);
  const fallbackHeight = positiveDimension(options.defaultNodeHeight, DEFAULT_NODE_HEIGHT);
  const measured = options.nodeDimensions;
  const hasMeasurements = measured !== undefined;
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const depths = new Map<string, number>();
  const depthStack = new Set<string>();

  const dimensionsOf = (nodeId: string): OperationGraphNodeDimensions => {
    const value = measured?.[nodeId];
    return {
      width: positiveDimension(value?.width, fallbackWidth),
      height: positiveDimension(value?.height, fallbackHeight),
    };
  };

  const childrenOf = (nodeId: string): string[] => orderedIncoming(graph, nodeId)
    .map((edge) => edge.source)
    .filter((id) => nodeIds.has(id));

  const depthOf = (nodeId: string): number => {
    const cached = depths.get(nodeId);
    if (cached !== undefined) return cached;
    if (depthStack.has(nodeId)) return 0;
    depthStack.add(nodeId);
    const children = childrenOf(nodeId);
    const depth = children.length === 0 ? 0 : Math.max(...children.map((child) => depthOf(child) + 1));
    depthStack.delete(nodeId);
    depths.set(nodeId, depth);
    return depth;
  };

  const roots = graph.edges
    .filter((edge) => edge.target === graph.outputId)
    .sort((a, b) => a.inputIndex - b.inputIndex || a.id.localeCompare(b.id))
    .map((edge) => edge.source)
    .filter((id) => nodeIds.has(id));
  for (const node of graph.nodes) {
    if (node.id !== graph.outputId) depthOf(node.id);
  }

  // A subtree's height includes the card height and the compact gaps between
  // its ordered children. Memoization keeps large authored graphs linear.
  const subtreeHeights = new Map<string, number>();
  const measureStack = new Set<string>();
  const subtreeHeightOf = (nodeId: string): number => {
    const cached = subtreeHeights.get(nodeId);
    if (cached !== undefined) return cached;
    const ownHeight = dimensionsOf(nodeId).height;
    if (measureStack.has(nodeId)) return ownHeight;
    measureStack.add(nodeId);
    const children = childrenOf(nodeId);
    const childHeight = children.length === 0
      ? 0
      : children.reduce((sum, child) => sum + subtreeHeightOf(child), 0) + verticalGap * (children.length - 1);
    measureStack.delete(nodeId);
    const result = Math.max(ownHeight, childHeight);
    subtreeHeights.set(nodeId, result);
    return result;
  };

  const columnWidths = new Map<number, number>();
  let deepestDepth = 0;
  for (const node of graph.nodes) {
    if (node.id === graph.outputId) continue;
    const depth = depths.get(node.id) ?? 0;
    deepestDepth = Math.max(deepestDepth, depth);
    columnWidths.set(depth, Math.max(columnWidths.get(depth) ?? 0, dimensionsOf(node.id).width));
  }

  const columnX = new Map<number, number>();
  const preserveFixedOffsets = !hasMeasurements && options.horizontalGap !== undefined;
  let nextX = 0;
  for (let depth = 0; depth <= deepestDepth; depth += 1) {
    const width = columnWidths.get(depth) ?? fallbackWidth;
    columnX.set(depth, preserveFixedOffsets ? depth * horizontalGap : nextX);
    nextX = preserveFixedOffsets ? (depth + 1) * horizontalGap : nextX + width + horizontalGap;
  }

  const positions = new Map<string, OperationGraphPosition>();
  const placed = new Set<string>();
  const placeSubtree = (nodeId: string, top: number): number => {
    if (placed.has(nodeId)) return subtreeHeightOf(nodeId);
    placed.add(nodeId);
    const children = childrenOf(nodeId).filter((child) => !placed.has(child));
    const subtreeHeight = subtreeHeightOf(nodeId);
    const childContentHeight = children.length === 0
      ? 0
      : children.reduce((sum, child) => sum + subtreeHeightOf(child), 0) + verticalGap * (children.length - 1);
    let childTop = top + Math.max(0, (subtreeHeight - childContentHeight) / 2);
    const childBounds: { top: number; bottom: number }[] = [];
    for (const child of children) {
      const childHeight = placeSubtree(child, childTop);
      childBounds.push({ top: childTop, bottom: childTop + childHeight });
      childTop += childHeight + verticalGap;
    }
    const ownHeight = dimensionsOf(nodeId).height;
    const ownTop = childBounds.length === 0
      ? top + (subtreeHeight - ownHeight) / 2
      : (childBounds[0].top + childBounds.at(-1)!.bottom) / 2 - ownHeight / 2;
    positions.set(nodeId, { x: columnX.get(depths.get(nodeId) ?? 0) ?? 0, y: ownTop });
    return subtreeHeight;
  };

  let nextRootTop = 0;
  for (const root of roots) {
    nextRootTop += placeSubtree(root, nextRootTop) + verticalGap;
  }
  // Invalid/disconnected graphs still get deterministic, non-overlapping
  // slots instead of disappearing from the editor.
  for (const node of graph.nodes) {
    if (node.id === graph.outputId || placed.has(node.id)) continue;
    nextRootTop += placeSubtree(node.id, nextRootTop) + verticalGap;
  }

  const rootBounds = roots
    .map((root) => {
      const position = positions.get(root);
      if (!position) return undefined;
      return { top: position.y, bottom: position.y + dimensionsOf(root).height };
    })
    .filter((value): value is { top: number; bottom: number } => value !== undefined);
  const outputDimensions = dimensionsOf(graph.outputId);
  const outputDepth = deepestDepth + 1;
  const outputX = preserveFixedOffsets
    ? outputDepth * horizontalGap + outputGap
    : (columnX.get(deepestDepth) ?? 0) + (columnWidths.get(deepestDepth) ?? fallbackWidth) + outputGap;
  const rootCenter = rootBounds.length === 0
    ? outputDimensions.height / 2
    : (Math.min(...rootBounds.map((bound) => bound.top)) + Math.max(...rootBounds.map((bound) => bound.bottom))) / 2;
  positions.set(graph.outputId, {
    x: outputX,
    y: Math.max(0, rootCenter - outputDimensions.height / 2),
  });

  const layout: Record<string, OperationGraphPosition> = {};
  for (const node of graph.nodes) {
    const position = positions.get(node.id);
    if (position) layout[node.id] = position;
  }
  return layout;
}
