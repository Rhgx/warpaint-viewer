import type * as THREE from 'three';
import type { Compositor, ComposeDimensions } from '../../compositor/compositor';
import type { PaintSeed, RecipeNode } from '../../compositor/types';
import { encodeVtf, type VtfEncodeFlags } from '../../export/vtfEncode';
import { findOperationGraphNode, operationGraphChildren } from './operationGraph';
import type { OperationGraph, OperationGraphNode } from './types';

/** Why a graph node cannot be associated with a resolved recipe subtree. */
export type OperationGraphRecipeUnavailableReason =
  | 'missing-node'
  | 'output-node'
  | 'opaque-operation-template'
  | 'invalid-authored-node'
  | 'recipe-root-mismatch'
  | 'node-kind-mismatch'
  | 'child-count-mismatch'
  | 'shared-authored-node'
  | 'recipe-tree-cycle'
  | 'ambiguous-template-expansion'
  | 'target-not-reached';

export interface OperationGraphRecipeUnavailable {
  readonly ok: false;
  readonly nodeId: string;
  readonly reason: OperationGraphRecipeUnavailableReason;
  readonly message: string;
}

export interface OperationGraphRecipeMapping {
  readonly ok: true;
  readonly nodeId: string;
  /** The resolved recipe subtree corresponding to the requested authored node. */
  readonly recipe: RecipeNode;
  /** Authored graph nodes represented by the complete resolved recipe tree. */
  readonly nodeIds: readonly string[];
}

export interface OperationGraphRenderResult extends OperationGraphRecipeMapping {
  readonly render: OperationGraphRenderLease;
}

export type OperationGraphRecipeResult = OperationGraphRecipeMapping | OperationGraphRecipeUnavailable;

export interface MapOperationGraphRecipeOptions {
  /**
   * The resolved recipe roots in the same order as graph.roots. A resolver
   * with multiple operation roots can pass an array; a normal operation passes
   * one RecipeNode.
   */
  readonly recipeRoots: RecipeNode | readonly RecipeNode[];
}

function isRecipeNode(value: RecipeNode | readonly RecipeNode[]): value is RecipeNode {
  return !Array.isArray(value);
}

function recipeRootList(recipeRoots: RecipeNode | readonly RecipeNode[]): readonly RecipeNode[] {
  if (isRecipeNode(recipeRoots)) return [recipeRoots];
  return recipeRoots;
}

function recipeTypeFor(kind: OperationGraphNode['kind']): RecipeNode['type'] | undefined {
  switch (kind) {
    case 'texture_lookup': return 'texture_lookup';
    case 'select': return 'select';
    case 'combine_add': return 'combine_add';
    case 'combine_multiply': return 'combine_multiply';
    case 'combine_lerp': return 'combine_lerp';
    case 'apply_sticker': return 'apply_sticker';
    default: return undefined;
  }
}

function childRecipes(recipe: RecipeNode): readonly RecipeNode[] {
  switch (recipe.type) {
    case 'combine_add':
    case 'combine_multiply':
    case 'combine_lerp':
    case 'apply_sticker':
      return recipe.nodes;
    case 'texture_lookup':
    case 'select':
      return [];
  }
}

function unavailable(
  nodeId: string,
  reason: OperationGraphRecipeUnavailableReason,
  message: string,
): OperationGraphRecipeUnavailable {
  return { ok: false, nodeId, reason, message };
}

interface RecipeMappingState {
  readonly nodeIds: string[];
  readonly seenGraphNodes: Set<string>;
  readonly activeGraphNodes: Set<string>;
  targetRecipe?: RecipeNode;
}

interface MappingSnapshot {
  readonly nodeIds: readonly string[];
  readonly seenGraphNodes: ReadonlySet<string>;
  readonly activeGraphNodes: ReadonlySet<string>;
  readonly targetRecipe?: RecipeNode;
}

function snapshotMappingState(state: RecipeMappingState): MappingSnapshot {
  return {
    nodeIds: [...state.nodeIds],
    seenGraphNodes: new Set(state.seenGraphNodes),
    activeGraphNodes: new Set(state.activeGraphNodes),
    ...(state.targetRecipe ? { targetRecipe: state.targetRecipe } : {}),
  };
}

function restoreMappingState(state: RecipeMappingState, snapshot: MappingSnapshot): void {
  state.nodeIds.splice(0, state.nodeIds.length, ...snapshot.nodeIds);
  state.seenGraphNodes.clear();
  for (const nodeId of snapshot.seenGraphNodes) state.seenGraphNodes.add(nodeId);
  state.activeGraphNodes.clear();
  for (const nodeId of snapshot.activeGraphNodes) state.activeGraphNodes.add(nodeId);
  state.targetRecipe = snapshot.targetRecipe;
}

interface ChildMappingSearchResult {
  readonly failure: OperationGraphRecipeUnavailable | null;
  readonly snapshot?: MappingSnapshot;
}

function mapAuthoredChildren(
  graph: OperationGraph,
  graphChildren: readonly string[],
  resolvedChildren: readonly RecipeNode[],
  childIndex: number,
  resolvedIndex: number,
  targetNodeId: string,
  state: RecipeMappingState,
): ChildMappingSearchResult {
  if (childIndex === graphChildren.length) {
    if (resolvedIndex === resolvedChildren.length) return { failure: null, snapshot: snapshotMappingState(state) };
    return {
      failure: unavailable(
        targetNodeId,
        'child-count-mismatch',
        `The resolved recipe has ${resolvedChildren.length - resolvedIndex} unmatched inputs after the authored graph children.`,
      ),
    };
  }

  const childId = graphChildren[childIndex]!;
  const childNode = findOperationGraphNode(graph, childId);
  if (!childNode) return { failure: unavailable(targetNodeId, 'missing-node', `Graph node ${childId} is missing.`) };

  if (childNode.kind === 'operation_template') {
    if (childId === targetNodeId) {
      return {
        failure: unavailable(
          targetNodeId,
          'opaque-operation-template',
          `${childNode.label} is an opaque operation-template reference; expand it before previewing this subtree.`,
        ),
      };
    }
    const maxConsumed = resolvedChildren.length - resolvedIndex;
    const successes: MappingSnapshot[] = [];
    let lastFailure: OperationGraphRecipeUnavailable | null = null;
    for (let consumed = 0; consumed <= maxConsumed; consumed += 1) {
      const before = snapshotMappingState(state);
      state.seenGraphNodes.add(childId);
      state.nodeIds.push(childId);
      const rest = mapAuthoredChildren(
        graph,
        graphChildren,
        resolvedChildren,
        childIndex + 1,
        resolvedIndex + consumed,
        targetNodeId,
        state,
      );
      if (rest.snapshot) successes.push(rest.snapshot);
      else if (rest.failure) lastFailure = rest.failure;
      restoreMappingState(state, before);
    }
    if (successes.length === 1) {
      restoreMappingState(state, successes[0]!);
      return { failure: null, snapshot: successes[0] };
    }
    if (successes.length > 1) {
      return {
        failure: unavailable(
          targetNodeId,
          'ambiguous-template-expansion',
          `${childNode.label} could consume multiple resolved recipe input ranges; the node identity is not unambiguous.`,
        ),
      };
    }
    return { failure: lastFailure ?? unavailable(targetNodeId, 'child-count-mismatch', `${childNode.label} could not be aligned with the resolved recipe inputs.`) };
  }

  if (resolvedIndex >= resolvedChildren.length) {
    return {
      failure: unavailable(
        targetNodeId,
        'child-count-mismatch',
        `${childNode.label} has no corresponding resolved recipe input.`,
      ),
    };
  }
  const before = snapshotMappingState(state);
  const childFailure = mapBranch(graph, childId, resolvedChildren[resolvedIndex]!, targetNodeId, state);
  if (childFailure) {
    restoreMappingState(state, before);
    return { failure: childFailure };
  }
  const rest = mapAuthoredChildren(
    graph,
    graphChildren,
    resolvedChildren,
    childIndex + 1,
    resolvedIndex + 1,
    targetNodeId,
    state,
  );
  if (rest.snapshot) return rest;
  restoreMappingState(state, before);
  return rest;
}

function mapBranch(
  graph: OperationGraph,
  graphNodeId: string,
  recipe: RecipeNode,
  targetNodeId: string,
  state: RecipeMappingState,
): OperationGraphRecipeUnavailable | null {
  const graphNode = findOperationGraphNode(graph, graphNodeId);
  if (!graphNode) return unavailable(targetNodeId, 'missing-node', `Graph node ${graphNodeId} is missing.`);
  if (graphNode.kind === 'output') return unavailable(targetNodeId, 'output-node', 'The synthetic Paint output has no recipe subtree.');
  if (state.activeGraphNodes.has(graphNodeId)) {
    return unavailable(targetNodeId, 'recipe-tree-cycle', `The graph contains a cycle at ${graphNode.label}.`);
  }
  if (state.seenGraphNodes.has(graphNodeId)) {
    return unavailable(targetNodeId, 'shared-authored-node', `${graphNode.label} is shared by more than one authored branch.`);
  }
  if (graphNode.kind === 'operation_template') {
    if (graphNodeId === targetNodeId) {
      return unavailable(
        targetNodeId,
        'opaque-operation-template',
        `${graphNode.label} is an opaque operation-template reference; expand it before previewing this subtree.`,
      );
    }
    // A template is a lossless opaque reference in the authored graph, but the
    // resolved recipe already contains the template's expanded subtree. Treat
    // the matching resolved node as a wildcard and continue with siblings so
    // an editable ancestor can still receive an intermediate preview.
    state.seenGraphNodes.add(graphNodeId);
    state.nodeIds.push(graphNodeId);
    return null;
  }
  if (graphNode.kind === 'invalid') {
    return unavailable(targetNodeId, 'invalid-authored-node', `${graphNode.label} has no recognized recipe stage.`);
  }
  const expectedType = recipeTypeFor(graphNode.kind);
  if (!expectedType || recipe.type !== expectedType) {
    return unavailable(
      targetNodeId,
      'node-kind-mismatch',
      `${graphNode.label} maps to ${recipe.type}, not ${expectedType ?? 'a supported recipe stage'}.`,
    );
  }

  const graphChildren = operationGraphChildren(graph, graphNodeId);
  const resolvedChildren = childRecipes(recipe);
  const hasOpaqueChild = graphChildren.some((childId) => findOperationGraphNode(graph, childId)?.kind === 'operation_template');
  if (!hasOpaqueChild && graphChildren.length !== resolvedChildren.length) {
    return unavailable(
      targetNodeId,
      'child-count-mismatch',
      `${graphNode.label} has ${graphChildren.length} authored inputs but its resolved recipe has ${resolvedChildren.length}.`,
    );
  }

  state.activeGraphNodes.add(graphNodeId);
  state.seenGraphNodes.add(graphNodeId);
  state.nodeIds.push(graphNodeId);
  if (graphNodeId === targetNodeId) state.targetRecipe = recipe;
  const childResult = hasOpaqueChild
    ? mapAuthoredChildren(graph, graphChildren, resolvedChildren, 0, 0, targetNodeId, state)
    : graphChildren.reduce<ChildMappingSearchResult | null>((prior, childId, index) => {
      if (prior?.failure || prior?.snapshot === undefined) return prior;
      const childFailure = mapBranch(graph, childId, resolvedChildren[index]!, targetNodeId, state);
      return childFailure ? { failure: childFailure } : { failure: null, snapshot: snapshotMappingState(state) };
    }, { failure: null, snapshot: snapshotMappingState(state) }) ?? { failure: null };
  if (childResult.failure) {
    state.activeGraphNodes.delete(graphNodeId);
    return childResult.failure;
  }
  state.activeGraphNodes.delete(graphNodeId);
  return null;
}

/**
 * Pair a flattened authored graph with the already-resolved recipe tree.
 *
 * The graph deliberately retains variable references and opaque template
 * nodes, while the compositor consumes resolved values. Keeping this pairing
 * separate means preview code never guesses how a variable or template should
 * resolve. It also makes a mismatch an explicit unavailable state instead of
 * silently rendering the wrong node.
 */
export function mapOperationGraphNodeToRecipe(
  graph: OperationGraph,
  nodeId: string,
  options: MapOperationGraphRecipeOptions,
): OperationGraphRecipeResult {
  const targetNode = findOperationGraphNode(graph, nodeId);
  if (!targetNode) return unavailable(nodeId, 'missing-node', `Graph node ${nodeId} is missing.`);
  if (nodeId === graph.outputId) return unavailable(nodeId, 'output-node', 'The synthetic Paint output has no recipe subtree.');
  if (targetNode.kind === 'operation_template') {
    return unavailable(
      nodeId,
      'opaque-operation-template',
      `${targetNode.label} is an opaque operation-template reference; expand it before previewing this subtree.`,
    );
  }

  const roots = recipeRootList(options.recipeRoots);
  if (roots.length !== graph.roots.length) {
    return unavailable(
      nodeId,
      'recipe-root-mismatch',
      `The graph has ${graph.roots.length} authored roots but the resolved recipe has ${roots.length}.`,
    );
  }

  const state: RecipeMappingState = {
    nodeIds: [],
    seenGraphNodes: new Set<string>(),
    activeGraphNodes: new Set<string>(),
  };
  for (let index = 0; index < graph.roots.length; index += 1) {
    const failure = mapBranch(graph, graph.roots[index]!, roots[index]!, nodeId, state);
    if (failure) return failure;
  }
  if (!state.targetRecipe) return unavailable(nodeId, 'target-not-reached', `Graph node ${nodeId} is not reachable from Paint output.`);
  return { ok: true, nodeId, recipe: state.targetRecipe, nodeIds: state.nodeIds };
}

export interface OperationGraphRenderRequest extends MapOperationGraphRecipeOptions {
  readonly graph: OperationGraph;
  readonly nodeId: string;
  readonly seed: PaintSeed;
  readonly dimensions?: ComposeDimensions;
}

/** A composed target whose lifetime is owned explicitly by the caller. */
export interface OperationGraphRenderLease {
  readonly nodeId: string;
  readonly recipe: RecipeNode;
  readonly target: THREE.WebGLRenderTarget;
  readonly texture: THREE.Texture;
  readonly width: number;
  readonly height: number;
  readonly previewDataUrl: (maxDimension?: number, forceOpaque?: boolean) => string;
  readonly previewBlob: (maxDimension?: number, forceOpaque?: boolean) => Promise<Blob>;
  /** Read compositor bytes in top-to-bottom RGBA order for texture export. */
  readonly readbackRgba: () => Uint8Array;
  /** Return the target to the compositor pool. Safe to call more than once. */
  readonly dispose: () => void;
  readonly isDisposed: () => boolean;
}

function makeRenderLease(
  compositor: Compositor,
  nodeId: string,
  recipe: RecipeNode,
  result: { target: THREE.WebGLRenderTarget; texture: THREE.Texture },
): OperationGraphRenderLease {
  let disposed = false;
  return {
    nodeId,
    recipe,
    target: result.target,
    texture: result.texture,
    width: result.target.width,
    height: result.target.height,
    previewDataUrl: (maxDimension = 1024, forceOpaque = true) => {
      if (disposed) throw new Error('The operation graph render lease has already been disposed.');
      return compositor.toPreviewDataUrl(result.target, maxDimension, forceOpaque);
    },
    previewBlob: (maxDimension = 1024, forceOpaque = true) => {
      if (disposed) return Promise.reject(new Error('The operation graph render lease has already been disposed.'));
      return compositor.toPreviewBlob(result.target, maxDimension, forceOpaque);
    },
    readbackRgba: () => {
      if (disposed) throw new Error('The operation graph render lease has already been disposed.');
      const transfer = compositor.toTransferTexture(result.target);
      try {
        const data = transfer.image.data;
        if (!(data instanceof Uint8Array)) throw new Error('The compositor returned a non-RGBA8 transfer texture.');
        return new Uint8Array(data);
      } finally {
        transfer.dispose();
      }
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      compositor.releaseResult(result);
    },
    isDisposed: () => disposed,
  };
}

/** Compose one mapped graph subtree at the requested paint seed. */
export async function composeOperationGraphNode(
  compositor: Compositor,
  request: OperationGraphRenderRequest,
): Promise<OperationGraphRecipeUnavailable | OperationGraphRenderResult> {
  const mapping = mapOperationGraphNodeToRecipe(request.graph, request.nodeId, request);
  if (!mapping.ok) return mapping;
  const result = await compositor.compose(mapping.recipe, request.seed, request.dimensions);
  return {
    ...mapping,
    render: makeRenderLease(compositor, mapping.nodeId, mapping.recipe, result),
  };
}

function assertRenderActive(render: OperationGraphRenderLease): void {
  if (render.isDisposed()) throw new Error('The operation graph render lease has already been disposed.');
}

export interface OperationGraphPreviewOptions {
  readonly maxDimension?: number;
  readonly forceOpaque?: boolean;
}

/** Produce the same browser-displayable PNG data URL used by the compositor. */
export function operationGraphPreviewDataUrl(
  render: OperationGraphRenderLease,
  options: OperationGraphPreviewOptions = {},
): string {
  assertRenderActive(render);
  const maxDimension = options.maxDimension ?? 1024;
  const forceOpaque = options.forceOpaque ?? true;
  return render.previewDataUrl(maxDimension, forceOpaque);
}

export interface OperationGraphObjectUrlLease {
  readonly url: string;
  /** Revoke the URL. Safe to call more than once. */
  readonly dispose: () => void;
  readonly isDisposed: () => boolean;
}

/** Create an explicitly owned object URL for a preview or exported file. */
export function createOperationGraphObjectUrl(blob: Blob): OperationGraphObjectUrlLease {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    throw new Error('Object URLs are not available in this environment.');
  }
  const url = URL.createObjectURL(blob);
  let disposed = false;
  return {
    url,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      URL.revokeObjectURL(url);
    },
    isDisposed: () => disposed,
  };
}

/** Encode a composed graph node as a browser-owned PNG object URL. */
export async function operationGraphPreviewObjectUrl(
  render: OperationGraphRenderLease,
  options: OperationGraphPreviewOptions = {},
): Promise<OperationGraphObjectUrlLease> {
  assertRenderActive(render);
  const blob = await render.previewBlob(options.maxDimension ?? 1024, options.forceOpaque ?? true);
  return createOperationGraphObjectUrl(blob);
}

/** Encode a composed graph node as a PNG byte array. */
export async function exportOperationGraphPng(
  render: OperationGraphRenderLease,
  options: OperationGraphPreviewOptions = {},
): Promise<Uint8Array> {
  assertRenderActive(render);
  const blob = await render.previewBlob(options.maxDimension ?? 1024, options.forceOpaque ?? true);
  return new Uint8Array(await blob.arrayBuffer());
}

export interface OperationGraphVtfOptions {
  readonly format?: 'auto' | 'dxt' | 'bgra8888';
  readonly flags?: VtfEncodeFlags;
}

/** Encode compositor readback bytes as a single-frame VTF. */
export function exportOperationGraphVtf(
  render: OperationGraphRenderLease,
  options: OperationGraphVtfOptions = {},
): Uint8Array {
  assertRenderActive(render);
  return encodeVtf({
    width: render.width,
    height: render.height,
    pixels: render.readbackRgba(),
    format: options.format,
    flags: options.flags,
  });
}
