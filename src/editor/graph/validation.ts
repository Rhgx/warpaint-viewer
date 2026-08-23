import type {
  OperationGraph,
  OperationGraphDiagnostic,
  OperationGraphDiagnosticSeverity,
  OperationGraphEdge,
  OperationGraphNode,
  OperationGraphNodeKind,
  OperationGraphValidation,
  OperationPortType,
  OperationStageKind,
} from './types';

const STAGE_KINDS: readonly OperationStageKind[] = [
  'texture_lookup',
  'select',
  'combine_add',
  'combine_multiply',
  'combine_lerp',
  'apply_sticker',
];

function add(
  diagnostics: OperationGraphDiagnostic[],
  code: OperationGraphDiagnostic['code'],
  message: string,
  node?: OperationGraphNode,
  edge?: OperationGraphEdge,
  severity: OperationGraphDiagnostic['severity'] = 'error',
): void {
  diagnostics.push({
    code,
    severity,
    message,
    ...(node ? { nodeId: node.id, path: node.sourcePath } : {}),
    ...(edge ? { edgeId: edge.id } : {}),
  });
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left as Record<string, unknown>);
  const rightKeys = Object.keys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!deepEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
    )) return false;
  }
  return true;
}

function compatible(actual: OperationPortType, expected: OperationPortType): boolean {
  if (actual === 'unknown' || expected === 'unknown') return true;
  // TF2's operation stages all carry RGBA textures. Texture/mask labels are
  // useful editor guidance, but the shader intentionally permits either role
  // at every image input (notably Lerp's selector and sticker surfaces).
  return actual === expected || isRoleCrossing(actual, expected);
}

function isRoleCrossing(actual: OperationPortType, expected: OperationPortType): boolean {
  return (actual === 'texture' && expected === 'mask')
    || (actual === 'mask' && expected === 'texture');
}

function stageVariantCount(node: OperationGraphNode): number {
  if (!node.raw) return 0;
  let count = node.raw.operation_template !== undefined ? 1 : 0;
  if (node.raw.stage) {
    count += STAGE_KINDS.filter((kind) => node.raw?.stage?.[kind] !== undefined).length;
  }
  return count;
}

function stageKindLabel(kind: OperationGraphNodeKind): string {
  return kind === 'combine_add' ? 'combine-add'
    : kind === 'combine_multiply' ? 'combine-multiply'
      : kind === 'combine_lerp' ? 'combine-lerp'
        : kind === 'apply_sticker' ? 'apply-sticker'
          : kind;
}

function expectedPortType(node: OperationGraphNode, index: number): OperationPortType {
  if (node.kind === 'combine_lerp') return index === 2 ? 'mask' : 'texture';
  if (node.kind === 'output') return 'unknown';
  if (node.kind === 'apply_sticker' || node.kind === 'combine_add' || node.kind === 'combine_multiply') return 'texture';
  return 'none';
}

function hasContainer(kind: OperationGraphNodeKind): boolean {
  return kind === 'combine_add'
    || kind === 'combine_multiply'
    || kind === 'combine_lerp'
    || kind === 'apply_sticker';
}

/**
 * Validate the topology and authored-node invariants of a graph before it is
 * written back to proto-def messages. The graph is data-flow directed from a
 * child/source to its parent/target.
 */
/** Kept short because this lands in a single-line status strip. */
const MAX_SUMMARIZED_DIAGNOSTICS = 2;

/**
 * One readable line from a validation run.
 *
 * A graph carries advisory warnings while it composes perfectly well, and a
 * single disconnected stage draws the same complaint from more than one rule,
 * so reporting every message turns one small mistake into a wall of text.
 */
export function summarizeOperationGraphDiagnostics(
  diagnostics: readonly {
    readonly severity: OperationGraphDiagnosticSeverity;
    readonly message: string;
    readonly nodeId?: string;
  }[],
): string | null {
  // One complaint per node: a disconnected stage trips both the "no parent"
  // and the "unreachable" check, which say the same thing twice.
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== 'error') continue;
    const key = diagnostic.nodeId ?? diagnostic.message;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push(diagnostic.message);
  }
  if (errors.length === 0) return null;
  const shown = errors.slice(0, MAX_SUMMARIZED_DIAGNOSTICS);
  const remaining = errors.length - shown.length;
  return remaining > 0 ? `${shown.join(' ')} (${remaining} more)` : shown.join(' ');
}

export function validateOperationGraph(graph: OperationGraph): OperationGraphValidation {
  const diagnostics: OperationGraphDiagnostic[] = [];
  const byId = new Map<string, OperationGraphNode>();
  const duplicateIds = new Set<string>();
  for (const node of graph.nodes) {
    if (byId.has(node.id)) duplicateIds.add(node.id);
    else byId.set(node.id, node);
  }
  for (const id of duplicateIds) add(diagnostics, 'duplicate-node', `Graph contains duplicate node ID ${id}.`);

  const output = byId.get(graph.outputId);
  if (!output || output.kind !== 'output') {
    add(diagnostics, 'missing-node', `Synthetic output node ${graph.outputId} is missing.`);
  }

  const edgeIds = new Set<string>();
  const outgoing = new Map<string, OperationGraphEdge[]>();
  const incoming = new Map<string, OperationGraphEdge[]>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) add(diagnostics, 'duplicate-node', `Graph contains duplicate edge ID ${edge.id}.`, undefined, edge);
    edgeIds.add(edge.id);
    if (!byId.has(edge.source)) add(diagnostics, 'missing-node', `Edge ${edge.id} references missing source ${edge.source}.`, undefined, edge);
    if (!byId.has(edge.target)) add(diagnostics, 'missing-node', `Edge ${edge.id} references missing target ${edge.target}.`, undefined, edge);
    if (!Number.isInteger(edge.inputIndex) || edge.inputIndex < 0) {
      add(diagnostics, 'invalid-input-index', `Edge ${edge.id} has an invalid input index.`, undefined, edge);
    }
    const targetEdges = incoming.get(edge.target) ?? [];
    if (targetEdges.some((candidate) => candidate.inputIndex === edge.inputIndex)) {
      add(diagnostics, 'duplicate-input', `Node ${edge.target} has multiple connections for input ${edge.inputIndex}.`, undefined, edge);
    }
    targetEdges.push(edge);
    incoming.set(edge.target, targetEdges);
    const sourceEdges = outgoing.get(edge.source) ?? [];
    sourceEdges.push(edge);
    outgoing.set(edge.source, sourceEdges);

    const sourceNode = byId.get(edge.source);
    const targetNode = byId.get(edge.target);
    if (sourceNode?.kind === 'output') add(diagnostics, 'unexpected-inputs', 'The synthetic output node cannot be a connection source.', sourceNode, edge);
    if (targetNode && targetNode.kind !== 'output' && edge.inputIndex >= targetNode.inputPorts.length) {
      add(diagnostics, 'invalid-input-index', `Input ${edge.inputIndex} does not exist on ${targetNode.label}.`, targetNode, edge);
    }
    if (sourceNode && edge.type !== sourceNode.outputType) {
      const severity = isRoleCrossing(edge.type, sourceNode.outputType) ? 'warning' : 'error';
      add(
        diagnostics,
        'invalid-port-type',
        severity === 'warning'
          ? `Edge ${edge.id} crosses the advisory texture/mask role; both values are RGBA data.`
          : `Edge ${edge.id} does not match its source output type.`,
        sourceNode,
        edge,
        severity,
      );
    }
  }

  const outputEdges = incoming.get(graph.outputId) ?? [];
  if (outputEdges.length === 0) add(diagnostics, 'missing-root', 'The operation graph must have at least one root connected to Paint output.');
  const outputIndexes = new Set<number>();
  for (const edge of outputEdges) {
    if (outputIndexes.has(edge.inputIndex)) add(diagnostics, 'duplicate-input', `Paint output has duplicate input ${edge.inputIndex}.`, output, edge);
    outputIndexes.add(edge.inputIndex);
    const sourceNode = byId.get(edge.source);
    if (sourceNode?.outputType === 'mask') {
      add(
        diagnostics,
        'invalid-root-type',
        `${sourceNode.label} is labeled as a mask at Paint output; this role is advisory because the compositor accepts RGBA data.`,
        sourceNode,
        edge,
        'warning',
      );
    }
  }
  for (let index = 0; index < outputEdges.length; index += 1) {
    if (!outputIndexes.has(index)) {
      add(diagnostics, 'invalid-input-index', `Paint output root inputs must be ordered from zero; input ${index} is missing.`, output);
    }
  }

  const authoredNodes = graph.nodes.filter((node) => node.kind !== 'output');
  for (const node of authoredNodes) {
    const parents = outgoing.get(node.id) ?? [];
    const children = (incoming.get(node.id) ?? []).slice().sort((a, b) => a.inputIndex - b.inputIndex || a.id.localeCompare(b.id));
    const parentEdges = parents.filter((edge) => edge.target !== graph.outputId);
    if (parentEdges.length > 1) add(diagnostics, 'multiple-parents', `${node.label} is connected to more than one authored parent.`, node);
    if (parents.length > 1) add(diagnostics, 'shared-output', `${node.label} has a shared output; duplicate the subtree before reusing it.`, node);
    if (parents.length === 0) add(diagnostics, 'orphan-node', `${node.label} is not connected to a parent or Paint output.`, node);

    const variants = stageVariantCount(node);
    if (node.kind === 'invalid' || variants === 0) add(diagnostics, 'invalid-stage', `${node.label} does not contain a recognized operation stage.`, node);
    if (variants > 1) add(diagnostics, 'multiple-stage-variants', `${node.label} contains more than one operation variant.`, node);

    if (node.kind === 'operation_template') {
      const ref = node.raw?.operation_template;
      if (!ref || !Number.isSafeInteger(ref.defindex) || ref.defindex < 0) {
        add(diagnostics, 'operation-template-missing-id', 'Operation template references must include a non-negative defindex.', node);
      }
      if (!node.locked) add(diagnostics, 'locked-reference-modified', 'Operation template references are locked and cannot be made editable in place.', node);
      if (node.lockedSnapshot && !deepEqual(node.lockedSnapshot, node.raw)) {
        add(diagnostics, 'locked-reference-modified', 'The opaque operation-template reference was modified.', node);
      }
      if (children.length > 0) add(diagnostics, 'locked-reference-children', 'An opaque operation-template reference cannot own graph inputs.', node);
      continue;
    }

    if (!hasContainer(node.kind) && children.length > 0) {
      add(diagnostics, 'unexpected-inputs', `${node.label} does not accept graph inputs.`, node);
      continue;
    }

    if (node.kind === 'combine_add' || node.kind === 'combine_multiply') {
      if (children.length < 2) add(diagnostics, 'invalid-arity', `${stageKindLabel(node.kind)} requires at least two ordered inputs.`, node);
    } else if (node.kind === 'combine_lerp') {
      if (children.length !== 3) add(diagnostics, 'invalid-arity', 'combine-lerp requires Background, Foreground, and Blend mask inputs.', node);
    } else if (node.kind === 'apply_sticker' && children.length !== 1) {
      add(diagnostics, 'invalid-arity', 'apply-sticker requires exactly one Surface input.', node);
    }

    for (const edge of children) {
      const expected = expectedPortType(node, edge.inputIndex);
      const sourceType = byId.get(edge.source)?.outputType ?? edge.type;
      if (!compatible(sourceType, expected)) {
        add(diagnostics, 'invalid-port-type', `${node.label} input ${edge.inputIndex + 1} expects ${expected}, but the connected node produces ${sourceType}.`, node, edge);
      } else if (isRoleCrossing(sourceType, expected)) {
        add(
          diagnostics,
          'invalid-port-type',
          `${node.label} input ${edge.inputIndex + 1} crosses the advisory ${expected}/${sourceType} role; both stages produce RGBA data.`,
          node,
          edge,
          'warning',
        );
      }
      const expectedPort = node.inputPorts[edge.inputIndex];
      if (expectedPort && expectedPort.type !== expected && expectedPort.type !== 'unknown') {
        add(diagnostics, 'invalid-port-type', `${node.label} declares an incompatible input port at index ${edge.inputIndex}.`, node, edge);
      }
    }
    const requiredPorts = node.inputPorts.filter((input) => input.required && !input.variadic);
    for (const input of requiredPorts) {
      if (!children.some((edge) => edge.inputIndex === input.index)) {
        add(diagnostics, 'missing-input', `${node.label} is missing required input ${input.label}.`, node);
      }
    }
  }

  // Every authored node must be reachable from the synthetic output. This is
  // separate from parent counting so a disconnected leaf is diagnosed too.
  const reachable = new Set<string>();
  const markReachable = (nodeId: string): void => {
    if (reachable.has(nodeId)) return;
    reachable.add(nodeId);
    for (const edge of incoming.get(nodeId) ?? []) markReachable(edge.source);
  };
  markReachable(graph.outputId);
  for (const node of authoredNodes) {
    if (!reachable.has(node.id)) add(diagnostics, 'orphan-node', `${node.label} is not on a path to Paint output.`, node);
  }

  // Detect directed cycles in source -> target data flow. Edges into output
  // are excluded because output is intentionally a terminal sentinel.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const walk = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      const node = byId.get(nodeId);
      add(diagnostics, 'cycle', `The operation graph contains a cycle involving ${node?.label ?? nodeId}.`, node);
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) {
      if (edge.target !== graph.outputId) walk(edge.target);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const node of authoredNodes) walk(node.id);

  return { valid: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'), diagnostics };
}

/** Convenience boolean for connection guards. */
export function isOperationGraphValid(graph: OperationGraph): boolean {
  return validateOperationGraph(graph).valid;
}

/** Check whether one output can connect to one input without mutating a graph. */
export function canConnectOperationPorts(source: OperationPortType, target: OperationPortType): boolean {
  return compatible(source, target);
}
