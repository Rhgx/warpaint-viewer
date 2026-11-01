import type { OperationNodeMsg, OperationStageMsg } from '../../../protodefs/messages';
import type { OperationGraph, OperationGraphNode, OperationGraphPath, OperationStageKind } from '../types';
import {
  CONTAINER_KINDS,
  clone,
  inputPortsFor as portsFor,
  operationGraphNodeKind as rawOperationGraphNodeKind,
  outputTypeOf,
} from '../operationGraph';
import {
  diagnosticResult,
  immutableGraph,
  mutableGraph,
  uniqueId,
  type MutableGraph,
  type OperationGraphEditDiagnostic,
  type OperationGraphEditResult,
} from './core';

export interface CreateOperationGraphNodeOptions {
  /** Override the generated ID when a caller already has a stable UI ID. */
  readonly nodeId?: string;
  /** Optional authored data to use as the node's raw message. */
  readonly raw?: OperationNodeMsg;
}

export interface CreatedOperationGraphNode {
  readonly nodeId: string;
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
    outputType: outputTypeOf(kind),
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
