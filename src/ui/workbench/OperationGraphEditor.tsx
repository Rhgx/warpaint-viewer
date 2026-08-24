import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  ConnectionLineType,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getSmoothStepPath,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type XYPosition,
} from '@xyflow/react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Asterisk,
  Blend,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  Download,
  ExternalLink,
  Focus,
  Image as ImageIcon,
  Layers,
  LayoutDashboard,
  LockKeyhole,
  Package,
  Plus,
  Search,
  SlidersHorizontal,
  Sticker,
  Target,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';
import {
  canConnectOperationPorts,
  layoutOperationGraph,
  type OperationGraph,
  type OperationGraphDiagnostic,
  type OperationGraphEdge,
  type OperationGraphNode,
  type OperationGraphNodeKind,
  type OperationGraphParameterAddress,
  type OperationGraphParameterField,
  type OperationGraphParameterValue,
  type OperationGraphPort,
  type OperationPortType,
  type OperationStageKind,
  validateOperationGraph,
} from '../../editor/graph';
import type {
  CombineStageMsg,
  OperationNodeMsg,
  StickerStageMsg,
  TextureStageMsg,
  VarFieldMsg,
} from '../../protodefs/messages';
import { GraphValueField } from './OperationGraphFields';
import type {
  GraphComboboxOption,
  GraphFieldKind,
  GraphVariableOption,
} from './operationGraphFieldValues';
import './OperationGraphEditor.css';

/** A normalized connection that the graph editor can pass to the session layer. */
export interface OperationGraphConnection {
  readonly source: string;
  readonly target: string;
  readonly sourceHandle: string;
  readonly targetHandle: string;
  readonly inputIndex: number;
  readonly type: OperationPortType;
}

export type OperationGraphEditorChange =
  | { readonly type: 'move'; readonly nodeId: string; readonly position: XYPosition }
  | { readonly type: 'arrange'; readonly positions: Readonly<Record<string, XYPosition>> }
  | { readonly type: 'connect'; readonly connection: OperationGraphConnection }
  | { readonly type: 'reconnect'; readonly previous: OperationGraphEdge; readonly connection: OperationGraphConnection }
  | { readonly type: 'disconnect'; readonly edge: OperationGraphEdge }
  | { readonly type: 'add'; readonly kind: OperationStageKind; readonly position?: XYPosition }
  | { readonly type: 'duplicate'; readonly nodeId: string }
  | { readonly type: 'delete'; readonly nodeId: string }
  | { readonly type: 'reorder'; readonly nodeId: string; readonly fromIndex: number; readonly toIndex: number };

export type OperationGraphExportFormat = 'png' | 'vtf';

export interface OperationGraphEditorProps {
  readonly graph: OperationGraph;
  readonly selectedNodeId?: string;
  readonly onSelectNode?: (nodeId: string | null) => void;
  readonly onGraphChange?: (change: OperationGraphEditorChange) => void;
  /** Retained for callers that still author raw stage messages directly. */
  readonly onUpdateNodeRaw?: (nodeId: string, raw: OperationNodeMsg) => void;
  readonly onUpdateParameter?: (
    nodeId: string,
    address: OperationGraphParameterAddress,
    value: OperationGraphParameterValue,
  ) => void;
  /** Every texture the viewer can offer, used by the on-node texture pickers. */
  readonly textureOptions?: readonly GraphComboboxOption[];
  /**
   * Variables a parameter can bind to. Defaults to the ones the operation
   * snapshot declares, but a paint kit usually declares them one level up, so
   * the workbench passes the merged catalogue.
   */
  readonly variables?: readonly GraphVariableOption[];
  readonly onAddNode?: (kind: OperationStageKind, position?: XYPosition) => void;
  readonly onDeleteNode?: (nodeId: string) => void;
  readonly onDuplicateNode?: (nodeId: string) => void;
  readonly onConnect?: (connection: OperationGraphConnection) => void;
  readonly onReconnect?: (previous: OperationGraphEdge, connection: OperationGraphConnection) => void;
  readonly onDisconnect?: (edge: OperationGraphEdge) => void;
  readonly onReorderInput?: (nodeId: string, fromIndex: number, toIndex: number) => void;
  readonly onAutoArrange?: () => void;
  readonly onOpenTextureEditor?: (nodeId: string) => void;
  readonly onOpenSelectEditor?: (nodeId: string) => void;
  readonly onOpenStickerEditor?: (nodeId: string) => void;
  readonly onPreviewNode?: (nodeId: string) => string | undefined;
  readonly onExportNode?: (nodeId: string, format: OperationGraphExportFormat) => void;
  readonly readOnly?: boolean;
  readonly className?: string;
}

type AdjustmentStage = TextureStageMsg | CombineStageMsg | StickerStageMsg;

interface FlowNodeData extends Record<string, unknown> {
  readonly graphNode: OperationGraphNode;
  readonly nodesById: ReadonlyMap<string, OperationGraphNode>;
  readonly connectedEdges: readonly OperationGraphEdge[];
  readonly diagnostics: readonly OperationGraphDiagnostic[];
  readonly variables: readonly GraphVariableOption[];
  readonly textureOptions: readonly GraphComboboxOption[];
  readonly previewUrl?: string;
  readonly readOnly: boolean;
  readonly onSelectNode: (nodeId: string) => void;
  readonly onGraphChange?: (change: OperationGraphEditorChange) => void;
  readonly onUpdateParameter?: OperationGraphEditorProps['onUpdateParameter'];
  readonly onReorderInput?: (nodeId: string, fromIndex: number, toIndex: number) => void;
  readonly onOpenTextureEditor?: (nodeId: string) => void;
  readonly onOpenSelectEditor?: (nodeId: string) => void;
  readonly onOpenStickerEditor?: (nodeId: string) => void;
  readonly onExportNode?: (nodeId: string, format: OperationGraphExportFormat) => void;
  readonly emphasis: 'normal' | 'active' | 'related' | 'dimmed';
  readonly searchMatch: boolean;
}

type FlowNode = Node<FlowNodeData, 'operation'>;

interface FlowEdgeData extends Record<string, unknown> {
  readonly portType: OperationPortType;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  /** On the traced path of the selected node, so it animates its direction. */
  readonly traced: boolean;
  /** Touches the selected node itself rather than its wider lineage. */
  readonly direct: boolean;
  readonly readOnly: boolean;
  readonly onDisconnect: (edgeId: string) => void;
}

type FlowEdge = Edge<FlowEdgeData, 'operation'>;

const FIT_VIEW_OPTIONS = Object.freeze({ padding: 0.2 });
// Arrowheads live in a shared SVG <defs> keyed by literal color, so they
// cannot read the --graph-type-* tokens the lines use. Keep the two in step.
const PORT_COLORS = Object.freeze({
  texture: '#3b82b7',
  mask: '#8c5aaa',
  unknown: '#7b858f',
  none: '#7b858f',
});
const EDGE_ARROW_MARKERS = Object.freeze({
  texture: Object.freeze({ type: MarkerType.ArrowClosed, width: 13, height: 13, color: PORT_COLORS.texture }),
  mask: Object.freeze({ type: MarkerType.ArrowClosed, width: 13, height: 13, color: PORT_COLORS.mask }),
  unknown: Object.freeze({ type: MarkerType.ArrowClosed, width: 13, height: 13, color: PORT_COLORS.unknown }),
  none: Object.freeze({ type: MarkerType.ArrowClosed, width: 13, height: 13, color: PORT_COLORS.none }),
});
const DEFAULT_EDGE_OPTIONS = Object.freeze({
  type: 'operation' as const,
  markerEnd: EDGE_ARROW_MARKERS.unknown,
});
const CONNECTION_LINE_STYLE = Object.freeze({ strokeWidth: 2 });
const CONNECTION_RADIUS = 26;
const RECONNECT_RADIUS = 28;
const EDGE_INTERACTION_WIDTH = 26;
const EDGE_CORNER_RADIUS = 10;
const SELECTED_NODE_Z_INDEX = 900;
// Mirrors the card's width in CSS, plus a rough height for a stage that has not
// rendered yet. Only used to centre a new card on the viewport.
const NEW_NODE_SIZE = Object.freeze({ width: 246, height: 132 });
const PRO_OPTIONS = Object.freeze({ hideAttribution: true });
const LAYOUT_OPTIONS = Object.freeze({ horizontalGap: 60, verticalGap: 26, outputGap: 76 });

const TRACE_OPTIONS: readonly {
  readonly mode: 'both' | 'upstream' | 'downstream';
  readonly label: string;
  readonly title: string;
}[] = [
  { mode: 'both', label: 'Both', title: 'Show inputs and outputs connected to this stage' },
  { mode: 'upstream', label: 'Inputs', title: 'Show only the stages feeding this stage' },
  { mode: 'downstream', label: 'Outputs', title: "Show only the stages receiving this stage's result" },
];

const STAGE_OPTIONS: readonly { readonly kind: OperationStageKind; readonly label: string; readonly description: string }[] = [
  { kind: 'texture_lookup', label: 'Texture lookup', description: 'Read a source texture' },
  { kind: 'select', label: 'Select groups', description: 'Choose paint groups' },
  { kind: 'combine_add', label: 'Add textures', description: 'Add two or more surfaces' },
  { kind: 'combine_multiply', label: 'Multiply textures', description: 'Multiply two or more surfaces' },
  { kind: 'combine_lerp', label: 'Blend textures', description: 'Blend with a mask' },
  { kind: 'apply_sticker', label: 'Apply sticker', description: 'Place artwork on a surface' },
];

interface ParameterMeta {
  readonly label: string;
  readonly kind: GraphFieldKind;
  readonly step?: number;
}

/**
 * How each authored stage field is entered. The compositor reads most of these
 * as `"min max"` ranges resolved per paint seed, so they get a range control
 * rather than a text box people have to know the syntax for.
 */
const PARAMETER_META: Readonly<Record<OperationGraphParameterField, ParameterMeta>> = {
  texture: { label: 'Source texture', kind: 'texture' },
  texture_red: { label: 'RED texture', kind: 'texture' },
  texture_blue: { label: 'BLU texture', kind: 'texture' },
  groups: { label: 'Group mask', kind: 'texture' },
  select: { label: 'Selected groups', kind: 'text' },
  adjust_black: { label: 'Black point', kind: 'range', step: 1 },
  adjust_offset: { label: 'Offset', kind: 'range', step: 1 },
  adjust_gamma: { label: 'Gamma', kind: 'range', step: 0.05 },
  rotation: { label: 'Rotation', kind: 'range', step: 1 },
  translate_u: { label: 'Offset U', kind: 'range', step: 0.01 },
  translate_v: { label: 'Offset V', kind: 'range', step: 0.01 },
  scale_uv: { label: 'Scale', kind: 'range', step: 0.05 },
  flip_u: { label: 'Flip U', kind: 'toggle' },
  flip_v: { label: 'Flip V', kind: 'toggle' },
  dest_tl: { label: 'Top left', kind: 'vector', step: 0.01 },
  dest_tr: { label: 'Top right', kind: 'vector', step: 0.01 },
  dest_bl: { label: 'Bottom left', kind: 'vector', step: 0.01 },
};

interface EditableParameter {
  readonly address: OperationGraphParameterAddress;
  readonly meta: ParameterMeta;
  readonly field?: VarFieldMsg;
  readonly primary?: boolean;
}

function nodeKindLabel(kind: OperationGraphNodeKind): string {
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

function NodeKindIcon({ kind }: { readonly kind: OperationGraphNodeKind }): React.JSX.Element {
  const size = 12;
  switch (kind) {
    case 'texture_lookup': return <ImageIcon size={size} aria-hidden />;
    case 'select': return <Layers size={size} aria-hidden />;
    case 'combine_add': return <Plus size={size} aria-hidden />;
    case 'combine_multiply': return <Asterisk size={size} aria-hidden />;
    case 'combine_lerp': return <Blend size={size} aria-hidden />;
    case 'apply_sticker': return <Sticker size={size} aria-hidden />;
    case 'operation_template': return <Package size={size} aria-hidden />;
    case 'output': return <Target size={size} aria-hidden />;
    case 'invalid': return <AlertTriangle size={size} aria-hidden />;
  }
}

function portTypeLabel(type: OperationPortType): string {
  switch (type) {
    case 'texture': return 'texture';
    case 'mask': return 'mask';
    case 'unknown': return 'any';
    case 'none': return 'none';
  }
}

function portTypeClass(type: OperationPortType): string {
  return `operation-graph-port-${type}`;
}

function canonicalDimension(value: number | undefined): number | undefined {
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
function shortTexturePath(value: string): string {
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

function sourceSummary(node: OperationGraphNode): readonly { readonly label: string; readonly value: string }[] {
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

function commonStageParameters(stage: AdjustmentStage | undefined): EditableParameter[] {
  if (!stage) return [];
  const parameters: EditableParameter[] = [
    parameter('adjust_black', stage.adjust_black),
    parameter('adjust_offset', stage.adjust_offset),
    parameter('adjust_gamma', stage.adjust_gamma),
    parameter('rotation', 'rotation' in stage ? stage.rotation : undefined),
    parameter('translate_u', 'translate_u' in stage ? stage.translate_u : undefined),
    parameter('translate_v', 'translate_v' in stage ? stage.translate_v : undefined),
    parameter('scale_uv', 'scale_uv' in stage ? stage.scale_uv : undefined),
    parameter('flip_u', 'flip_u' in stage ? stage.flip_u : undefined),
    parameter('flip_v', 'flip_v' in stage ? stage.flip_v : undefined),
  ];
  return parameters.filter((entry) => entry.field !== undefined);
}

function editableParametersFor(node: OperationGraphNode): readonly EditableParameter[] {
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
        ...commonStageParameters(texture),
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

/**
 * Ports as the canvas offers them, including the trailing slot that variadic
 * stages grow into. This must agree with the mutation layer's `portAt`, which
 * accepts exactly one index past the authored list for these kinds.
 */
function visibleInputPorts(node: OperationGraphNode): readonly OperationGraphPort[] {
  const index = node.inputPorts.length;
  if (node.kind === 'combine_add' || node.kind === 'combine_multiply') {
    return [...node.inputPorts, { id: `input-${index}`, label: `Input ${index + 1}`, index, type: 'texture', required: false, variadic: true }];
  }
  if (node.kind === 'output') {
    return [...node.inputPorts, { id: `input-${index}`, label: `Result ${index + 1}`, index, type: 'unknown', required: false, variadic: true }];
  }
  return node.inputPorts;
}

function flowConnectionFromReactFlow(
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

/**
 * Mirrors the guards the mutation layer applies, so a drop that cannot be
 * committed never looks droppable. `ignoredEdgeId` is the edge being moved
 * during a reconnect, which must not count as occupying its own slot.
 */
function connectionIsValid(
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

function findUpstream(graph: OperationGraph, nodeId: string): Set<string> {
  const result = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const edge of graph.edges) {
      if (edge.target === current && !result.has(edge.source)) {
        result.add(edge.source);
        stack.push(edge.source);
      }
    }
  }
  return result;
}

function findDownstream(graph: OperationGraph, nodeId: string): Set<string> {
  const result = new Set<string>([nodeId]);
  const stack = [nodeId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const edge of graph.edges) {
      if (edge.source === current && !result.has(edge.target)) {
        result.add(edge.target);
        stack.push(edge.target);
      }
    }
  }
  return result;
}

function operationNodeClass(node: OperationGraphNode): string {
  return `operation-graph-node-${node.kind.replaceAll('_', '-')}`;
}

interface PortRowProps {
  readonly port: OperationGraphPort;
  readonly connectedLabel?: string;
  readonly connectable: boolean;
}

/**
 * One input slot. The dot carries the port's type and whether anything is
 * plugged into it, so a dense graph reads without following every edge.
 */
function PortRow({ port, connectedLabel, connectable }: PortRowProps): React.JSX.Element {
  const state = connectedLabel !== undefined ? 'connected' : port.required ? 'required' : 'open';
  return (
    <div className="operation-graph-port-row" data-state={state}>
      <Handle
        type="target"
        position={Position.Left}
        id={port.id}
        className={`operation-graph-handle ${portTypeClass(port.type)}`}
        isConnectable={connectable}
        title={`${port.label}: ${portTypeLabel(port.type)}${connectedLabel ? ` from ${connectedLabel}` : ''}`}
        aria-label={`${port.label}, ${portTypeLabel(port.type)}`}
      />
      <span className="operation-graph-port-label">{port.label}</span>
      {connectedLabel !== undefined ? (
        <span className="operation-graph-port-source" title={connectedLabel}>{connectedLabel}</span>
      ) : (
        <span className="operation-graph-port-state">{port.required ? 'required' : port.variadic ? 'add' : 'empty'}</span>
      )}
    </div>
  );
}

function OperationFlowNodeComponent({ data, selected }: NodeProps<FlowNode>): React.JSX.Element {
  const { graphNode: node, nodesById, connectedEdges } = data;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const nodeDiagnostics = data.diagnostics;
  // Advisory warnings fire on ordinary, working paints, so only real errors
  // earn a badge on the card. Warnings stay in the selected-node list.
  const nodeErrors = nodeDiagnostics.filter((diagnostic) => diagnostic.severity === 'error');
  const summaries = sourceSummary(node);
  const inputPorts = visibleInputPorts(node);
  const updateParameter = data.onUpdateParameter;
  const parameters = updateParameter ? editableParametersFor(node) : [];
  const primaryParameters = parameters.filter((entry) => entry.primary);
  const advancedParameters = parameters.filter((entry) => !entry.primary);
  const canReorder = !data.readOnly && (node.kind === 'combine_add' || node.kind === 'combine_multiply' || node.kind === 'output');
  const sourceByInput = new Map(connectedEdges.map((edge) => [edge.inputIndex, nodesById.get(edge.source)?.label ?? edge.source]));

  const reorderInput = (fromIndex: number, toIndex: number): void => {
    if (data.onReorderInput) data.onReorderInput(node.id, fromIndex, toIndex);
    else data.onGraphChange?.({ type: 'reorder', nodeId: node.id, fromIndex, toIndex });
  };

  const handleSelect = (): void => data.onSelectNode(node.id);
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleSelect();
    }
  };

  const renderField = (entry: EditableParameter): React.JSX.Element => (
    <GraphValueField
      key={`${entry.address.field}-${entry.address.index ?? 'direct'}`}
      label={entry.meta.label}
      kind={entry.meta.kind}
      {...(entry.field ? { field: entry.field } : {})}
      {...(entry.meta.step !== undefined ? { step: entry.meta.step } : {})}
      variables={data.variables}
      textureOptions={data.textureOptions}
      readOnly={data.readOnly}
      primary={entry.primary ?? false}
      onChange={(value) => updateParameter?.(node.id, entry.address, value)}
    />
  );

  return (
    <article
      className={`operation-graph-node ${operationNodeClass(node)}`}
      data-emphasis={data.emphasis}
      data-search-match={data.searchMatch ? 'true' : undefined}
      data-locked={node.locked ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      tabIndex={0}
      role="button"
      aria-label={`${node.label}, ${nodeKindLabel(node.kind)} node`}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
    >
      {node.kind !== 'output' && (
        <Handle
          type="source"
          position={Position.Right}
          id="output"
          className={`operation-graph-handle operation-graph-output-handle ${portTypeClass(node.outputType)}`}
          isConnectable={!data.readOnly}
          title={`Output: ${portTypeLabel(node.outputType)}`}
          aria-label={`Output, ${portTypeLabel(node.outputType)}`}
        />
      )}
      <header className="operation-graph-node-header">
        <span className="operation-graph-node-glyph" aria-hidden><NodeKindIcon kind={node.kind} /></span>
        <span className="operation-graph-node-heading">
          <span className="operation-graph-node-kind">{nodeKindLabel(node.kind)}</span>
          <strong title={node.label}>{node.label}</strong>
        </span>
        {nodeErrors.length > 0 && (
          <span className="operation-graph-node-badge" title={nodeErrors.map((diagnostic) => diagnostic.message).join('\n')}>
            <AlertTriangle size={11} aria-hidden /> {nodeErrors.length}
          </span>
        )}
        {node.locked && <LockKeyhole size={12} aria-label="Locked" />}
      </header>

      {inputPorts.length > 0 && (
        <div className="operation-graph-inputs" aria-label="Inputs">
          {inputPorts.map((port) => (
            <PortRow
              key={port.id}
              port={port}
              {...(sourceByInput.has(port.index) ? { connectedLabel: sourceByInput.get(port.index) } : {})}
              connectable={!data.readOnly}
            />
          ))}
        </div>
      )}

      {(data.previewUrl || summaries.length > 0) && (
        <div className="operation-graph-node-summary">
          {data.previewUrl && (
            <img className="operation-graph-node-preview" src={data.previewUrl} alt={`${node.label} preview`} draggable={false} />
          )}
          {summaries.map((summary) => (
            <div className="operation-graph-summary-row" key={summary.label}>
              <span>{summary.label}</span>
              <span title={summary.value}>{shortTexturePath(summary.value)}</span>
            </div>
          ))}
        </div>
      )}

      {selected && primaryParameters.length > 0 && (
        <div
          className="operation-graph-node-fields nodrag nowheel"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
        >
          {primaryParameters.map(renderField)}
        </div>
      )}

      {selected && advancedParameters.length > 0 && (
        <div className="operation-graph-node-advanced nodrag nowheel" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="operation-graph-disclosure"
            aria-expanded={advancedOpen}
            onClick={(event) => { event.stopPropagation(); setAdvancedOpen((open) => !open); }}
          >
            {advancedOpen ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            <span>Adjustments and transform</span>
            <small>{advancedParameters.length}</small>
          </button>
          {advancedOpen && <div className="operation-graph-node-fields">{advancedParameters.map(renderField)}</div>}
        </div>
      )}

      {selected && nodeDiagnostics.length > 0 && (
        <ul className="operation-graph-diagnostics">
          {nodeDiagnostics.map((diagnostic) => (
            <li key={`${diagnostic.code}-${diagnostic.message}`} data-severity={diagnostic.severity}>{diagnostic.message}</li>
          ))}
        </ul>
      )}

      {selected && node.kind === 'operation_template' && (
        <p className="operation-graph-note"><LockKeyhole size={11} aria-hidden /> Template references are preserved and read-only.</p>
      )}
      {selected && node.kind === 'invalid' && (
        <p className="operation-graph-note">This node contains an unknown operation stage.</p>
      )}

      {selected && canReorder && connectedEdges.length > 1 && (
        <div className="operation-graph-reorder-list nodrag" aria-label="Input order" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
          <span className="operation-graph-section-label">Input order</span>
          {connectedEdges.map((edge, index) => (
            <div className="operation-graph-reorder-row" key={edge.id}>
              <span>{nodesById.get(edge.source)?.label ?? edge.source}</span>
              <span>
                <button type="button" className="operation-graph-icon-button" title="Move input up" aria-label="Move input up" disabled={index === 0} onClick={() => reorderInput(index, index - 1)}><ArrowUp size={12} /></button>
                <button type="button" className="operation-graph-icon-button" title="Move input down" aria-label="Move input down" disabled={index === connectedEdges.length - 1} onClick={() => reorderInput(index, index + 1)}><ArrowDown size={12} /></button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="operation-graph-node-actions nodrag">
        {node.kind === 'texture_lookup' && data.onOpenTextureEditor && (
          <button type="button" className="operation-graph-text-button" onClick={(event) => { event.stopPropagation(); data.onOpenTextureEditor?.(node.id); }}>
            <SlidersHorizontal size={12} /> Transform
          </button>
        )}
        {node.kind === 'select' && data.onOpenSelectEditor && (
          <button type="button" className="operation-graph-text-button" onClick={(event) => { event.stopPropagation(); data.onOpenSelectEditor?.(node.id); }}>
            <ExternalLink size={12} /> Groups
          </button>
        )}
        {node.kind === 'apply_sticker' && data.onOpenStickerEditor && (
          <button type="button" className="operation-graph-text-button" onClick={(event) => { event.stopPropagation(); data.onOpenStickerEditor?.(node.id); }}>
            <ExternalLink size={12} /> Placement
          </button>
        )}
        {data.onExportNode && data.previewUrl && (
          <details className="operation-graph-export" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
            <summary title="Download this stage's preview"><Download size={12} /> Export</summary>
            <div className="operation-graph-export-menu">
              <button type="button" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); data.onExportNode?.(node.id, 'png'); }}>
                <ImageIcon size={13} aria-hidden />
                <span>PNG image<small>Easy to preview or share</small></span>
              </button>
              <button type="button" onClick={(event) => { event.currentTarget.closest('details')?.removeAttribute('open'); data.onExportNode?.(node.id, 'vtf'); }}>
                <Package size={13} aria-hidden />
                <span>VTF texture<small>Ready for Source tools</small></span>
              </button>
            </div>
          </details>
        )}
      </div>
    </article>
  );
}

const OperationFlowNode = memo(OperationFlowNodeComponent);
const NODE_TYPES = Object.freeze({ operation: OperationFlowNode });

/**
 * A typed connection that can be removed where it is, instead of sending people
 * to a toolbar button for the edge they already have under the pointer.
 */
function OperationFlowEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  selected,
  data,
}: EdgeProps<FlowEdge>): React.JSX.Element {
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: EDGE_CORNER_RADIUS,
  });
  const active = Boolean(selected) || hovered;
  const removable = active && data !== undefined && !data.readOnly;
  return (
    <>
      <path id={id} className="react-flow__edge-path" d={path} markerEnd={markerEnd} />
      {data?.traced && (
        // Dashes travelling along the path answer "which way does this flow"
        // without asking anyone to find the arrowhead at the far end.
        <path className="operation-graph-edge-flow" d={path} fill="none" />
      )}
      <path
        className="operation-graph-edge-hit"
        d={path}
        fill="none"
        strokeWidth={EDGE_INTERACTION_WIDTH}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      />
      {removable && (
        <EdgeLabelRenderer>
          <button
            type="button"
            className="operation-graph-edge-remove nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={`Disconnect ${data.sourceLabel} from ${data.targetLabel}`}
            aria-label={`Disconnect ${data.sourceLabel} from ${data.targetLabel}`}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onClick={(event) => { event.stopPropagation(); data.onDisconnect(id); }}
          >
            <X size={11} aria-hidden />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const OperationFlowEdge = memo(OperationFlowEdgeComponent);
const EDGE_TYPES = Object.freeze({ operation: OperationFlowEdge });

function graphNodeForId(nodes: readonly FlowNode[], nodeId: string | undefined): FlowNode | undefined {
  return nodeId ? nodes.find((node) => node.id === nodeId) : undefined;
}

function OperationGraphCanvas(props: OperationGraphEditorProps): React.JSX.Element {
  const {
    graph,
    selectedNodeId,
    onSelectNode,
    onGraphChange,
    onUpdateParameter,
    textureOptions,
    variables: suppliedVariables,
    onAddNode,
    onDeleteNode,
    onDuplicateNode,
    onConnect,
    onReconnect,
    onDisconnect,
    onReorderInput,
    onAutoArrange,
    onOpenTextureEditor,
    onOpenSelectEditor,
    onOpenStickerEditor,
    onPreviewNode,
    onExportNode,
    readOnly = false,
  } = props;
  const { fitView, screenToFlowPosition } = useReactFlow<FlowNode, FlowEdge>();
  const updateNodeInternals = useUpdateNodeInternals();
  const [localSelectedNodeId, setLocalSelectedNodeId] = useState<string | undefined>(selectedNodeId);
  const [positions, setPositions] = useState<Record<string, XYPosition>>({});
  const [measurements, setMeasurements] = useState<Record<string, { readonly width?: number; readonly height?: number }>>({});
  const pendingMeasurementsRef = useRef<Record<string, { readonly width?: number; readonly height?: number }>>({});
  const measurementFrameRef = useRef<number | null>(null);
  const [query, setQuery] = useState('');
  const [searchMatchIndex, setSearchMatchIndex] = useState(0);
  const [traceMode, setTraceMode] = useState<'both' | 'upstream' | 'downstream'>('both');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>();
  const [isConnecting, setIsConnecting] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const flowWrapperRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const nodeIdsRef = useRef<string[]>([]);
  // Where the next stage the toolbar creates should land, handed over as soon
  // as the graph comes back carrying it.
  const placementRef = useRef<XYPosition | null>(null);
  const knownNodeIdsRef = useRef<ReadonlySet<string>>(new Set());
  const activeNodeId = selectedNodeId ?? localSelectedNodeId;
  const selectedEdge = selectedEdgeId
    ? graph.edges.find((edge) => edge.id === selectedEdgeId)
    : undefined;
  const validation = useMemo(() => validateOperationGraph(graph), [graph]);
  const diagnosticsByNode = useMemo(() => {
    const map = new Map<string, OperationGraphDiagnostic[]>();
    for (const diagnostic of validation.diagnostics) {
      if (!diagnostic.nodeId) continue;
      const values = map.get(diagnostic.nodeId) ?? [];
      values.push(diagnostic);
      map.set(diagnostic.nodeId, values);
    }
    return map;
  }, [validation]);
  const nodesById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );
  const authoredVariables = graph.operationSnapshot?.header.variables;
  const snapshotVariables = useMemo((): GraphVariableOption[] => {
    if (authoredVariables === undefined) return [];
    const declared = Array.isArray(authoredVariables) ? authoredVariables : [authoredVariables];
    return declared
      .filter((variable) => Boolean(variable.name))
      .map((variable) => ({
        name: variable.name,
        editable: true,
        ...(variable.value !== undefined ? { value: variable.value } : {}),
      }));
  }, [authoredVariables]);
  const variables = suppliedVariables ?? snapshotVariables;
  const connectedEdgesByTarget = useMemo(() => {
    const map = new Map<string, OperationGraphEdge[]>();
    for (const edge of graph.edges) {
      const values = map.get(edge.target) ?? [];
      values.push(edge);
      map.set(edge.target, values);
    }
    for (const values of map.values()) values.sort((left, right) => left.inputIndex - right.inputIndex);
    return map;
  }, [graph.edges]);
  const nodeDimensions = useMemo(() => Object.fromEntries(Object.entries(measurements).flatMap(([id, size]) => (
    size.width !== undefined && size.height !== undefined
      ? [[id, { width: size.width, height: size.height }]]
      : []
  ))), [measurements]);
  const layout = useMemo(
    () => layoutOperationGraph(graph, { nodeDimensions, ...LAYOUT_OPTIONS }),
    [graph, nodeDimensions],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const searchMatchIds = useMemo(() => {
    if (!normalizedQuery) return [];
    return graph.nodes.filter((node) => {
      const parameterText = sourceSummary(node).map((summary) => summary.value).join(' ');
      const haystack = `${node.label} ${node.kind} ${node.sourcePath.join(' ')} ${parameterText}`.toLocaleLowerCase();
      return haystack.includes(normalizedQuery);
    }).map((node) => node.id);
  }, [graph.nodes, normalizedQuery]);
  const searchMatches = useMemo(() => new Set(searchMatchIds), [searchMatchIds]);

  useEffect(() => {
    setSearchMatchIndex(0);
  }, [normalizedQuery]);

  useEffect(() => {
    setSearchMatchIndex((index) => searchMatchIds.length > 0 ? Math.min(index, searchMatchIds.length - 1) : 0);
  }, [searchMatchIds.length]);

  useEffect(() => {
    if (!activeNodeId) return;
    const selectedMatchIndex = searchMatchIds.indexOf(activeNodeId);
    if (selectedMatchIndex >= 0) setSearchMatchIndex(selectedMatchIndex);
  }, [activeNodeId, searchMatchIds]);
  /**
   * Selecting a stage traces its whole lineage and fades the rest of the
   * canvas, because the question people bring to a sixty-stage graph is
   * almost always "where does this one go".
   */
  const relatedNodes = useMemo(() => {
    if (!activeNodeId) return new Set<string>();
    const upstream = traceMode !== 'downstream' ? findUpstream(graph, activeNodeId) : new Set<string>();
    const downstream = traceMode !== 'upstream' ? findDownstream(graph, activeNodeId) : new Set<string>();
    return new Set([...upstream, ...downstream]);
  }, [activeNodeId, graph, traceMode]);

  useEffect(() => {
    setLocalSelectedNodeId(selectedNodeId);
  }, [selectedNodeId]);

  useEffect(() => {
    if (selectedEdgeId && !graph.edges.some((edge) => edge.id === selectedEdgeId)) {
      setSelectedEdgeId(undefined);
    }
  }, [graph.edges, selectedEdgeId]);

  useEffect(() => () => {
    if (measurementFrameRef.current !== null) cancelAnimationFrame(measurementFrameRef.current);
  }, []);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    // The workbench mounts this panel before the drawer has finished opening,
    // so the first node measurement can land at zero size. React Flow then
    // hides every node and draws no connections until something else resizes.
    // Re-measuring whenever the panel's box changes covers that first frame.
    const observer = new ResizeObserver(() => updateNodeInternals(nodeIdsRef.current));
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateNodeInternals]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      // `Node` here is React Flow's node type, so name the DOM one explicitly.
      if (addMenuRef.current?.contains(event.target as globalThis.Node)) return;
      setAddMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAddMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [addMenuOpen]);

  useEffect(() => {
    const currentIds = new Set(graph.nodes.map((node) => node.id));
    const added = graph.nodes.filter((node) => !knownNodeIdsRef.current.has(node.id));
    // A placement belongs to the one stage the toolbar just made. It is claimed
    // the moment that stage arrives, and never carried into a later edit.
    const placement = added.length === 1 ? placementRef.current : null;
    if (added.length > 0) placementRef.current = null;
    knownNodeIdsRef.current = currentIds;
    setPositions((current) => {
      const next: Record<string, XYPosition> = {};
      let changed = false;
      for (const node of graph.nodes) {
        const currentPosition = current[node.id];
        const fallback = placement && added[0]?.id === node.id
          ? placement
          : layout[node.id] ?? { x: 0, y: 0 };
        next[node.id] = currentPosition ?? { x: fallback.x, y: fallback.y };
        if (!currentPosition) changed = true;
      }
      for (const id of Object.keys(current)) {
        if (!currentIds.has(id)) changed = true;
      }
      return changed ? next : current;
    });
  }, [graph.nodes, layout]);

  const selectNode = useCallback((nodeId: string | null): void => {
    setLocalSelectedNodeId(nodeId ?? undefined);
    onSelectNode?.(nodeId);
  }, [onSelectNode]);

  const focusNode = useCallback((nodeId: string | undefined): void => {
    if (!nodeId) return;
    const node = graphNodeForId(flowNodesRef.current, nodeId);
    if (!node) return;
    void fitView({ nodes: [node], padding: 0.55, duration: 220 });
    selectNode(nodeId);
  }, [fitView, selectNode]);

  const focusSearchMatch = useCallback((index: number): void => {
    if (searchMatchIds.length === 0) return;
    const nextIndex = (index + searchMatchIds.length) % searchMatchIds.length;
    setSearchMatchIndex(nextIndex);
    focusNode(searchMatchIds[nextIndex]);
  }, [focusNode, searchMatchIds]);

  const stepSearchMatch = useCallback((direction: -1 | 1): void => {
    const selectedMatchIndex = activeNodeId ? searchMatchIds.indexOf(activeNodeId) : -1;
    focusSearchMatch((selectedMatchIndex >= 0 ? selectedMatchIndex : searchMatchIndex) + direction);
  }, [activeNodeId, focusSearchMatch, searchMatchIds, searchMatchIndex]);

  const handleAddNode = useCallback((kind: OperationStageKind): void => {
    setAddMenuOpen(false);
    const rect = flowWrapperRef.current?.getBoundingClientRect();
    const centre = rect
      ? screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
      : { x: 0, y: 0 };
    const position: XYPosition = {
      x: centre.x - NEW_NODE_SIZE.width / 2,
      y: centre.y - NEW_NODE_SIZE.height / 2,
    };
    placementRef.current = position;
    onAddNode?.(kind, position);
    if (!onAddNode) onGraphChange?.({ type: 'add', kind, position });
  }, [onAddNode, onGraphChange, screenToFlowPosition]);

  const handleNodeChanges = useCallback((changes: NodeChange<FlowNode>[]): void => {
    const changedNodes = applyNodeChanges(changes, flowNodesRef.current);
    setPositions((current) => {
      const next: Record<string, XYPosition> = { ...current };
      let changed = false;
      for (const change of changes) {
        if (change.type !== 'position' || !change.position) continue;
        const previous = current[change.id];
        if (previous?.x === change.position.x && previous.y === change.position.y) continue;
        next[change.id] = change.position;
        changed = true;
      }
      return changed ? next : current;
    });
    for (const node of changedNodes) {
      if (!node.measured) continue;
      const width = canonicalDimension(node.measured.width);
      const height = canonicalDimension(node.measured.height);
      pendingMeasurementsRef.current[node.id] = { width, height };
    }
    if (measurementFrameRef.current === null) {
      measurementFrameRef.current = requestAnimationFrame(() => {
        measurementFrameRef.current = null;
        const pending = pendingMeasurementsRef.current;
        pendingMeasurementsRef.current = {};
        setMeasurements((currentMeasurements) => {
          const next = { ...currentMeasurements };
          let changed = false;
          for (const [id, measurement] of Object.entries(pending)) {
            const previous = currentMeasurements[id];
            if (previous?.width === measurement.width && previous?.height === measurement.height) continue;
            next[id] = measurement;
            changed = true;
          }
          return changed ? next : currentMeasurements;
        });
      });
    }
  }, []);

  const handleNodeDragStop = useCallback((_event: MouseEvent | TouchEvent, node: FlowNode): void => {
    onGraphChange?.({ type: 'move', nodeId: node.id, position: node.position });
  }, [onGraphChange]);

  const disconnectEdge = useCallback((edge: OperationGraphEdge): void => {
    if (readOnly) return;
    setSelectedEdgeId(undefined);
    if (onDisconnect) onDisconnect(edge);
    else onGraphChange?.({ type: 'disconnect', edge });
  }, [onDisconnect, onGraphChange, readOnly]);

  const disconnectEdgeById = useCallback((edgeId: string): void => {
    const edge = graph.edges.find((candidate) => candidate.id === edgeId);
    if (edge) disconnectEdge(edge);
  }, [disconnectEdge, graph.edges]);

  const handleConnect = useCallback((connection: Connection): void => {
    if (!connectionIsValid(connection, graph)) return;
    const normalized = flowConnectionFromReactFlow(connection, graph);
    if (!normalized) return;
    setSelectedEdgeId(undefined);
    if (onConnect) onConnect(normalized);
    else onGraphChange?.({ type: 'connect', connection: normalized });
  }, [graph, onConnect, onGraphChange]);

  const handleReconnect = useCallback((oldEdge: FlowEdge, connection: Connection): void => {
    if (!connectionIsValid(connection, graph, oldEdge.id)) return;
    const normalized = flowConnectionFromReactFlow(connection, graph);
    const previous = graph.edges.find((edge) => edge.id === oldEdge.id);
    if (!normalized || !previous) return;
    setSelectedEdgeId(undefined);
    if (onReconnect) onReconnect(previous, normalized);
    else onGraphChange?.({ type: 'reconnect', previous, connection: normalized });
  }, [graph, onGraphChange, onReconnect]);

  const handleEdgesDelete = useCallback((deletedEdges: FlowEdge[]): void => {
    for (const deleted of deletedEdges) {
      const edge = graph.edges.find((candidate) => candidate.id === deleted.id);
      if (!edge) continue;
      disconnectEdge(edge);
    }
  }, [disconnectEdge, graph.edges]);

  const handleNodesDelete = useCallback((deletedNodes: FlowNode[]): void => {
    for (const deleted of deletedNodes) {
      const node = graph.nodes.find((candidate) => candidate.id === deleted.id);
      if (!node || node.kind === 'output' || node.locked) continue;
      if (onDeleteNode) onDeleteNode(node.id);
      else onGraphChange?.({ type: 'delete', nodeId: node.id });
    }
  }, [graph.nodes, onDeleteNode, onGraphChange]);

  const arrange = useCallback((): void => {
    const arranged = layoutOperationGraph(graph, { nodeDimensions, ...LAYOUT_OPTIONS });
    const next: Record<string, XYPosition> = {};
    for (const [id, position] of Object.entries(arranged)) next[id] = { x: position.x, y: position.y };
    setPositions(next);
    onAutoArrange?.();
    onGraphChange?.({ type: 'arrange', positions: next });
    void fitView({ padding: 0.2, duration: 250 });
  }, [fitView, graph, nodeDimensions, onAutoArrange, onGraphChange]);

  const handleDelete = useCallback((): void => {
    if (readOnly) return;
    if (activeNodeId) {
      const node = graph.nodes.find((candidate) => candidate.id === activeNodeId);
      if (node && node.kind !== 'output' && !node.locked) {
        onDeleteNode?.(activeNodeId);
        if (!onDeleteNode) onGraphChange?.({ type: 'delete', nodeId: activeNodeId });
        return;
      }
    }
    if (selectedEdge) disconnectEdge(selectedEdge);
  }, [activeNodeId, disconnectEdge, graph.nodes, onDeleteNode, onGraphChange, readOnly, selectedEdge]);

  const handleDuplicate = useCallback((): void => {
    if (readOnly || !activeNodeId) return;
    const node = graph.nodes.find((candidate) => candidate.id === activeNodeId);
    if (!node || node.kind === 'output' || node.locked) return;
    onDuplicateNode?.(activeNodeId);
    if (!onDuplicateNode) onGraphChange?.({ type: 'duplicate', nodeId: activeNodeId });
  }, [activeNodeId, graph.nodes, onDuplicateNode, onGraphChange, readOnly]);

  const handleCanvasKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.tagName === 'BUTTON' || target.isContentEditable) {
      if (event.key === 'Enter' && target.classList.contains('operation-graph-search-input') && searchMatchIds.length > 0) {
        event.preventDefault();
        const selectedMatchIndex = activeNodeId ? searchMatchIds.indexOf(activeNodeId) : -1;
        focusSearchMatch(selectedMatchIndex >= 0 ? selectedMatchIndex + 1 : searchMatchIndex);
      }
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      handleDelete();
    } else if (event.key.toLocaleLowerCase() === 'f') {
      event.preventDefault();
      focusNode(activeNodeId);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === 'd') {
      event.preventDefault();
      handleDuplicate();
    }
  };

  const flowNodes = useMemo((): FlowNode[] => graph.nodes.map((node) => {
    const defaultPosition = layout[node.id] ?? { x: 0, y: 0 };
    const isActive = activeNodeId === node.id;
    const emphasis: FlowNodeData['emphasis'] = isActive
      ? 'active'
      // A stage with no connections traces only itself, and greying the whole
      // canvas to say so would read as a fault rather than an answer.
      : relatedNodes.size > 1
        ? relatedNodes.has(node.id) ? 'related' : 'dimmed'
        : 'normal';
    return {
      id: node.id,
      type: 'operation',
      position: positions[node.id] ?? { x: defaultPosition.x, y: defaultPosition.y },
      ...(measurements[node.id] ? { measured: measurements[node.id] } : {}),
      data: {
        graphNode: node,
        nodesById,
        connectedEdges: connectedEdgesByTarget.get(node.id) ?? [],
        diagnostics: diagnosticsByNode.get(node.id) ?? [],
        variables,
        textureOptions: textureOptions ?? [],
        ...(onPreviewNode ? (() => {
          const previewUrl = onPreviewNode(node.id);
          return previewUrl ? { previewUrl } : {};
        })() : {}),
        readOnly,
        onSelectNode: selectNode,
        onGraphChange,
        onUpdateParameter,
        onReorderInput,
        onOpenTextureEditor,
        onOpenSelectEditor,
        onOpenStickerEditor,
        onExportNode,
        emphasis,
        searchMatch: !normalizedQuery || searchMatches.has(node.id),
      },
      className: `${operationNodeClass(node)} operation-graph-emphasis-${emphasis}`,
      selected: isActive,
      // A selected card grows an editor and opens dropdowns, both of which have
      // to draw over its neighbours rather than be clipped behind them.
      ...(isActive ? { zIndex: SELECTED_NODE_Z_INDEX } : {}),
      draggable: !readOnly && node.kind !== 'output',
    };
  }), [activeNodeId, connectedEdgesByTarget, diagnosticsByNode, graph.nodes, layout, measurements, nodesById, normalizedQuery, onExportNode, onGraphChange, onOpenSelectEditor, onOpenStickerEditor, onOpenTextureEditor, onPreviewNode, onReorderInput, onUpdateParameter, positions, readOnly, relatedNodes, searchMatches, selectNode, textureOptions, variables]);

  const flowEdges = useMemo((): FlowEdge[] => graph.edges.map((edge) => {
    const onPath = relatedNodes.has(edge.source) && relatedNodes.has(edge.target);
    const traced = relatedNodes.size > 1 && onPath;
    const direct = edge.source === activeNodeId || edge.target === activeNodeId;
    const selected = edge.id === selectedEdgeId;
    const sourceLabel = nodesById.get(edge.source)?.label ?? edge.source;
    const targetLabel = nodesById.get(edge.target)?.label ?? edge.target;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle,
      targetHandle: edge.targetHandle,
      type: 'operation',
      data: { portType: edge.type, sourceLabel, targetLabel, traced, direct, readOnly, onDisconnect: disconnectEdgeById },
      selected,
      interactionWidth: EDGE_INTERACTION_WIDTH,
      markerEnd: EDGE_ARROW_MARKERS[edge.type],
      ariaLabel: `${sourceLabel} to ${targetLabel}, ${portTypeLabel(edge.type)} connection`,
      className: [
        portTypeClass(edge.type),
        relatedNodes.size <= 1 || onPath ? 'operation-graph-edge-highlighted' : 'operation-graph-edge-dimmed',
        traced ? 'operation-graph-edge-traced' : '',
        direct ? 'operation-graph-edge-direct' : '',
      ].filter(Boolean).join(' '),
      animated: false,
    };
  }), [activeNodeId, disconnectEdgeById, graph.edges, nodesById, readOnly, relatedNodes, selectedEdgeId]);

  const flowNodesRef = useRef<FlowNode[]>(flowNodes);
  flowNodesRef.current = flowNodes;
  nodeIdsRef.current = graph.nodes.map((node) => node.id);

  const stageCount = graph.nodes.filter((node) => node.kind !== 'output').length;
  const errorCount = validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;

  return (
    <div ref={canvasRef} className="operation-graph-editor" tabIndex={0} onKeyDown={handleCanvasKeyDown}>
      <div className="operation-graph-toolbar">
        <div className="operation-graph-toolbar-title">
          <strong>Operation graph</strong>
          <span className="operation-graph-count">{stageCount} stage{stageCount === 1 ? '' : 's'}</span>
          {errorCount > 0 && (
            <span className="operation-graph-invalid-count" title="This draft is not serializable yet">
              <AlertTriangle size={12} /> {errorCount}
            </span>
          )}
        </div>
        <div className="operation-graph-search" role="search" title="Search nodes by name, type, or source path">
          <Search size={13} />
          <input
            className="operation-graph-search-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find nodes"
            aria-label="Find nodes"
          />
          {normalizedQuery && (
            <>
              <span className="operation-graph-match-count">
                {searchMatchIds.length > 0 ? searchMatchIndex + 1 : 0}/{searchMatchIds.length}
              </span>
              <button type="button" className="operation-graph-search-step" title="Previous match" aria-label="Previous search match" onClick={() => stepSearchMatch(-1)} disabled={searchMatchIds.length === 0}><ChevronUp size={12} /></button>
              <button type="button" className="operation-graph-search-step" title="Next match (Enter)" aria-label="Next search match" onClick={() => stepSearchMatch(1)} disabled={searchMatchIds.length === 0}><ChevronDown size={12} /></button>
            </>
          )}
          {query && <button type="button" className="operation-graph-search-clear" title="Clear search" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>}
        </div>
        <div className="operation-graph-toolbar-actions">
          <div className="operation-graph-toolbar-group">
            <button type="button" className="operation-graph-toolbar-button" title="Focus selected stage (F)" onClick={() => focusNode(activeNodeId)} disabled={!activeNodeId}><Focus size={14} /><span>Focus</span></button>
            <div className="operation-graph-trace" role="group" aria-label="Trace direction">
              {TRACE_OPTIONS.map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  title={option.title}
                  aria-label={option.title}
                  aria-pressed={traceMode === option.mode}
                  data-active={traceMode === option.mode ? 'true' : undefined}
                  disabled={!activeNodeId}
                  onClick={() => setTraceMode(option.mode)}
                >
                  {option.mode === 'both' ? <Waypoints size={13} aria-hidden /> : null}
                  {option.mode === 'upstream' ? <ArrowUp size={13} aria-hidden /> : null}
                  {option.mode === 'downstream' ? <ArrowDown size={13} aria-hidden /> : null}
                  <span>{option.label}</span>
                </button>
              ))}
            </div>
            <button type="button" className="operation-graph-toolbar-button" title="Arrange stages automatically" onClick={arrange}><LayoutDashboard size={14} /><span>Arrange</span></button>
          </div>
          {!readOnly && (
            <div className="operation-graph-toolbar-group">
              <button type="button" className="operation-graph-toolbar-button" title="Duplicate selected stage (Ctrl+D)" onClick={handleDuplicate} disabled={!activeNodeId}><Copy size={14} /><span>Duplicate</span></button>
              <button type="button" className="operation-graph-toolbar-button" title="Delete the selected stage or connection (Delete)" onClick={handleDelete} disabled={!activeNodeId && !selectedEdge}><Trash2 size={14} /><span>Delete</span></button>
              <div className="operation-graph-add-menu" ref={addMenuRef}>
                <button type="button" className="operation-graph-toolbar-button operation-graph-add-button" aria-haspopup="menu" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((open) => !open)}><Plus size={14} /> <span>Add stage</span><ChevronDown size={12} /></button>
                {addMenuOpen && (
                  <div className="operation-graph-add-popover" role="menu">
                    {STAGE_OPTIONS.map((option) => (
                      <button type="button" key={option.kind} role="menuitem" className={`operation-graph-node-${option.kind.replaceAll('_', '-')}`} onClick={() => handleAddNode(option.kind)}>
                        <span className="operation-graph-add-glyph"><NodeKindIcon kind={option.kind} /></span>
                        <span>{option.label}<small>{option.description}</small></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
      <div
        ref={flowWrapperRef}
        className="operation-graph-canvas"
        role="application"
        aria-label="Warpaint operation graph"
        data-connecting={isConnecting ? 'true' : 'false'}
      >
        <ReactFlow<FlowNode, FlowEdge>
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={handleNodeChanges}
          onNodeClick={(_event, node) => { setSelectedEdgeId(undefined); selectNode(node.id); }}
          onEdgeClick={(_event, edge) => { selectNode(null); setSelectedEdgeId(edge.id); }}
          onPaneClick={() => { setSelectedEdgeId(undefined); selectNode(null); }}
          onNodeDragStop={handleNodeDragStop}
          onConnect={handleConnect}
          onConnectStart={() => { setSelectedEdgeId(undefined); setIsConnecting(true); }}
          onConnectEnd={() => setIsConnecting(false)}
          onReconnect={handleReconnect}
          onReconnectStart={() => { setSelectedEdgeId(undefined); setIsConnecting(true); }}
          onReconnectEnd={() => setIsConnecting(false)}
          onNodesDelete={handleNodesDelete}
          onEdgesDelete={handleEdgesDelete}
          isValidConnection={(connection) => connectionIsValid(connection, graph)}
          nodesConnectable={!readOnly}
          nodesDraggable={!readOnly}
          elementsSelectable
          edgesFocusable
          edgesReconnectable={!readOnly}
          connectionRadius={CONNECTION_RADIUS}
          reconnectRadius={RECONNECT_RADIUS}
          connectionLineType={ConnectionLineType.SmoothStep}
          connectionLineStyle={CONNECTION_LINE_STYLE}
          deleteKeyCode={null}
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          minZoom={0.08}
          maxZoom={2.5}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          proOptions={PRO_OPTIONS}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap position="bottom-right" pannable zoomable />
        </ReactFlow>
      </div>
      <footer className="operation-graph-footer">
        <span>
          {readOnly
            ? 'Read-only graph'
            : isConnecting
              ? 'Release on a highlighted input to connect'
              : selectedEdge
                ? 'Connection selected. Delete removes it, or drag either end to move it.'
                : activeNodeId
                  ? 'Traced connections animate toward where this stage feeds. Drag from a port to connect.'
                  : 'Select a node to edit its values and trace its path. Drag from a port to connect.'}
        </span>
      </footer>
    </div>
  );
}

/** Standalone operation graph canvas. The workbench owns persistence and graph mutations. */
export function OperationGraphEditor(props: OperationGraphEditorProps): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <OperationGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
