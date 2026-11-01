// Pure helpers that turn an OperationGraph into labels, editable parameters and React Flow connection rules.
import type { Connection, Edge } from '@xyflow/react';
import {
  canConnectOperationPorts,
  type OperationGraph,
  type OperationGraphNode,
  type OperationGraphNodeKind,
  type OperationGraphParameterField,
  type OperationGraphPort,
  type OperationPortType,
} from '../../editor/graph';
import type {
  CombineStageMsg,
  StickerStageMsg,
  TextureStageMsg,
  VarFieldMsg,
} from '../../protodefs/messages';
import {
  PARAMETER_META,
  type EditableParameter,
  type FlowNodeData,
  type OperationGraphConnection,
} from './operationGraphTypes';

type AdjustmentStage = TextureStageMsg | CombineStageMsg | StickerStageMsg;

export function sameFlowNodeData(a: FlowNodeData, b: FlowNodeData): boolean {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((key) => a[key] === b[key]);
}

export function nodeKindLabel(kind: OperationGraphNodeKind): string {
  switch (kind) {
    case 'texture_lookup': return 'Texture';
    case 'select': return 'Select';
    case 'combine_add': return 'Add';
    case 'combine_multiply': return 'Multiply';
    case 'combine_lerp': return 'Blend';
    case 'apply_sticker': return 'Sticker';
    case 'operation_template': return 'Template';
    case 'output': return 'Output';
    case 'invalid': return 'Unknown';
  }
}

export function portTypeLabel(type: OperationPortType): string {
  switch (type) {
    case 'texture': return 'texture';
    case 'mask': return 'mask';
    case 'unknown': return 'any';
    case 'none': return 'none';
  }
}

export function portTypeClass(type: OperationPortType): string {
  return `operation-graph-port-${type}`;
}

export function canonicalDimension(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.max(1, Math.round(value));
}

function fieldDisplayValue(field: VarFieldMsg | undefined): string | undefined {
  if (!field) return undefined;
  if (field.variable) return field.variable;
  const values: readonly [string, string | number | boolean | undefined][] = [
    ['string', field.string],
    ['float', field.float],
    ['double', field.double],
    ['uint32', field.uint32],
    ['uint64', field.uint64],
    ['sint32', field.sint32],
    ['sint64', field.sint64],
    ['bool', field.bool],
  ];
  const entry = values.find((candidate): candidate is [string, string | number | boolean] => candidate[1] !== undefined);
  return entry ? String(entry[1]) : undefined;
}

/** The tail of a texture path, which is what tells two sources apart at a glance. */
export function shortTexturePath(value: string): string {
  const parts = value.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : value;
}

function adjustmentStageFor(node: OperationGraphNode): AdjustmentStage | undefined {
  const stage = node.raw?.stage;
  if (!stage) return undefined;
  switch (node.kind) {
    case 'texture_lookup': return stage.texture_lookup;
    case 'combine_add': return stage.combine_add;
    case 'combine_multiply': return stage.combine_multiply;
    case 'combine_lerp': return stage.combine_lerp;
    case 'apply_sticker': return stage.apply_sticker;
    default: return undefined;
  }
}

export function sourceSummary(node: OperationGraphNode): readonly { readonly label: string; readonly value: string }[] {
  const stage = node.raw?.stage;
  if (!stage) return [];
  switch (node.kind) {
    case 'texture_lookup': {
      const texture = stage.texture_lookup?.texture ?? stage.texture_lookup?.texture_red;
      const path = fieldDisplayValue(texture);
      return path ? [{ label: 'Source', value: path }] : [];
    }
    case 'select': {
      const groups = fieldDisplayValue(stage.select?.groups);
      const select = stage.select?.select;
      const count = Array.isArray(select) ? select.length : select ? 1 : 0;
      return [
        ...(groups ? [{ label: 'Mask', value: groups }] : []),
        { label: 'Selected', value: `${count} group${count === 1 ? '' : 's'}` },
      ];
    }
    case 'apply_sticker': {
      const sticker = stage.apply_sticker?.sticker;
      const count = Array.isArray(sticker) ? sticker.length : sticker ? 1 : 0;
      return [{ label: 'Artwork', value: `${count} sticker${count === 1 ? '' : 's'}` }];
    }
    default: return [];
  }
}

function parameter(
  field: OperationGraphParameterField,
  value: VarFieldMsg | undefined,
  primary = false,
): EditableParameter {
  return { address: { field }, meta: PARAMETER_META[field], field: value, primary };
}

function commonStageParameters(stage: AdjustmentStage | undefined, includeUvTransform = false): EditableParameter[] {
  if (!stage) return [];
  const parameters: EditableParameter[] = [
    parameter('adjust_black', stage.adjust_black),
    parameter('adjust_offset', stage.adjust_offset),
    parameter('adjust_gamma', stage.adjust_gamma),
    ...(includeUvTransform ? [
      parameter('rotation', 'rotation' in stage ? stage.rotation : undefined),
      parameter('translate_u', 'translate_u' in stage ? stage.translate_u : undefined),
      parameter('translate_v', 'translate_v' in stage ? stage.translate_v : undefined),
      parameter('scale_uv', 'scale_uv' in stage ? stage.scale_uv : undefined),
      parameter('flip_u', 'flip_u' in stage ? stage.flip_u : undefined),
      parameter('flip_v', 'flip_v' in stage ? stage.flip_v : undefined),
    ] : []),
  ];
  return parameters.filter((entry) => entry.field !== undefined);
}

export function editableParametersFor(node: OperationGraphNode): readonly EditableParameter[] {
  const stage = node.raw?.stage;
  if (!stage) return [];
  switch (node.kind) {
    case 'texture_lookup': {
      const texture = stage.texture_lookup;
      if (!texture) return [];
      const hasTeamSources = texture.texture_red !== undefined || texture.texture_blue !== undefined;
      return [
        ...(!hasTeamSources || texture.texture !== undefined
          ? [parameter('texture', texture.texture, true)]
          : []),
        ...(hasTeamSources
          ? [parameter('texture_red', texture.texture_red, true), parameter('texture_blue', texture.texture_blue, true)]
          : []),
        ...commonStageParameters(texture, true),
      ];
    }
    case 'select': {
      const select = stage.select;
      return select ? [parameter('groups', select.groups, true)] : [];
    }
    case 'combine_add':
    case 'combine_multiply':
    case 'combine_lerp':
    case 'apply_sticker': {
      const direct = adjustmentStageFor(node);
      const destination = node.kind === 'apply_sticker' && stage.apply_sticker
        ? [
          parameter('dest_tl', stage.apply_sticker.dest_tl),
          parameter('dest_tr', stage.apply_sticker.dest_tr),
          parameter('dest_bl', stage.apply_sticker.dest_bl),
        ].filter((entry) => entry.field !== undefined)
        : [];
      return [...destination, ...commonStageParameters(direct)];
    }
    default:
      return [];
  }
}

/** Ports as the canvas offers them, including the trailing slot variadic stages grow into; must match the mutation layer's `portAt`. */
export function visibleInputPorts(node: OperationGraphNode): readonly OperationGraphPort[] {
  const index = node.inputPorts.length;
  if (node.kind === 'combine_add' || node.kind === 'combine_multiply') {
    return [...node.inputPorts, { id: `input-${index}`, label: `Input ${index + 1}`, index, type: 'texture', required: false, variadic: true }];
  }
  if (node.kind === 'output') {
    return [...node.inputPorts, { id: `input-${index}`, label: `Result ${index + 1}`, index, type: 'unknown', required: false, variadic: true }];
  }
  return node.inputPorts;
}

export function flowConnectionFromReactFlow(
  connection: Connection | Edge,
  graph: OperationGraph,
): OperationGraphConnection | undefined {
  if (!connection.source || !connection.target) return undefined;
  const source = graph.nodes.find((node) => node.id === connection.source);
  const target = graph.nodes.find((node) => node.id === connection.target);
  if (!source || !target || source.kind === 'output') return undefined;
  const sourceHandle = connection.sourceHandle ?? 'output';
  const targetHandle = connection.targetHandle;
  if (!targetHandle || !targetHandle.startsWith('input-')) return undefined;
  const inputIndex = Number(targetHandle.slice('input-'.length));
  if (!Number.isInteger(inputIndex) || inputIndex < 0) return undefined;
  return {
    source: source.id,
    target: target.id,
    sourceHandle,
    targetHandle,
    inputIndex,
    type: source.outputType,
  };
}

/** Mirrors the mutation layer's guards. `ignoredEdgeId` is the edge being reconnected, which does not occupy its own slot. */
export function connectionIsValid(
  connection: Connection | Edge,
  graph: OperationGraph,
  ignoredEdgeId?: string,
): boolean {
  const normalized = flowConnectionFromReactFlow(connection, graph);
  if (!normalized || normalized.source === normalized.target) return false;
  const source = graph.nodes.find((node) => node.id === normalized.source);
  const target = graph.nodes.find((node) => node.id === normalized.target);
  if (!source || !target) return false;
  const port = visibleInputPorts(target)[normalized.inputIndex];
  if (!port) return false;
  if (target.kind !== 'output' && target.locked) return false;
  if (target.kind === 'output' && source.outputType === 'mask') return false;
  const occupied = graph.edges.some((edge) => (
    edge.target === target.id && edge.inputIndex === normalized.inputIndex && edge.id !== ignoredEdgeId
  ));
  if (occupied) return false;
  return canConnectOperationPorts(source.outputType, port.type);
}

/** Every node reachable from nodeId along edges, including nodeId itself. */
export function traceNodes(graph: OperationGraph, nodeId: string, direction: 'upstream' | 'downstream'): Set<string> {
  const result = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const edge of graph.edges) {
      const from = direction === 'upstream' ? edge.target : edge.source;
      const next = direction === 'upstream' ? edge.source : edge.target;
      if (from === current && !result.has(next)) {
        result.add(next);
        stack.push(next);
      }
    }
  }
  return result;
}

export function operationNodeClass(node: OperationGraphNode): string {
  return `operation-graph-node-${node.kind.replaceAll('_', '-')}`;
}
