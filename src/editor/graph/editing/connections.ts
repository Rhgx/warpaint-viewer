import type { OperationGraph, OperationGraphEdge } from '../types';
import { canConnectOperationPorts } from '../validation';
import { CONTAINER_KINDS, findOperationGraphNode } from '../operationGraph';
import {
  diagnosticResult,
  editFailure,
  editSuccess,
  incomingEdges,
  isVariadicTarget,
  mutableGraph,
  portAt,
  uniqueEdgeId,
  type MutableGraph,
  type OperationGraphEditDiagnostic,
  type OperationGraphEditResult,
} from './core';

export interface ConnectedOperationGraphEdge {
  readonly edgeId: string;
}

export type OperationGraphInputOrder = readonly (string | number)[];

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
  const source = findOperationGraphNode(graph, sourceId);
  const target = findOperationGraphNode(graph, targetId);
  if (!source) return { code: 'missing-node', severity: 'error', message: `Source node ${sourceId} does not exist.`, nodeId: sourceId };
  if (!target) return { code: 'missing-node', severity: 'error', message: `Target node ${targetId} does not exist.`, nodeId: targetId };
  if (source.kind === 'output') return { code: 'invalid-source', severity: 'error', message: 'The synthetic output cannot be used as a connection source.', nodeId: sourceId };
  if (source.outputType === 'none') return { code: 'invalid-source', severity: 'error', message: `${source.label} has no output port.`, nodeId: sourceId };
  if (target.kind !== 'output' && !CONTAINER_KINDS.has(target.kind)) {
    return { code: 'invalid-target', severity: 'error', message: `${target.label} does not accept graph inputs.`, nodeId: targetId };
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
  const source = findOperationGraphNode(graph, sourceId);
  const target = findOperationGraphNode(graph, targetId);
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
  const target = findOperationGraphNode(graph, targetId);
  if (!target) return editFailure(graph, 'missing-node', `Target node ${targetId} does not exist.`, targetId);
  if (!isVariadicTarget(target)) {
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
