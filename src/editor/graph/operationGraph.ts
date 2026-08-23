import { many, type Many, type OperationMsg, type OperationNodeMsg, type OperationStageMsg } from '../../protodefs/messages';
import {
  manyShape,
  type GraphPathSegment,
  type ManyShape,
  type OperationGraph,
  type OperationGraphBuildOptions,
  type OperationGraphEdge,
  type OperationGraphNode,
  type OperationGraphNodeKind,
  type OperationGraphPath,
  type OperationGraphPort,
  type OperationPortType,
  type OperationStageKind,
} from './types';

const STAGE_KINDS: readonly OperationStageKind[] = [
  'texture_lookup',
  'select',
  'combine_add',
  'combine_multiply',
  'combine_lerp',
  'apply_sticker',
];

const CONTAINER_KINDS = new Set<OperationStageKind>([
  'combine_add',
  'combine_multiply',
  'combine_lerp',
  'apply_sticker',
]);

type OperationStageValue = NonNullable<OperationStageMsg[keyof OperationStageMsg]>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function pathId(path: OperationGraphPath): string {
  return `operation-node:${path.map((segment) => (
    typeof segment === 'number' ? `#${segment}` : encodeURIComponent(segment)
  )).join('/')}`;
}

function stageValue(stage: OperationStageMsg | undefined, kind: OperationStageKind): OperationStageValue | undefined {
  if (!stage) return undefined;
  switch (kind) {
    case 'texture_lookup': return stage.texture_lookup;
    case 'select': return stage.select;
    case 'combine_add': return stage.combine_add;
    case 'combine_multiply': return stage.combine_multiply;
    case 'combine_lerp': return stage.combine_lerp;
    case 'apply_sticker': return stage.apply_sticker;
  }
}

function stageKindOf(node: OperationNodeMsg): { kind: OperationGraphNodeKind; stageCount: number } {
  if (node.operation_template !== undefined) return { kind: 'operation_template', stageCount: 0 };
  const stage = node.stage;
  if (!stage || typeof stage !== 'object') return { kind: 'invalid', stageCount: 0 };
  const present = STAGE_KINDS.filter((kind) => stageValue(stage, kind) !== undefined);
  if (present.length === 1) return { kind: present[0], stageCount: 1 };
  if (present.length > 1) return { kind: present[0] ?? 'invalid', stageCount: present.length };
  return { kind: 'invalid', stageCount: 0 };
}

function nestedNodesOf(node: OperationNodeMsg, kind: OperationGraphNodeKind): Many<OperationNodeMsg> | undefined {
  if (!node.stage) return undefined;
  switch (kind) {
    case 'combine_add': return node.stage.combine_add?.operation_node;
    case 'combine_multiply': return node.stage.combine_multiply?.operation_node;
    case 'combine_lerp': return node.stage.combine_lerp?.operation_node;
    case 'apply_sticker': return node.stage.apply_sticker?.operation_node;
    default: return undefined;
  }
}

function outputTypeOf(kind: OperationGraphNodeKind): OperationPortType {
  switch (kind) {
    case 'select': return 'mask';
    case 'texture_lookup':
    case 'combine_add':
    case 'combine_multiply':
    case 'combine_lerp':
    case 'apply_sticker': return 'texture';
    case 'operation_template':
    case 'invalid': return 'unknown';
    case 'output': return 'none';
  }
}

function port(id: string, label: string, index: number, type: OperationPortType, required = true, variadic = false): OperationGraphPort {
  return { id, label, index, type, required, ...(variadic ? { variadic: true } : {}) };
}

function inputPortsFor(kind: OperationGraphNodeKind, childCount: number): readonly OperationGraphPort[] {
  switch (kind) {
    case 'combine_add':
    case 'combine_multiply': {
      const count = Math.max(2, childCount);
      return Array.from({ length: count }, (_, index) => port(
        `input-${index}`,
        `Input ${index + 1}`,
        index,
        'texture',
        index < 2,
        true,
      ));
    }
    case 'combine_lerp':
      return [
        port('input-0', 'Background', 0, 'texture'),
        port('input-1', 'Foreground', 1, 'texture'),
        port('input-2', 'Blend mask', 2, 'mask'),
      ];
    case 'apply_sticker':
      return [port('input-0', 'Surface', 0, 'texture')];
    case 'output':
      return Array.from({ length: childCount }, (_, index) => port(
        `input-${index}`,
        `Result ${index + 1}`,
        index,
        'unknown',
        true,
        true,
      ));
    default:
      return [];
  }
}

function labelFor(kind: OperationGraphNodeKind, raw: OperationNodeMsg): string {
  switch (kind) {
    case 'texture_lookup': return 'Texture lookup';
    case 'select': return 'Select groups';
    case 'combine_add': return 'Add textures';
    case 'combine_multiply': return 'Multiply textures';
    case 'combine_lerp': return 'Blend textures';
    case 'apply_sticker': return 'Apply sticker';
    case 'operation_template': {
      const defindex = raw.operation_template?.defindex;
      return defindex === undefined ? 'Operation template' : `Operation template #${defindex}`;
    }
    case 'output': return 'Paint output';
    case 'invalid': return 'Unknown operation';
  }
}

function edgeId(source: string, target: string, inputIndex: number): string {
  return `operation-edge:${source}->${target}:${inputIndex}`;
}

function setNestedNodes(node: OperationNodeMsg, kind: OperationGraphNodeKind, children: Many<OperationNodeMsg>): void {
  if (!node.stage) throw new Error(`Cannot serialize ${kind} node without an authored stage.`);
  switch (kind) {
    case 'combine_add':
      if (!node.stage.combine_add) throw new Error('Cannot serialize a combine_add node without its authored stage.');
      node.stage.combine_add.operation_node = children;
      return;
    case 'combine_multiply':
      if (!node.stage.combine_multiply) throw new Error('Cannot serialize a combine_multiply node without its authored stage.');
      node.stage.combine_multiply.operation_node = children;
      return;
    case 'combine_lerp':
      if (!node.stage.combine_lerp) throw new Error('Cannot serialize a combine_lerp node without its authored stage.');
      node.stage.combine_lerp.operation_node = children;
      return;
    case 'apply_sticker':
      if (!node.stage.apply_sticker) throw new Error('Cannot serialize an apply_sticker node without its authored stage.');
      node.stage.apply_sticker.operation_node = children;
      return;
    default:
      return;
  }
}

function childrenWithShape(children: readonly OperationNodeMsg[], shape: ManyShape): Many<OperationNodeMsg> {
  if (children.length === 0) return shape === 'array' ? [] : undefined;
  if (children.length === 1 && shape !== 'array') return clone(children[0]);
  return children.map((child) => clone(child));
}

function rootsFromEdges(graph: OperationGraph): readonly string[] {
  return graph.edges
    .filter((edge) => edge.target === graph.outputId)
    .sort((a, b) => a.inputIndex - b.inputIndex || a.id.localeCompare(b.id))
    .map((edge) => edge.source);
}

/**
 * Flatten one authored operation-node tree into a graph suitable for a node UI.
 *
 * The graph intentionally stores a detached raw node on every authored node.
 * This is what lets a no-op graph round trip retain variable references and
 * fields added to the proto after this editor was written.
 */
export function operationNodesToGraph(
  rootNodes: Many<OperationNodeMsg>,
  options: OperationGraphBuildOptions = {},
): OperationGraph {
  const rootShape = manyShape(rootNodes);
  const outputId = options.outputId ?? 'operation-output';
  const pathPrefix = options.pathPrefix ?? [];
  const nodes: OperationGraphNode[] = [];
  const edges: OperationGraphEdge[] = [];
  const roots: string[] = [];

  const visit = (rawInput: OperationNodeMsg, index: number, parentCollectionPath: OperationGraphPath): string => {
    const raw = clone(rawInput);
    const path: OperationGraphPath = [...parentCollectionPath, index];
    const id = pathId(path);
    const info = stageKindOf(raw);
    const nested = nestedNodesOf(raw, info.kind);
    const nestedList = many(nested);
    const nodeIndex = nodes.length;
    nodes.push({
      id,
      kind: info.kind,
      label: labelFor(info.kind, raw),
      raw,
      sourcePath: path,
      outputType: outputTypeOf(info.kind),
      inputPorts: inputPortsFor(info.kind, nestedList.length),
      locked: info.kind === 'operation_template',
      children: [],
      ...(CONTAINER_KINDS.has(info.kind as OperationStageKind) ? { childrenShape: manyShape(nested) } : {}),
      ...(info.kind === 'operation_template' ? { lockedSnapshot: clone(raw) } : {}),
    });

    const childIds: string[] = [];
    const childCollectionPath: OperationGraphPath = [...path, 'stage', info.kind, 'operation_node'];
    nestedList.forEach((child, childIndex) => {
      const childId = visit(child, childIndex, childCollectionPath);
      childIds.push(childId);
      const childNode = nodes.find((candidate) => candidate.id === childId);
      const sourceType = childNode?.outputType ?? 'unknown';
      edges.push({
        id: edgeId(childId, id, childIndex),
        source: childId,
        target: id,
        sourceHandle: 'output',
        targetHandle: `input-${childIndex}`,
        inputIndex: childIndex,
        type: sourceType,
      });
    });
    nodes[nodeIndex] = { ...nodes[nodeIndex], children: childIds };
    return id;
  };

  const rootCollectionPath: OperationGraphPath = [...pathPrefix, 'operation_node'];
  many(rootNodes).forEach((root, index) => {
    const rootId = visit(root, index, rootCollectionPath);
    roots.push(rootId);
    const rootNode = nodes.find((candidate) => candidate.id === rootId);
    edges.push({
      id: edgeId(rootId, outputId, index),
      source: rootId,
      target: outputId,
      sourceHandle: 'output',
      targetHandle: `input-${index}`,
      inputIndex: index,
      type: rootNode?.outputType ?? 'unknown',
    });
  });

  const outputRaw: OperationNodeMsg = {};
  nodes.push({
    id: outputId,
    kind: 'output',
    label: 'Paint output',
    sourcePath: [...pathPrefix, 'output'],
    outputType: 'none',
    inputPorts: inputPortsFor('output', roots.length),
    locked: true,
    children: roots,
    raw: outputRaw,
  });

  return {
    nodes,
    edges,
    roots,
    outputId,
    rootShape,
    ...(options.operationSnapshot ? { operationSnapshot: clone(options.operationSnapshot) } : {}),
  };
}

/** Build a graph from an OperationMsg while retaining a detached message snapshot. */
export function operationToGraph(operation: OperationMsg, options: Omit<OperationGraphBuildOptions, 'operationSnapshot'> = {}): OperationGraph {
  return operationNodesToGraph(operation.operation_node, { ...options, operationSnapshot: operation });
}

function nodeMap(graph: OperationGraph): Map<string, OperationGraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function incomingEdges(graph: OperationGraph, target: string): readonly OperationGraphEdge[] {
  return graph.edges
    .filter((edge) => edge.target === target && edge.target !== graph.outputId)
    .sort((a, b) => a.inputIndex - b.inputIndex || a.id.localeCompare(b.id));
}

function serializeNode(graph: OperationGraph, nodes: Map<string, OperationGraphNode>, nodeId: string, active: Set<string>): OperationNodeMsg {
  const node = nodes.get(nodeId);
  if (!node || node.kind === 'output') throw new Error(`Cannot serialize missing authored node ${nodeId}.`);
  if (!node.raw) throw new Error(`Cannot serialize authored node ${nodeId} without its raw message.`);
  if (active.has(nodeId)) throw new Error(`Cannot serialize cyclic operation graph at ${nodeId}.`);
  active.add(nodeId);

  const raw = clone(node.raw);
  const children = incomingEdges(graph, nodeId).map((edge) => serializeNode(graph, nodes, edge.source, active));
  if (CONTAINER_KINDS.has(node.kind as OperationStageKind)) {
    setNestedNodes(raw, node.kind, childrenWithShape(children, node.childrenShape ?? 'array'));
  } else if (children.length > 0) {
    throw new Error(`Node ${nodeId} of kind ${node.kind} cannot own child nodes.`);
  }
  active.delete(nodeId);
  return raw;
}

/** Serialize the graph back to the operation_node field's original Many shape. */
export function graphToOperationNodes(graph: OperationGraph): Many<OperationNodeMsg> {
  const nodes = nodeMap(graph);
  const roots = rootsFromEdges(graph);
  const serialized = roots.map((rootId) => serializeNode(graph, nodes, rootId, new Set<string>()));
  return childrenWithShape(serialized, graph.rootShape);
}

/** Replace only `operation_node` on a detached OperationMsg snapshot. */
export function graphToOperation(graph: OperationGraph, baseOperation?: OperationMsg): OperationMsg {
  const source = baseOperation ?? graph.operationSnapshot;
  if (!source) throw new Error('graphToOperation requires an OperationMsg or a graph built from one.');
  const operation = clone(source);
  operation.operation_node = graphToOperationNodes(graph);
  return operation;
}

/** Find an authored node without exposing the graph's internal storage. */
export function findOperationGraphNode(graph: OperationGraph, nodeId: string): OperationGraphNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

/** Return the ordered children of one node according to its graph edges. */
export function operationGraphChildren(graph: OperationGraph, nodeId: string): readonly string[] {
  return incomingEdges(graph, nodeId).map((edge) => edge.source);
}

/** Utility for clients creating a new authored node from a raw message. */
export function operationGraphNodeKind(raw: OperationNodeMsg): OperationGraphNodeKind {
  return stageKindOf(raw).kind;
}

/** Keep this helper public for graph mutation code that must preserve Many shapes. */
export function operationGraphChildrenShape(value: Many<OperationNodeMsg>): ManyShape {
  return manyShape(value);
}

/** The stage value for a known operation kind, useful to focused inspectors. */
export function operationGraphStageValue(raw: OperationNodeMsg, kind: OperationStageKind): OperationStageValue | undefined {
  return stageValue(raw.stage, kind);
}

/** Build a path with a numeric child index without mutating an existing path. */
export function operationGraphChildPath(parent: OperationGraphPath, index: number): OperationGraphPath {
  const next: GraphPathSegment[] = [...parent, 'operation_node', index];
  return next;
}
