import type { OperationGraph, OperationGraphEdge, OperationGraphNode } from '../types';
import { validateOperationGraph } from '../validation';
import { clone, findOperationGraphNode } from '../operationGraph';
import {
  diagnosticResult,
  editFailure,
  editSuccess,
  immutableGraph,
  incomingEdges,
  isVariadicTarget,
  mutableGraph,
  portAt,
  uniqueEdgeId,
  uniqueId,
  type MutableGraph,
  type OperationGraphEditDiagnostic,
  type OperationGraphEditResult,
} from './core';

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

function outgoingEdges(graph: OperationGraph, source: string): readonly OperationGraphEdge[] {
  return graph.edges
    .filter((candidate) => candidate.source === source)
    .sort((left, right) => left.inputIndex - right.inputIndex || left.id.localeCompare(right.id));
}

function validationDiagnostics(graph: OperationGraph): readonly OperationGraphEditDiagnostic[] {
  return validateOperationGraph(graph).diagnostics;
}

/** Duplicate a node and every incoming descendant as a detached, independently editable subtree. */
export function duplicateOperationGraphSubtree(
  graph: OperationGraph,
  nodeId: string,
): OperationGraphEditResult<DuplicatedOperationGraphSubtree> {
  const root = findOperationGraphNode(graph, nodeId);
  if (!root) return editFailure(graph, 'missing-node', `Node ${nodeId} does not exist.`, nodeId);
  if (root.kind === 'output') return editFailure(graph, 'cannot-duplicate', 'The synthetic output cannot be duplicated.', nodeId);
  const mutable = mutableGraph(graph);
  const usedIds = new Set(mutable.nodes.map((node) => node.id));
  const createdIds: string[] = [];
  const active = new Set<string>();
  const duplicateNode = (originalId: string): string | OperationGraphEditDiagnostic => {
    const original = findOperationGraphNode(graph, originalId);
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
    const id = uniqueId(usedIds, original.kind, original.id);
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
        type: findOperationGraphNode(graph, childEdge.source)?.outputType ?? childEdge.type,
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
  const root = findOperationGraphNode(graph, nodeId);
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
    const current = findOperationGraphNode(graph, currentId);
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
    const parent = findOperationGraphNode(graph, parentEdge.target);
    if (!parent) return editFailure(graph, 'missing-node', `Parent node ${parentEdge.target} does not exist.`, parentEdge.target);
    if (!isVariadicTarget(parent)) {
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
