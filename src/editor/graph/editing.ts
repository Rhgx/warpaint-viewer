import {
  many,
  type OperationNodeMsg,
  type OperationStageMsg,
  type VarDefMsg,
  type VarFieldMsg,
} from '../../protodefs/messages';
import {
  type OperationGraphDiagnosticCode,
  type OperationGraph,
  type OperationGraphEdge,
  type OperationGraphNode,
  type OperationGraphPort,
  type OperationGraphPath,
  type OperationPortType,
  type OperationStageKind,
} from './types';
import { canConnectOperationPorts, validateOperationGraph } from './validation';
import { operationGraphNodeKind as rawOperationGraphNodeKind } from './operationGraph';

/** Additional diagnostics emitted by a structural graph edit. */
export type OperationGraphEditDiagnosticCode =
  | OperationGraphDiagnosticCode
  | 'missing-edge'
  | 'locked-node'
  | 'invalid-source'
  | 'invalid-target'
  | 'occupied-input'
  | 'incompatible-port'
  | 'invalid-order'
  | 'unsupported-kind'
  | 'cannot-delete'
  | 'cannot-duplicate'
  | 'invalid-parameter'
  | 'unresolved-variable'
  | 'ambiguous-variable';

export interface OperationGraphEditDiagnostic {
  readonly code: OperationGraphEditDiagnosticCode;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly path?: OperationGraphPath;
}

export interface OperationGraphEditSuccess<T> {
  readonly ok: true;
  readonly graph: OperationGraph;
  readonly value: T;
  readonly diagnostics: readonly OperationGraphEditDiagnostic[];
}

export interface OperationGraphEditFailure {
  readonly ok: false;
  /** The original graph is returned so a refused edit can be handled without a rollback. */
  readonly graph: OperationGraph;
  readonly diagnostics: readonly OperationGraphEditDiagnostic[];
}

export type OperationGraphEditResult<T> = OperationGraphEditSuccess<T> | OperationGraphEditFailure;

export interface CreateOperationGraphNodeOptions {
  /** Override the generated ID when a caller already has a stable UI ID. */
  readonly nodeId?: string;
  /** Optional authored data to use as the node's raw message. */
  readonly raw?: OperationNodeMsg;
}

export interface CreatedOperationGraphNode {
  readonly nodeId: string;
}

export interface ConnectedOperationGraphEdge {
  readonly edgeId: string;
}

export interface DuplicatedOperationGraphSubtree {
  readonly rootId: string;
  readonly nodeIds: readonly string[];
}

export interface DeletedOperationGraphSubtree {
  readonly deletedNodeIds: readonly string[];
}

export interface DeleteOperationGraphSubtreeOptions {
  /** Permit a deliberately incomplete graph. This is useful for editors with a staged repair flow. */
  readonly allowInvalid?: boolean;
}

export type OperationGraphInputOrder = readonly (string | number)[];

/** Scalar fields exposed by operation stages. Nested operation_node fields are intentionally excluded. */
export type OperationGraphParameterField =
  | 'texture'
  | 'texture_red'
  | 'texture_blue'
  | 'adjust_black'
  | 'adjust_offset'
  | 'adjust_gamma'
  | 'rotation'
  | 'translate_u'
  | 'translate_v'
  | 'scale_uv'
  | 'flip_u'
  | 'flip_v'
  | 'groups'
  | 'select'
  | 'dest_tl'
  | 'dest_tr'
  | 'dest_bl';

export interface OperationGraphParameterAddress {
  readonly field: OperationGraphParameterField;
  /** Required for a select field because it is a repeated Many<VarFieldMsg>. */
  readonly index?: number;
}

export type OperationGraphParameterValue =
  | {
    readonly mode: 'literal';
    readonly value: string | number | boolean;
    /** Defaults to true: variable-backed fields update their declaration and keep the reference. */
    readonly preserveVariable?: boolean;
  }
  | {
    readonly mode: 'variable';
    readonly name: string;
  };

export interface SetOperationGraphParameterRequest {
  readonly nodeId: string;
  readonly address: OperationGraphParameterAddress;
  readonly value: OperationGraphParameterValue;
}

export interface SetOperationGraphParameterResult {
  readonly nodeId: string;
  readonly field: OperationGraphParameterField;
  /** The variable updated or assigned, if the field remains variable-backed. */
  readonly variableName?: string;
}

const CONTAINER_KINDS = new Set<OperationStageKind>([
  'combine_add',
  'combine_multiply',
  'combine_lerp',
  'apply_sticker',
]);

const VARIADIC_KINDS = new Set<OperationStageKind>([
  'combine_add',
  'combine_multiply',
]);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function outputTypeFor(kind: OperationStageKind): OperationPortType {
  return kind === 'select' ? 'mask' : 'texture';
}

function labelFor(kind: OperationStageKind): string {
  switch (kind) {
    case 'texture_lookup': return 'Texture lookup';
    case 'select': return 'Select groups';
    case 'combine_add': return 'Add textures';
    case 'combine_multiply': return 'Multiply textures';
    case 'combine_lerp': return 'Blend textures';
    case 'apply_sticker': return 'Apply sticker';
  }
}

function port(
  id: string,
  label: string,
  index: number,
  type: OperationPortType,
  required = true,
  variadic = false,
): OperationGraphPort {
  return { id, label, index, type, required, ...(variadic ? { variadic: true } : {}) };
}

function portsFor(kind: OperationGraphNode['kind'], childCount: number): readonly OperationGraphPort[] {
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

function defaultRaw(kind: OperationStageKind): OperationNodeMsg {
  const stage: OperationStageMsg = {};
  switch (kind) {
    case 'texture_lookup': stage.texture_lookup = {}; break;
    case 'select': stage.select = {}; break;
    case 'combine_add': stage.combine_add = { operation_node: [] }; break;
    case 'combine_multiply': stage.combine_multiply = { operation_node: [] }; break;
    case 'combine_lerp': stage.combine_lerp = { operation_node: [] }; break;
    case 'apply_sticker': stage.apply_sticker = { operation_node: [] }; break;
  }
  return { stage };
}

function edgeId(source: string, target: string, inputIndex: number): string {
  return `operation-edge:${source}->${target}:${inputIndex}`;
}

function incomingEdges(graph: OperationGraph, target: string): readonly OperationGraphEdge[] {
  return graph.edges
    .filter((candidate) => candidate.target === target)
    .sort((left, right) => left.inputIndex - right.inputIndex || left.id.localeCompare(right.id));
}

function outgoingEdges(graph: OperationGraph, source: string): readonly OperationGraphEdge[] {
  return graph.edges
    .filter((candidate) => candidate.source === source)
    .sort((left, right) => left.inputIndex - right.inputIndex || left.id.localeCompare(right.id));
}

function nodeById(graph: OperationGraph, nodeId: string): OperationGraphNode | undefined {
  return graph.nodes.find((node) => node.id === nodeId);
}

interface MutableGraph {
  nodes: OperationGraphNode[];
  edges: OperationGraphEdge[];
  roots: string[];
  outputId: string;
  rootShape: OperationGraph['rootShape'];
  operationSnapshot?: OperationGraph['operationSnapshot'];
}

function mutableGraph(graph: OperationGraph): MutableGraph {
  return {
    nodes: graph.nodes.map((node) => ({
      ...node,
      ...(node.raw ? { raw: clone(node.raw) } : {}),
      sourcePath: [...node.sourcePath],
      inputPorts: node.inputPorts.map((input) => ({ ...input })),
      children: [...node.children],
      ...(node.lockedSnapshot ? { lockedSnapshot: clone(node.lockedSnapshot) } : {}),
    })),
    edges: graph.edges.map((edge) => ({ ...edge })),
    roots: [...graph.roots],
    outputId: graph.outputId,
    rootShape: graph.rootShape,
    ...(graph.operationSnapshot ? { operationSnapshot: clone(graph.operationSnapshot) } : {}),
  };
}

function immutableGraph(graph: MutableGraph): OperationGraph {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const outputEdges = graph.edges
    .filter((edge) => edge.target === graph.outputId)
    .sort((left, right) => left.inputIndex - right.inputIndex || left.id.localeCompare(right.id));
  const roots = outputEdges.map((edge) => edge.source).filter((nodeId) => nodeIds.has(nodeId));
  const nodes = graph.nodes.map((node) => {
    const children = incomingEdges({ ...graph, nodes: graph.nodes, edges: graph.edges } as OperationGraph, node.id)
      .filter((edge) => edge.target !== graph.outputId)
      .map((edge) => edge.source);
    const childCount = node.id === graph.outputId
      ? roots.length
      : children.length;
    const dynamicPorts = node.kind === 'output' || VARIADIC_KINDS.has(node.kind as OperationStageKind);
    return {
      ...node,
      children: node.id === graph.outputId ? roots : children,
      ...(dynamicPorts ? { inputPorts: portsFor(node.kind, childCount) } : {}),
    };
  });
  return {
    nodes,
    edges: graph.edges.map((edge) => ({ ...edge })),
    roots,
    outputId: graph.outputId,
    rootShape: graph.rootShape,
    ...(graph.operationSnapshot ? { operationSnapshot: clone(graph.operationSnapshot) } : {}),
  };
}

function editFailure<T>(
  graph: OperationGraph,
  code: OperationGraphEditDiagnosticCode,
  message: string,
  nodeId?: string,
  edgeIdValue?: string,
): OperationGraphEditResult<T> {
  return {
    ok: false,
    graph,
    diagnostics: [{
      code,
      severity: 'error',
      message,
      ...(nodeId ? { nodeId } : {}),
      ...(edgeIdValue ? { edgeId: edgeIdValue } : {}),
      ...(nodeId ? { path: nodeById(graph, nodeId)?.sourcePath } : {}),
    }],
  };
}

function editSuccess<T>(
  graph: MutableGraph,
  value: T,
  diagnostics: readonly OperationGraphEditDiagnostic[] = [],
): OperationGraphEditSuccess<T> {
  return { ok: true, graph: immutableGraph(graph), value, diagnostics };
}

function validationDiagnostics(graph: OperationGraph): readonly OperationGraphEditDiagnostic[] {
  return validateOperationGraph(graph).diagnostics.map((diagnostic) => ({
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.nodeId ? { nodeId: diagnostic.nodeId } : {}),
    ...(diagnostic.edgeId ? { edgeId: diagnostic.edgeId } : {}),
    ...(diagnostic.path ? { path: diagnostic.path } : {}),
  }));
}

function uniqueId(existing: ReadonlySet<string>, kind: string, sourceId?: string): string {
  const base = sourceId
    ? `operation-node:copy:${encodeURIComponent(sourceId)}`
    : `operation-node:generated:${kind}`;
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}:${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function uniqueEdgeId(existing: ReadonlySet<string>, source: string, target: string, inputIndex: number): string {
  const base = edgeId(source, target, inputIndex);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}:${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function addEdge(
  graph: MutableGraph,
  source: string,
  target: string,
  inputIndex: number,
): OperationGraphEdge {
  const sourceNode = graph.nodes.find((node) => node.id === source);
  const targetNode = graph.nodes.find((node) => node.id === target);
  const targetPort = targetNode ? portAt(targetNode, inputIndex) : undefined;
  const id = uniqueEdgeId(new Set(graph.edges.map((edge) => edge.id)), source, target, inputIndex);
  return {
    id,
    source,
    target,
    sourceHandle: 'output',
    targetHandle: targetPort?.id ?? `input-${inputIndex}`,
    inputIndex,
    type: sourceNode?.outputType ?? 'unknown',
  };
}

function isVariadicTarget(node: OperationGraphNode): boolean {
  return node.kind === 'output' || VARIADIC_KINDS.has(node.kind as OperationStageKind);
}

function portAt(node: OperationGraphNode, index: number): OperationGraphPort | undefined {
  if (index < 0 || !Number.isInteger(index)) return undefined;
  const existing = node.inputPorts[index];
  if (existing) return existing;
  if (!isVariadicTarget(node)) return undefined;
  if (node.kind === 'output') return port(`input-${index}`, `Result ${index + 1}`, index, 'unknown', true, true);
  return port(`input-${index}`, `Input ${index + 1}`, index, 'texture', index < 2, true);
}

function reaches(graph: OperationGraph, start: string, goal: string): boolean {
  const visited = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) continue;
    if (current === goal) return true;
    visited.add(current);
    for (const edge of graph.edges) {
      if (edge.source === current && edge.target !== graph.outputId) stack.push(edge.target);
    }
  }
  return false;
}

interface ConnectionGuardOptions {
  readonly ignoredEdgeId?: string;
}

function guardConnection(
  graph: OperationGraph,
  sourceId: string,
  targetId: string,
  inputIndex: number,
  options: ConnectionGuardOptions = {},
): OperationGraphEditDiagnostic | undefined {
  const source = nodeById(graph, sourceId);
  const target = nodeById(graph, targetId);
  if (!source) return { code: 'missing-node', severity: 'error', message: `Source node ${sourceId} does not exist.`, nodeId: sourceId };
  if (!target) return { code: 'missing-node', severity: 'error', message: `Target node ${targetId} does not exist.`, nodeId: targetId };
  if (source.kind === 'output') return { code: 'invalid-source', severity: 'error', message: 'The synthetic output cannot be used as a connection source.', nodeId: sourceId };
  if (source.outputType === 'none') return { code: 'invalid-source', severity: 'error', message: `${source.label} has no output port.`, nodeId: sourceId };
  if (target.kind !== 'output' && !CONTAINER_KINDS.has(target.kind as OperationStageKind)) {
    return { code: 'invalid-target', severity: 'error', message: `${target.label} does not accept graph inputs.`, nodeId: targetId };
  }
  if (target.kind !== 'output' && target.locked) {
    return { code: 'locked-node', severity: 'error', message: `${target.label} is locked and cannot receive graph inputs.`, nodeId: targetId };
  }
  if (!Number.isInteger(inputIndex) || inputIndex < 0) {
    return { code: 'invalid-input-index', severity: 'error', message: 'Connection input index must be a non-negative integer.', nodeId: targetId };
  }
  const targetPort = portAt(target, inputIndex);
  if (!targetPort) {
    return { code: 'invalid-input-index', severity: 'error', message: `Input ${inputIndex} does not exist on ${target.label}.`, nodeId: targetId };
  }
  const competing = graph.edges.find((edge) => (
    edge.target === targetId
    && edge.inputIndex === inputIndex
    && edge.id !== options.ignoredEdgeId
  ));
  if (competing) {
    return { code: 'occupied-input', severity: 'error', message: `${target.label} input ${inputIndex + 1} is already connected.`, nodeId: targetId, edgeId: competing.id };
  }
  const sourceParents = graph.edges.filter((edge) => edge.source === sourceId && edge.id !== options.ignoredEdgeId);
  if (sourceParents.length > 0) {
    return { code: 'multiple-parents', severity: 'error', message: `${source.label} already has a parent. Duplicate the subtree before reusing it.`, nodeId: sourceId, edgeId: sourceParents[0]?.id };
  }
  if (sourceId === targetId || reaches(graph, targetId, sourceId)) {
    return { code: 'cycle', severity: 'error', message: `Connecting ${source.label} to ${target.label} would create a cycle.`, nodeId: targetId };
  }
  if (target.kind === 'output' && source.outputType === 'mask') {
    return { code: 'invalid-root-type', severity: 'error', message: `${source.label} produces a mask and cannot be a final paint output.`, nodeId: sourceId };
  }
  if (!canConnectOperationPorts(source.outputType, targetPort.type)) {
    return { code: 'incompatible-port', severity: 'error', message: `${target.label} input ${inputIndex + 1} expects ${targetPort.type}, but ${source.label} produces ${source.outputType}.`, nodeId: targetId };
  }
  return undefined;
}

function advisoryForConnection(
  graph: OperationGraph,
  sourceId: string,
  targetId: string,
  inputIndex: number,
  edgeIdValue?: string,
): OperationGraphEditDiagnostic | undefined {
  const source = nodeById(graph, sourceId);
  const target = nodeById(graph, targetId);
  const targetPort = target ? portAt(target, inputIndex) : undefined;
  if (!source || !target || !targetPort) return undefined;
  const roleCrossing = (source.outputType === 'texture' && targetPort.type === 'mask')
    || (source.outputType === 'mask' && targetPort.type === 'texture');
  if (!roleCrossing) return undefined;
  return {
    code: 'invalid-port-type',
    severity: 'warning',
    message: `${target.label} input ${inputIndex + 1} crosses the advisory ${targetPort.type}/${source.outputType} role; both stages produce RGBA data.`,
    nodeId: targetId,
    ...(edgeIdValue ? { edgeId: edgeIdValue } : {}),
    path: target.sourcePath,
  };
}

function diagnosticResult<T>(graph: OperationGraph, diagnostic: OperationGraphEditDiagnostic): OperationGraphEditResult<T> {
  return { ok: false, graph, diagnostics: [diagnostic] };
}

function nodeFromKind(
  graph: MutableGraph,
  kind: OperationStageKind,
  options: CreateOperationGraphNodeOptions,
  sourceId?: string,
): OperationGraphNode | OperationGraphEditDiagnostic {
  const existingIds = new Set(graph.nodes.map((node) => node.id));
  const id = options.nodeId?.trim() || uniqueId(existingIds, kind, sourceId);
  if (existingIds.has(id)) {
    return { code: 'duplicate-node', severity: 'error', message: `Node ID ${id} is already in use.`, nodeId: id };
  }
  if (options.nodeId !== undefined && !options.nodeId.trim()) {
    return { code: 'invalid-target', severity: 'error', message: 'A supplied node ID must not be empty.' };
  }
  const raw = options.raw ? clone(options.raw) : defaultRaw(kind);
  if (rawOperationGraphNodeKind(raw) !== kind) {
    return { code: 'unsupported-kind', severity: 'error', message: `The supplied raw node is not a ${kind} operation.` };
  }
  const sourcePath: OperationGraphPath = ['graph', 'generated', kind, id];
  return {
    id,
    kind,
    label: labelFor(kind),
    raw,
    sourcePath,
    outputType: outputTypeFor(kind),
    inputPorts: portsFor(kind, 0),
    locked: false,
    children: [],
    ...(CONTAINER_KINDS.has(kind) ? { childrenShape: 'array' as const } : {}),
  };
}

/** Add one editable authored operation stage. The node starts detached until connected. */
export function createOperationGraphNode(
  graph: OperationGraph,
  kind: OperationStageKind,
  options: CreateOperationGraphNodeOptions = {},
): OperationGraphEditResult<CreatedOperationGraphNode> {
  const mutable = mutableGraph(graph);
  const node = nodeFromKind(mutable, kind, options);
  if ('code' in node) return diagnosticResult(graph, node);
  mutable.nodes.push(node);
  const next = immutableGraph(mutable);
  return { ok: true, graph: next, value: { nodeId: node.id }, diagnostics: [] };
}

/** Connect one authored output to a target input while enforcing graph invariants. */
export function connectOperationGraph(
  graph: OperationGraph,
  sourceId: string,
  targetId: string,
  inputIndex: number,
): OperationGraphEditResult<ConnectedOperationGraphEdge> {
  const diagnostic = guardConnection(graph, sourceId, targetId, inputIndex);
  if (diagnostic) return diagnosticResult(graph, diagnostic);
  const mutable = mutableGraph(graph);
  const edge = addEdge(mutable, sourceId, targetId, inputIndex);
  mutable.edges.push(edge);
  const advisory = advisoryForConnection(graph, sourceId, targetId, inputIndex, edge.id);
  return editSuccess(mutable, { edgeId: edge.id }, advisory ? [advisory] : []);
}

/** Move an existing connection to a new source, target, or input slot. */
export function reconnectOperationGraph(
  graph: OperationGraph,
  edgeIdValue: string,
  sourceId: string,
  targetId: string,
  inputIndex: number,
): OperationGraphEditResult<ConnectedOperationGraphEdge> {
  const edge = graph.edges.find((candidate) => candidate.id === edgeIdValue);
  if (!edge) return editFailure(graph, 'missing-edge', `Edge ${edgeIdValue} does not exist.`, undefined, edgeIdValue);
  const withoutEdge: OperationGraph = { ...graph, edges: graph.edges.filter((candidate) => candidate.id !== edgeIdValue) };
  const diagnostic = guardConnection(withoutEdge, sourceId, targetId, inputIndex, { ignoredEdgeId: edgeIdValue });
  if (diagnostic) return diagnosticResult(graph, diagnostic);
  const mutable = mutableGraph(withoutEdge);
  const nextEdge = addEdge(mutable, sourceId, targetId, inputIndex);
  mutable.edges.push(nextEdge);
  const advisory = advisoryForConnection(withoutEdge, sourceId, targetId, inputIndex, nextEdge.id);
  return editSuccess(mutable, { edgeId: nextEdge.id }, advisory ? [advisory] : []);
}

/** Remove one connection. The returned graph may be temporarily incomplete and can be validated by the caller. */
export function disconnectOperationGraph(
  graph: OperationGraph,
  edgeIdValue: string,
): OperationGraphEditResult<undefined> {
  if (!graph.edges.some((edge) => edge.id === edgeIdValue)) {
    return editFailure(graph, 'missing-edge', `Edge ${edgeIdValue} does not exist.`, undefined, edgeIdValue);
  }
  const mutable = mutableGraph(graph);
  mutable.edges = mutable.edges.filter((edge) => edge.id !== edgeIdValue);
  return editSuccess(mutable, undefined);
}

/** Reorder the ordered inputs of a variadic combine node, or the ordered paint roots. */
export function reorderOperationGraphInputs(
  graph: OperationGraph,
  targetId: string,
  order: OperationGraphInputOrder,
): OperationGraphEditResult<undefined> {
  const target = nodeById(graph, targetId);
  if (!target) return editFailure(graph, 'missing-node', `Target node ${targetId} does not exist.`, targetId);
  if (!(target.kind === 'output' || VARIADIC_KINDS.has(target.kind as OperationStageKind))) {
    return editFailure(graph, 'invalid-target', `${target.label} does not have ordered variadic inputs.`, targetId);
  }
  const current = incomingEdges(graph, targetId);
  if (order.length !== current.length) {
    return editFailure(graph, 'invalid-order', `Expected ${current.length} input IDs, received ${order.length}.`, targetId);
  }
  const byIndex = new Map(current.map((edge) => [edge.inputIndex, edge]));
  const bySource = new Map(current.map((edge) => [edge.source, edge]));
  const selected: OperationGraphEdge[] = [];
  for (const item of order) {
    const edge = typeof item === 'number' ? byIndex.get(item) : bySource.get(item);
    if (!edge || selected.some((candidate) => candidate.id === edge.id)) {
      return editFailure(graph, 'invalid-order', 'Input order must contain every existing input exactly once.', targetId);
    }
    selected.push(edge);
  }
  const mutable = mutableGraph(graph);
  const usedEdgeIds = new Set(mutable.edges.filter((edge) => edge.target !== targetId).map((edge) => edge.id));
  mutable.edges = mutable.edges.map((edge) => {
    if (edge.target !== targetId) return edge;
    const index = selected.findIndex((candidate) => candidate.id === edge.id);
    if (index < 0) return edge;
    const sourceNode = mutable.nodes.find((node) => node.id === edge.source);
    const nextId = uniqueEdgeId(usedEdgeIds, edge.source, targetId, index);
    usedEdgeIds.add(nextId);
    return {
      ...edge,
      id: nextId,
      targetHandle: portAt(target, index)?.id ?? `input-${index}`,
      inputIndex: index,
      type: sourceNode?.outputType ?? edge.type,
    };
  });
  return editSuccess(mutable, undefined);
}

/** Duplicate a node and every incoming descendant as a detached, independently editable subtree. */
export function duplicateOperationGraphSubtree(
  graph: OperationGraph,
  nodeId: string,
): OperationGraphEditResult<DuplicatedOperationGraphSubtree> {
  const root = nodeById(graph, nodeId);
  if (!root) return editFailure(graph, 'missing-node', `Node ${nodeId} does not exist.`, nodeId);
  if (root.kind === 'output') return editFailure(graph, 'cannot-duplicate', 'The synthetic output cannot be duplicated.', nodeId);
  const mutable = mutableGraph(graph);
  const usedIds = new Set(mutable.nodes.map((node) => node.id));
  const createdIds: string[] = [];
  const active = new Set<string>();
  const duplicateNode = (originalId: string): string | OperationGraphEditDiagnostic => {
    const original = nodeById(graph, originalId);
    if (!original || original.kind === 'output') {
      return { code: 'cannot-duplicate', severity: 'error', message: `Cannot duplicate missing or synthetic node ${originalId}.`, nodeId: originalId };
    }
    if (!original.raw) {
      return { code: 'cannot-duplicate', severity: 'error', message: `${original.label} has no raw operation message to duplicate.`, nodeId: originalId };
    }
    if (active.has(originalId)) {
      return { code: 'cycle', severity: 'error', message: `Cannot duplicate a cyclic subtree involving ${original.label}.`, nodeId: originalId };
    }
    active.add(originalId);
    const id = uniqueId(usedIds, original.kind === 'invalid' ? 'texture_lookup' : original.kind, original.id);
    usedIds.add(id);
    const copyNode: OperationGraphNode = {
      ...original,
      id,
      raw: clone(original.raw),
      sourcePath: [...original.sourcePath, 'duplicate', id],
      inputPorts: original.inputPorts.map((input) => ({ ...input })),
      children: [],
      ...(original.lockedSnapshot ? { lockedSnapshot: clone(original.lockedSnapshot) } : {}),
    };
    mutable.nodes.push(copyNode);
    createdIds.push(id);
    for (const childEdge of incomingEdges(graph, originalId)) {
      const childId = duplicateNode(childEdge.source);
      if (typeof childId !== 'string') return childId;
      mutable.edges.push({
        id: uniqueEdgeId(new Set(mutable.edges.map((edge) => edge.id)), childId, id, childEdge.inputIndex),
        source: childId,
        target: id,
        sourceHandle: 'output',
        targetHandle: `input-${childEdge.inputIndex}`,
        inputIndex: childEdge.inputIndex,
        type: nodeById(graph, childEdge.source)?.outputType ?? childEdge.type,
      });
    }
    active.delete(originalId);
    return id;
  };
  const duplicatedRoot = duplicateNode(nodeId);
  if (typeof duplicatedRoot !== 'string') return diagnosticResult(graph, duplicatedRoot);
  return editSuccess(mutable, { rootId: duplicatedRoot, nodeIds: createdIds });
}

function compactTargetEdges(mutable: MutableGraph, targetId: string): void {
  const target = mutable.nodes.find((node) => node.id === targetId);
  if (!target || !isVariadicTarget(target)) return;
  const targetEdges = mutable.edges
    .filter((edge) => edge.target === targetId)
    .sort((left, right) => left.inputIndex - right.inputIndex || left.id.localeCompare(right.id));
  const otherEdges = mutable.edges.filter((edge) => edge.target !== targetId);
  const usedIds = new Set(otherEdges.map((edge) => edge.id));
  const compacted = targetEdges.map((edge, index) => {
    const sourceNode = mutable.nodes.find((node) => node.id === edge.source);
    const id = uniqueEdgeId(usedIds, edge.source, edge.target, index);
    usedIds.add(id);
    return {
      ...edge,
      id,
      targetHandle: portAt(target, index)?.id ?? `input-${index}`,
      inputIndex: index,
      type: sourceNode?.outputType ?? edge.type,
    };
  });
  mutable.edges = [...otherEdges, ...compacted];
}

/** Delete a node's entire incoming subtree, repairing variadic ordering when the result remains valid. */
export function deleteOperationGraphSubtree(
  graph: OperationGraph,
  nodeId: string,
  options: DeleteOperationGraphSubtreeOptions = {},
): OperationGraphEditResult<DeletedOperationGraphSubtree> {
  const root = nodeById(graph, nodeId);
  if (!root) return editFailure(graph, 'missing-node', `Node ${nodeId} does not exist.`, nodeId);
  if (root.kind === 'output') return editFailure(graph, 'locked-node', 'The synthetic output cannot be deleted.', nodeId);
  const rootParents = outgoingEdges(graph, nodeId);
  if (rootParents.length > 1) {
    return editFailure(graph, 'multiple-parents', `${root.label} has multiple parents; repair the graph before deleting its subtree.`, nodeId);
  }

  const deleted = new Set<string>();
  const active = new Set<string>();
  const collect = (currentId: string): OperationGraphEditDiagnostic | undefined => {
    if (active.has(currentId)) return { code: 'cycle', severity: 'error', message: `Cannot delete a cyclic subtree involving ${currentId}.`, nodeId: currentId };
    if (deleted.has(currentId)) return undefined;
    const current = nodeById(graph, currentId);
    if (!current || current.kind === 'output') return { code: 'cannot-delete', severity: 'error', message: `Cannot delete missing or synthetic node ${currentId}.`, nodeId: currentId };
    active.add(currentId);
    deleted.add(currentId);
    for (const edge of incomingEdges(graph, currentId)) {
      const diagnostic = collect(edge.source);
      if (diagnostic) return diagnostic;
    }
    active.delete(currentId);
    return undefined;
  };
  const collectionDiagnostic = collect(nodeId);
  if (collectionDiagnostic) return diagnosticResult(graph, collectionDiagnostic);

  const externalEdges = graph.edges.filter((edge) => (
    deleted.has(edge.source) && !deleted.has(edge.target)
  ));
  const externalParentEdges = externalEdges.filter((edge) => edge.source === nodeId);
  for (const edge of externalEdges) {
    if (!externalParentEdges.some((parentEdge) => parentEdge.id === edge.id)) {
      return editFailure(graph, 'cannot-delete', 'The selected subtree contains a shared descendant and cannot be deleted safely.', nodeId, edge.id);
    }
  }
  const parentEdge = externalParentEdges[0];
  if (parentEdge) {
    const parent = nodeById(graph, parentEdge.target);
    if (!parent) return editFailure(graph, 'missing-node', `Parent node ${parentEdge.target} does not exist.`, parentEdge.target);
    if (!(parent.kind === 'output' || VARIADIC_KINDS.has(parent.kind as OperationStageKind))) {
      return editFailure(graph, 'cannot-delete', `${parent.label} requires this fixed input; delete the parent subtree instead.`, parent.id, parentEdge.id);
    }
    const remaining = incomingEdges(graph, parent.id).filter((edge) => !deleted.has(edge.source));
    const minimum = parent.kind === 'output' ? 1 : 2;
    if (remaining.length < minimum) {
      return editFailure(graph, 'invalid-arity', `Deleting ${root.label} would leave ${parent.label} with too few inputs.`, parent.id, parentEdge.id);
    }
  }

  const mutable = mutableGraph(graph);
  mutable.nodes = mutable.nodes.filter((node) => !deleted.has(node.id));
  mutable.edges = mutable.edges.filter((edge) => !deleted.has(edge.source) && !deleted.has(edge.target));
  if (parentEdge) compactTargetEdges(mutable, parentEdge.target);
  const next = immutableGraph(mutable);
  const wasValid = validateOperationGraph(graph).valid;
  const nextValidation = validateOperationGraph(next);
  if (!options.allowInvalid && wasValid && !nextValidation.valid) {
    return {
      ok: false,
      graph,
      diagnostics: validationDiagnostics(next),
    };
  }
  return {
    ok: true,
    graph: next,
    value: { deletedNodeIds: [...deleted] },
    diagnostics: options.allowInvalid ? validationDiagnostics(next) : [],
  };
}

const VAR_FIELD_KEYS = ['string', 'bool', 'float', 'double', 'uint32', 'uint64', 'sint32', 'sint64'] as const;
export type OperationGraphVarFieldScalarKey = typeof VAR_FIELD_KEYS[number];

export function operationGraphVarFieldScalarKey(
  field: VarFieldMsg | undefined,
): OperationGraphVarFieldScalarKey | undefined {
  if (!field) return undefined;
  return VAR_FIELD_KEYS.find((key) => field[key] !== undefined);
}

interface ParameterLocation {
  readonly field?: VarFieldMsg;
  readonly write: (field: VarFieldMsg) => void;
}

function asRecord(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parameterLocation(
  node: OperationGraphNode,
  raw: OperationNodeMsg,
  address: OperationGraphParameterAddress,
): ParameterLocation | OperationGraphEditDiagnostic {
  const kind = rawOperationGraphNodeKind(raw);
  if (kind !== node.kind) {
    return { code: 'invalid-stage', severity: 'error', message: `${node.label} no longer contains its authored stage.`, nodeId: node.id, path: node.sourcePath };
  }
  const field = address.field;
  const isSelectArray = kind === 'select' && field === 'select';
  if (isSelectArray) {
    if (!Number.isInteger(address.index) || (address.index ?? -1) < 0) {
      return { code: 'invalid-parameter', severity: 'error', message: 'A select parameter requires a non-negative integer index.', nodeId: node.id, path: node.sourcePath };
    }
    const stage = raw.stage?.select;
    if (!stage) return { code: 'invalid-stage', severity: 'error', message: `${node.label} has no select stage.`, nodeId: node.id, path: node.sourcePath };
    const prior = stage.select;
    const fields = many(prior);
    const index = address.index as number;
    if (index >= fields.length && !(prior === undefined && index === 0)) {
      return { code: 'invalid-parameter', severity: 'error', message: `Select parameter index ${index} does not exist.`, nodeId: node.id, path: node.sourcePath };
    }
    const existing = fields[index];
    if (existing !== undefined && !isObject(existing)) {
      return { code: 'invalid-parameter', severity: 'error', message: `Select parameter ${index} is not a variable field.`, nodeId: node.id, path: node.sourcePath };
    }
    return {
      field: existing,
      write: (next) => {
        if (Array.isArray(prior)) {
          const replacement = prior.map((entry, entryIndex) => entryIndex === index ? next : entry);
          stage.select = replacement;
        } else {
          // Undefined and singleton Many fields both become a singleton when
          // the first select slot is authored, preserving compact proto shape.
          stage.select = next;
        }
      },
    };
  }
  if (address.index !== undefined) {
    return { code: 'invalid-parameter', severity: 'error', message: `${field} is not an indexed parameter.`, nodeId: node.id, path: node.sourcePath };
  }

  let owner: object | undefined;
  let allowed = false;
  switch (kind) {
    case 'texture_lookup':
      owner = raw.stage?.texture_lookup;
      allowed = ['texture', 'texture_red', 'texture_blue', 'adjust_black', 'adjust_offset', 'adjust_gamma', 'rotation', 'translate_u', 'translate_v', 'scale_uv', 'flip_u', 'flip_v'].includes(field);
      break;
    case 'combine_add':
    case 'combine_multiply':
    case 'combine_lerp':
      owner = raw.stage?.[kind];
      allowed = ['adjust_black', 'adjust_offset', 'adjust_gamma', 'rotation', 'translate_u', 'translate_v', 'scale_uv', 'flip_u', 'flip_v'].includes(field);
      break;
    case 'select':
      owner = raw.stage?.select;
      allowed = field === 'groups';
      break;
    case 'apply_sticker':
      owner = raw.stage?.apply_sticker;
      allowed = ['dest_tl', 'dest_tr', 'dest_bl', 'adjust_black', 'adjust_offset', 'adjust_gamma'].includes(field);
      break;
    default:
      return { code: 'invalid-parameter', severity: 'error', message: `${field} is not editable on ${node.label}.`, nodeId: node.id, path: node.sourcePath };
  }
  if (!allowed) {
    return { code: 'invalid-parameter', severity: 'error', message: `${field} is not editable on ${node.label}.`, nodeId: node.id, path: node.sourcePath };
  }
  if (!owner) return { code: 'invalid-stage', severity: 'error', message: `${node.label} has no authored stage.`, nodeId: node.id, path: node.sourcePath };
  const record = asRecord(owner);
  const existingValue = record[field];
  if (existingValue !== undefined && !isObject(existingValue)) {
    return { code: 'invalid-parameter', severity: 'error', message: `${field} is not a variable field.`, nodeId: node.id, path: node.sourcePath };
  }
  return {
    field: existingValue as VarFieldMsg | undefined,
    write: (next) => { record[field] = next; },
  };
}

function formatParameterValue(value: string | number | boolean): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Operation parameter numbers must be finite.');
    return String(Math.round(value * 1e6) / 1e6);
  }
  return String(value);
}

function literalParameterField(
  existing: VarFieldMsg | undefined,
  value: string | number | boolean,
  preserveVariable: boolean,
): VarFieldMsg {
  const next = existing ? clone(existing) : {};
  const record = asRecord(next);
  const priorScalar = operationGraphVarFieldScalarKey(existing);
  for (const key of VAR_FIELD_KEYS) delete record[key];
  if (!preserveVariable) delete record.variable;
  const key = priorScalar ?? (typeof value === 'number' ? 'float' : typeof value === 'boolean' ? 'bool' : 'string');
  switch (key) {
    case 'float':
    case 'double':
    case 'uint32':
    case 'uint64':
    case 'sint32':
    case 'sint64': {
      const numeric = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(numeric)) throw new TypeError(`Operation parameter ${key} requires a finite number.`);
      record[key] = numeric;
      break;
    }
    case 'bool':
      record.bool = typeof value === 'boolean' ? value : value === 'true' || value === '1';
      break;
    case 'string':
      record.string = formatParameterValue(value);
      break;
  }
  return next;
}

function operationVariableMatches(
  graph: MutableGraph,
  name: string,
): { variables: readonly VarDefMsg[]; index: number } | OperationGraphEditDiagnostic {
  const all = graph.operationSnapshot ? many(graph.operationSnapshot.header.variables) : [];
  const matches = all.flatMap((variable, index) => variable.name === name ? [{ variable, index }] : []);
  if (matches.length === 0) return { code: 'unresolved-variable', severity: 'error', message: `Variable “${name}” is not declared in the operation snapshot.` };
  if (matches.length > 1) return { code: 'ambiguous-variable', severity: 'error', message: `Variable “${name}” is declared more than once in the operation header.` };
  return { variables: all, index: matches[0]?.index ?? 0 };
}

function writeOperationVariable(graph: MutableGraph, name: string, value: string): OperationGraphEditDiagnostic | undefined {
  const match = operationVariableMatches(graph, name);
  if ('code' in match) return match;
  const snapshot = graph.operationSnapshot;
  if (!snapshot) return { code: 'unresolved-variable', severity: 'error', message: `Variable “${name}” has no editable operation snapshot.` };
  const prior = snapshot.header.variables;
  const replacement = match.variables.map((variable, index) => index === match.index ? { ...variable, value } : variable);
  snapshot.header.variables = Array.isArray(prior) ? replacement : replacement[0];
  return undefined;
}

/** Set one authored scalar stage parameter while preserving unknown fields and variable semantics. */
export function setOperationGraphParameter(
  graph: OperationGraph,
  request: SetOperationGraphParameterRequest,
): OperationGraphEditResult<SetOperationGraphParameterResult> {
  const node = nodeById(graph, request.nodeId);
  if (!node) return editFailure(graph, 'missing-node', `Node ${request.nodeId} does not exist.`, request.nodeId);
  if (node.kind === 'output' || node.locked) return editFailure(graph, 'locked-node', `${node.label} is locked and cannot be edited in place.`, node.id);
  if (!node.raw) return editFailure(graph, 'invalid-stage', `${node.label} has no raw operation message.`, node.id);
  const mutable = mutableGraph(graph);
  const mutableNode = mutable.nodes.find((candidate) => candidate.id === node.id);
  if (!mutableNode?.raw) return editFailure(graph, 'invalid-stage', `${node.label} has no mutable raw operation message.`, node.id);
  const raw = mutableNode.raw;
  const location = parameterLocation(node, raw, request.address);
  if ('code' in location) return diagnosticResult(graph, location);

  if (request.value.mode === 'literal' && location.field?.variable && request.value.preserveVariable !== false) {
    const diagnostic = writeOperationVariable(mutable, location.field.variable, formatParameterValue(request.value.value));
    if (diagnostic) return diagnosticResult(graph, { ...diagnostic, nodeId: node.id, path: node.sourcePath });
    return editSuccess(mutable, { nodeId: node.id, field: request.address.field, variableName: location.field.variable });
  }

  let nextField: VarFieldMsg;
  if (request.value.mode === 'literal') {
    nextField = literalParameterField(location.field, request.value.value, request.value.preserveVariable === true);
  } else {
    const name = request.value.name.trim();
    if (!name) return editFailure(graph, 'invalid-parameter', 'A variable-backed parameter requires a non-empty variable name.', node.id);
    nextField = {
      ...(location.field ? clone(location.field) : {}),
      variable: name,
    };
  }
  location.write(nextField);
  return editSuccess(mutable, {
    nodeId: node.id,
    field: request.address.field,
    ...(nextField.variable ? { variableName: nextField.variable } : {}),
  });
}
