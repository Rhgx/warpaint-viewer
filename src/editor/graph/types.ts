import type { Many, OperationMsg, OperationNodeMsg } from '../../protodefs/messages';

/** The authored operation stages understood by TF2's paint compositor. */
export type OperationStageKind =
  | 'texture_lookup'
  | 'select'
  | 'combine_add'
  | 'combine_multiply'
  | 'combine_lerp'
  | 'apply_sticker';

/** A graph node can also be an opaque operation-template reference. */
export type OperationGraphNodeKind = OperationStageKind | 'operation_template' | 'invalid' | 'output';

/** The value carried by a node connection. */
export type OperationPortType = 'texture' | 'mask' | 'unknown' | 'none';

export type GraphPathSegment = string | number;
export type OperationGraphPath = readonly GraphPathSegment[];

/** How a protobuf `Many<T>` field was represented in the source message. */
export type ManyShape = 'undefined' | 'singleton' | 'array';

export interface OperationGraphPosition {
  readonly x: number;
  readonly y: number;
}

export interface OperationGraphPort {
  readonly id: string;
  readonly label: string;
  readonly index: number;
  readonly type: OperationPortType;
  readonly required: boolean;
  readonly variadic?: boolean;
}

export interface OperationGraphNode {
  /** Stable for a given authored path. It is intentionally independent of UI position. */
  readonly id: string;
  readonly kind: OperationGraphNodeKind;
  readonly label: string;
  /** A detached copy of the exact authored node, including unknown properties. */
  readonly raw?: OperationNodeMsg;
  readonly sourcePath: OperationGraphPath;
  readonly outputType: OperationPortType;
  readonly inputPorts: readonly OperationGraphPort[];
  readonly locked: boolean;
  /** Child order as represented by incoming graph edges. */
  readonly children: readonly string[];
  /** Original representation of this node's nested operation_node field. */
  readonly childrenShape?: ManyShape;
  /** Snapshot used to detect accidental edits to opaque references. */
  readonly lockedSnapshot?: OperationNodeMsg;
}

export interface OperationGraphEdge {
  readonly id: string;
  /** Data flows from child/source toward parent/target. */
  readonly source: string;
  readonly target: string;
  readonly sourceHandle: string;
  readonly targetHandle: string;
  readonly inputIndex: number;
  readonly type: OperationPortType;
}

export interface OperationGraph {
  readonly nodes: readonly OperationGraphNode[];
  readonly edges: readonly OperationGraphEdge[];
  readonly roots: readonly string[];
  readonly outputId: string;
  readonly rootShape: ManyShape;
  /** A detached operation snapshot when the graph was built from an OperationMsg. */
  readonly operationSnapshot?: OperationMsg;
}

export interface OperationGraphBuildOptions {
  /** Path prefix used when a graph represents a nested operation tree. */
  readonly pathPrefix?: OperationGraphPath;
  /** A caller-supplied synthetic output ID, useful when several graphs share a canvas. */
  readonly outputId?: string;
  /** Keep the original OperationMsg for graphToOperation. */
  readonly operationSnapshot?: OperationMsg;
}

export type OperationGraphDiagnosticSeverity = 'error' | 'warning';

export type OperationGraphDiagnosticCode =
  | 'missing-root'
  | 'missing-node'
  | 'duplicate-node'
  | 'duplicate-input'
  | 'invalid-input-index'
  | 'cycle'
  | 'multiple-parents'
  | 'shared-output'
  | 'orphan-node'
  | 'invalid-stage'
  | 'multiple-stage-variants'
  | 'operation-template-missing-id'
  | 'locked-reference-modified'
  | 'locked-reference-children'
  | 'unexpected-inputs'
  | 'missing-input'
  | 'invalid-arity'
  | 'invalid-port-type'
  | 'invalid-root-type';

export interface OperationGraphDiagnostic {
  readonly code: OperationGraphDiagnosticCode;
  readonly severity: OperationGraphDiagnosticSeverity;
  readonly message: string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly path?: OperationGraphPath;
}

export interface OperationGraphValidation {
  readonly valid: boolean;
  readonly diagnostics: readonly OperationGraphDiagnostic[];
}

export interface OperationGraphLayoutOptions {
  readonly horizontalGap?: number;
  readonly verticalGap?: number;
  readonly outputGap?: number;
}

export type OperationGraphLayout = Readonly<Record<string, OperationGraphPosition>>;

/** Return the source representation of a Many<T> field without changing it. */
export function manyShape<T>(value: Many<T>): ManyShape {
  if (value === undefined) return 'undefined';
  return Array.isArray(value) ? 'array' : 'singleton';
}
