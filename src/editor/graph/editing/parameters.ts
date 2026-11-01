import { many, type OperationNodeMsg, type VarDefMsg, type VarFieldMsg } from '../../../protodefs/messages';
import type { OperationGraph, OperationGraphNode } from '../types';
import {
  clone,
  findOperationGraphNode,
  operationGraphNodeKind as rawOperationGraphNodeKind,
} from '../operationGraph';
import { isRecordValue } from '../graphBoundary';
import {
  diagnosticResult,
  editFailure,
  editSuccess,
  mutableGraph,
  type MutableGraph,
  type OperationGraphEditDiagnostic,
  type OperationGraphEditResult,
} from './core';

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
    if (existing !== undefined && !isRecordValue(existing)) {
      return { code: 'invalid-parameter', severity: 'error', message: `Select parameter ${index} is not a variable field.`, nodeId: node.id, path: node.sourcePath };
    }
    return {
      field: existing,
      write: (next) => {
        if (Array.isArray(prior)) {
          const replacement = prior.map((entry, entryIndex) => entryIndex === index ? next : entry);
          stage.select = replacement;
        } else {
          // Undefined and singleton fields both become a singleton, keeping the compact proto shape.
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
      allowed = ['adjust_black', 'adjust_offset', 'adjust_gamma'].includes(field);
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
  if (!isRecordValue(owner)) return { code: 'invalid-stage', severity: 'error', message: `${node.label} has no authored stage.`, nodeId: node.id, path: node.sourcePath };
  const record = owner;
  const existingValue = record[field];
  if (existingValue !== undefined && !isRecordValue(existingValue)) {
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
  const next: VarFieldMsg = existing ? clone(existing) : {};
  const priorScalar = operationGraphVarFieldScalarKey(existing);
  for (const key of VAR_FIELD_KEYS) delete next[key];
  if (!preserveVariable) delete next.variable;
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
      next[key] = numeric;
      break;
    }
    case 'bool':
      next.bool = typeof value === 'boolean' ? value : value === 'true' || value === '1';
      break;
    case 'string':
      next.string = formatParameterValue(value);
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
  const node = findOperationGraphNode(graph, request.nodeId);
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
