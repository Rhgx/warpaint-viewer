import {
  type OperationGraphDiagnosticCode,
  type OperationGraph,
  type OperationGraphEdge,
  type OperationGraphNode,
  type OperationGraphNodeKind,
  type OperationGraphPort,
  type OperationGraphPath,
} from '../types';
import {
  clone,
  edgeId,
  findOperationGraphNode,
  inputPortsFor as portsFor,
  operationGraphPort as port,
} from '../operationGraph';

/** Additional diagnostics emitted by a structural graph edit. */
type OperationGraphEditDiagnosticCode =
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

interface OperationGraphEditSuccess<T> {
  readonly ok: true;
  readonly graph: OperationGraph;
  readonly value: T;
  readonly diagnostics: readonly OperationGraphEditDiagnostic[];
}

interface OperationGraphEditFailure {
  readonly ok: false;
  /** The original graph is returned so a refused edit can be handled without a rollback. */
  readonly graph: OperationGraph;
  readonly diagnostics: readonly OperationGraphEditDiagnostic[];
}

export type OperationGraphEditResult<T> = OperationGraphEditSuccess<T> | OperationGraphEditFailure;

const VARIADIC_KINDS: ReadonlySet<OperationGraphNodeKind> = new Set<OperationGraphNodeKind>([
  'combine_add',
  'combine_multiply',
]);

export function incomingEdges(graph: OperationGraph, target: string): readonly OperationGraphEdge[] {
  return graph.edges
    .filter((candidate) => candidate.target === target)
    .sort((left, right) => left.inputIndex - right.inputIndex || left.id.localeCompare(right.id));
}

export interface MutableGraph {
  nodes: OperationGraphNode[];
  edges: OperationGraphEdge[];
  roots: string[];
  outputId: string;
  rootShape: OperationGraph['rootShape'];
  operationSnapshot?: OperationGraph['operationSnapshot'];
}

export function mutableGraph(graph: OperationGraph): MutableGraph {
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

export function immutableGraph(graph: MutableGraph): OperationGraph {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const outputEdges = graph.edges
    .filter((edge) => edge.target === graph.outputId)
    .sort((left, right) => left.inputIndex - right.inputIndex || left.id.localeCompare(right.id));
  const roots = outputEdges.map((edge) => edge.source).filter((nodeId) => nodeIds.has(nodeId));
  const nodes = graph.nodes.map((node) => {
    const children = incomingEdges(graph, node.id).map((edge) => edge.source);
    const childCount = node.id === graph.outputId
      ? roots.length
      : children.length;
    return {
      ...node,
      children: node.id === graph.outputId ? roots : children,
      ...(isVariadicTarget(node) ? { inputPorts: portsFor(node.kind, childCount) } : {}),
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

export function editFailure<T>(
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
      ...(nodeId ? { path: findOperationGraphNode(graph, nodeId)?.sourcePath } : {}),
    }],
  };
}

export function editSuccess<T>(
  graph: MutableGraph,
  value: T,
  diagnostics: readonly OperationGraphEditDiagnostic[] = [],
): OperationGraphEditSuccess<T> {
  return { ok: true, graph: immutableGraph(graph), value, diagnostics };
}

export function uniqueId(existing: ReadonlySet<string>, kind: string, sourceId?: string): string {
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

export function uniqueEdgeId(existing: ReadonlySet<string>, source: string, target: string, inputIndex: number): string {
  const base = edgeId(source, target, inputIndex);
  let candidate = base;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base}:${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export function isVariadicTarget(node: OperationGraphNode): boolean {
  return node.kind === 'output' || VARIADIC_KINDS.has(node.kind);
}

export function portAt(node: OperationGraphNode, index: number): OperationGraphPort | undefined {
  if (index < 0 || !Number.isInteger(index)) return undefined;
  const existing = node.inputPorts[index];
  if (existing) return existing;
  if (!isVariadicTarget(node)) return undefined;
  if (node.kind === 'output') return port(`input-${index}`, `Result ${index + 1}`, index, 'unknown', true, true);
  return port(`input-${index}`, `Input ${index + 1}`, index, 'texture', index < 2, true);
}

export function diagnosticResult<T>(graph: OperationGraph, diagnostic: OperationGraphEditDiagnostic): OperationGraphEditResult<T> {
  return { ok: false, graph, diagnostics: [diagnostic] };
}
