import {
  MarkerType,
  type Edge,
  type Node,
  type XYPosition,
} from '@xyflow/react';
import type {
  OperationGraph,
  OperationGraphDiagnostic,
  OperationGraphEdge,
  OperationGraphNode,
  OperationGraphParameterAddress,
  OperationGraphParameterField,
  OperationGraphParameterValue,
  OperationPortType,
  OperationStageKind,
} from '../../editor/graph';
import type { VarFieldMsg } from '../../protodefs/messages';
import type {
  GraphComboboxOption,
  GraphFieldKind,
  GraphVariableOption,
} from './operationGraphFieldValues';

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
  readonly onUpdateParameter?: (
    nodeId: string,
    address: OperationGraphParameterAddress,
    value: OperationGraphParameterValue,
  ) => void;
  /** Every texture the viewer can offer, used by the on-node texture pickers. */
  readonly textureOptions?: readonly GraphComboboxOption[];
  /** Variables a parameter can bind to; defaults to the snapshot's, but the workbench passes a merged catalogue. */
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
  /** Stock paint names by id, listed under a selected operation template. */
  readonly paintNames?: ReadonlyMap<number, string>;
  readonly onSelectKit?: (id: number) => void;
  readonly readOnly?: boolean;
  readonly className?: string;
}

export interface FlowNodeData extends Record<string, unknown> {
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
  readonly paintNames?: ReadonlyMap<number, string>;
  readonly onSelectKit?: (id: number) => void;
  readonly emphasis: 'normal' | 'active' | 'related' | 'dimmed';
  /** Undefined while no search is typed. */
  readonly searchMatch?: boolean;
  /** The match the search's step buttons are on. */
  readonly searchCurrent?: boolean;
}

export type FlowNode = Node<FlowNodeData, 'operation'>;

export const NO_ITEMS: readonly never[] = Object.freeze([]);
export const TEMPLATE_USAGE_LIMIT = 10;

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

export type FlowEdge = Edge<FlowEdgeData, 'operation'>;

export const FIT_VIEW_OPTIONS = Object.freeze({ padding: 0.2 });
// Arrowheads live in a shared SVG <defs> keyed by literal color, so they
// cannot read the --graph-type-* tokens the lines use. Keep the two in step.
const PORT_COLORS = Object.freeze({
  texture: '#3b82b7',
  mask: '#8c5aaa',
  unknown: '#7b858f',
  none: '#7b858f',
});
export const EDGE_ARROW_MARKERS = Object.freeze({
  texture: Object.freeze({ type: MarkerType.ArrowClosed, width: 13, height: 13, color: PORT_COLORS.texture }),
  mask: Object.freeze({ type: MarkerType.ArrowClosed, width: 13, height: 13, color: PORT_COLORS.mask }),
  unknown: Object.freeze({ type: MarkerType.ArrowClosed, width: 13, height: 13, color: PORT_COLORS.unknown }),
  none: Object.freeze({ type: MarkerType.ArrowClosed, width: 13, height: 13, color: PORT_COLORS.none }),
});
export const DEFAULT_EDGE_OPTIONS = Object.freeze({
  type: 'operation' as const,
  markerEnd: EDGE_ARROW_MARKERS.unknown,
});
export const CONNECTION_LINE_STYLE = Object.freeze({ strokeWidth: 2 });
export const CONNECTION_RADIUS = 26;
export const RECONNECT_RADIUS = 28;
export const EDGE_INTERACTION_WIDTH = 26;
export const EDGE_CORNER_RADIUS = 10;
export const SELECTED_NODE_Z_INDEX = 900;
// Mirrors the CSS card width. The height is a guess; only used to centre a new card.
export const NEW_NODE_SIZE = Object.freeze({ width: 246, height: 132 });
export const PRO_OPTIONS = Object.freeze({ hideAttribution: true });
export const LAYOUT_OPTIONS = Object.freeze({ horizontalGap: 60, verticalGap: 26, outputGap: 76 });

export const TRACE_OPTIONS: readonly {
  readonly mode: 'both' | 'upstream' | 'downstream';
  readonly label: string;
  readonly title: string;
}[] = [
  { mode: 'both', label: 'Both', title: 'Show inputs and outputs connected to this stage' },
  { mode: 'upstream', label: 'Inputs', title: 'Show only the stages feeding this stage' },
  { mode: 'downstream', label: 'Outputs', title: "Show only the stages receiving this stage's result" },
];

export const STAGE_OPTIONS: readonly { readonly kind: OperationStageKind; readonly label: string; readonly description: string }[] = [
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

/** Most stage fields are "min max" ranges resolved per paint seed, so they get a range control. */
export const PARAMETER_META: Readonly<Record<OperationGraphParameterField, ParameterMeta>> = {
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

export interface EditableParameter {
  readonly address: OperationGraphParameterAddress;
  readonly meta: ParameterMeta;
  readonly field?: VarFieldMsg;
  readonly primary?: boolean;
}
