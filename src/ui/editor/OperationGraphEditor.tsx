import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getViewportForBounds,
  useReactFlow,
  useUpdateNodeInternals,
  type Connection,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Copy,
  Focus,
  LayoutDashboard,
  Plus,
  Search,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react';
import '@xyflow/react/dist/style.css';

import {
  layoutOperationGraph,
  validateOperationGraph,
  type OperationGraphDiagnostic,
  type OperationGraphEdge,
  type OperationStageKind,
} from '../../editor/graph';
import type { GraphVariableOption } from './operationGraphFieldValues';
import { OperationFlowEdge } from './OperationFlowEdge';
import { NodeKindIcon, OperationFlowNode } from './OperationFlowNode';
import {
  canonicalDimension,
  connectionIsValid,
  flowConnectionFromReactFlow,
  portTypeClass,
  portTypeLabel,
  sameFlowNodeData,
  sourceSummary,
  traceNodes,
} from './operationGraphFlowModel';
import {
  CONNECTION_LINE_STYLE,
  CONNECTION_RADIUS,
  DEFAULT_EDGE_OPTIONS,
  EDGE_ARROW_MARKERS,
  EDGE_INTERACTION_WIDTH,
  FIT_VIEW_OPTIONS,
  LAYOUT_OPTIONS,
  NEW_NODE_SIZE,
  NO_ITEMS,
  PRO_OPTIONS,
  RECONNECT_RADIUS,
  SELECTED_NODE_Z_INDEX,
  STAGE_OPTIONS,
  TRACE_OPTIONS,
  type FlowEdge,
  type FlowNode,
  type FlowNodeData,
  type OperationGraphEditorProps,
} from './operationGraphTypes';
import { Button } from '../primitives/Button';
import { cn } from '../primitives/cn';
import { Input } from '../primitives/Input';
import { ToggleGroup } from '../primitives/ToggleGroup';
import { EDITOR_BUTTON, EDITOR_HEAD, EDITOR_NOTE, EDITOR_TITLE } from './editorStyles';
import './operationGraph.css';

export type {
  OperationGraphEditorChange,
  OperationGraphEditorProps,
  OperationGraphExportFormat,
} from './operationGraphTypes';

const NODE_TYPES = Object.freeze({ operation: OperationFlowNode });

const EDGE_TYPES = Object.freeze({ operation: OperationFlowEdge });

const SEARCH_BUTTON = 'size-5 flex-none';
const TOOLBAR_GROUP = 'flex items-center gap-1 border-l border-border pl-2 first:border-l-0 first:pl-0';
// Narrow, the icons alone carry the toolbar. Their titles still name them.
const TOOLBAR_LABEL = '@max-[600px]:hidden';
// In the drawer these give up their labels first, so that the toolbar keeps to one row and the canvas its height.
const TOOLBAR_LABEL_SECONDARY = '@max-[800px]:hidden';
const FOCUS_AFTER_SELECT_MS = 120;
const FOCUS_MAX_ZOOM = 1.3;
const GRAPH_MIN_ZOOM = 0.08;

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
    paintNames,
    onSelectKit,
    readOnly = false,
  } = props;
  const { fitView, screenToFlowPosition, setViewport } = useReactFlow<FlowNode, FlowEdge>();
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
  const flowNodesRef = useRef<FlowNode[]>([]);
  // Spot for the stage the toolbar is adding; consumed when that stage arrives.
  const placementRef = useRef<XYPosition | null>(null);
  const knownNodeIdsRef = useRef<ReadonlySet<string>>(new Set());
  const activeNodeId = selectedNodeId ?? localSelectedNodeId;
  const selectedEdge = selectedEdgeId
    ? graph.edges.find((edge) => edge.id === selectedEdgeId)
    : undefined;
  if (selectedEdgeId && !selectedEdge) setSelectedEdgeId(undefined);
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
  const searchCurrentId = normalizedQuery ? searchMatchIds[searchMatchIndex] : undefined;

  const [searchSync, setSearchSync] = useState({ query: normalizedQuery, ids: searchMatchIds, activeNodeId });
  if (searchSync.query !== normalizedQuery || searchSync.ids !== searchMatchIds || searchSync.activeNodeId !== activeNodeId) {
    setSearchSync({ query: normalizedQuery, ids: searchMatchIds, activeNodeId });
    // A new query starts at the first match, a shorter list clamps the cursor, and a selected match takes it over.
    let nextIndex = searchSync.query !== normalizedQuery ? 0 : searchMatchIndex;
    if (searchSync.ids.length !== searchMatchIds.length) {
      nextIndex = searchMatchIds.length > 0 ? Math.min(nextIndex, searchMatchIds.length - 1) : 0;
    }
    const selectedMatchIndex = activeNodeId ? searchMatchIds.indexOf(activeNodeId) : -1;
    setSearchMatchIndex(selectedMatchIndex >= 0 ? selectedMatchIndex : nextIndex);
  }
  /** Selecting a stage traces its lineage and fades the rest of the canvas. */
  const relatedNodes = useMemo(() => {
    if (!activeNodeId) return new Set<string>();
    const upstream = traceMode !== 'downstream' ? traceNodes(graph, activeNodeId, 'upstream') : new Set<string>();
    const downstream = traceMode !== 'upstream' ? traceNodes(graph, activeNodeId, 'downstream') : new Set<string>();
    return new Set([...upstream, ...downstream]);
  }, [activeNodeId, graph, traceMode]);

  const [syncedSelectedNodeId, setSyncedSelectedNodeId] = useState(selectedNodeId);
  if (syncedSelectedNodeId !== selectedNodeId) {
    setSyncedSelectedNodeId(selectedNodeId);
    setLocalSelectedNodeId(selectedNodeId);
  }

  useEffect(() => () => {
    if (measurementFrameRef.current !== null) cancelAnimationFrame(measurementFrameRef.current);
  }, []);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    // The panel mounts before the drawer opens, so the first measurement can be zero-size.
    // Re-measuring on every resize recovers from that first frame.
    const observer = new ResizeObserver(() => updateNodeInternals(nodeIdsRef.current));
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateNodeInternals]);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      // `Node` here is React Flow's node type, so name the DOM one explicitly.
      const target = event.target;
      if (target instanceof globalThis.Node && addMenuRef.current?.contains(target)) return;
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
    // The placement belongs to the one stage the toolbar just made, so claim it on arrival.
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
    selectNode(nodeId);
    // Selecting opens the stage's fields. React Flow's own measure can lag behind that, so the card itself is read, once it has rendered.
    window.setTimeout(() => {
      const card = canvasRef.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
      const current = graphNodeForId(flowNodesRef.current, nodeId);
      const canvas = flowWrapperRef.current;
      if (!card || !current || !canvas) return;
      // Centred and capped, as a card's menus scale with the zoom. A card too tall for the cap fits at less.
      void setViewport(getViewportForBounds({ ...current.position, width: card.offsetWidth, height: card.offsetHeight }, canvas.clientWidth, canvas.clientHeight, GRAPH_MIN_ZOOM, FOCUS_MAX_ZOOM, 0.55), { duration: 220 });
    }, FOCUS_AFTER_SELECT_MS);
  }, [selectNode, setViewport]);

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
      if (event.key === 'Enter' && target.dataset.slot === 'graph-search-input' && searchMatchIds.length > 0) {
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

  // Unchanged node data keeps its identity, so memoized cards skip renders during drags.
  // Node objects stay new: React Flow mutates selection state and relies on fresh nodes.
  const nodeData = useMemo((): FlowNodeData[] => graph.nodes.map((node): FlowNodeData => {
    const isActive = activeNodeId === node.id;
    const emphasis: FlowNodeData['emphasis'] = isActive
      ? 'active'
      // Greying the canvas for a stage with no connections would read as a fault.
      : relatedNodes.size > 1
        ? relatedNodes.has(node.id) ? 'related' : 'dimmed'
        : 'normal';
    return {
      graphNode: node,
      nodesById,
      connectedEdges: connectedEdgesByTarget.get(node.id) ?? NO_ITEMS,
      diagnostics: diagnosticsByNode.get(node.id) ?? NO_ITEMS,
      variables,
      textureOptions: textureOptions ?? NO_ITEMS,
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
      paintNames,
      onSelectKit,
      emphasis,
      searchMatch: normalizedQuery ? searchMatches.has(node.id) : undefined,
      searchCurrent: node.id === searchCurrentId,
    };
  }), [activeNodeId, connectedEdgesByTarget, diagnosticsByNode, graph.nodes, nodesById, normalizedQuery, searchCurrentId, onExportNode, onGraphChange, onOpenSelectEditor, onOpenStickerEditor, onOpenTextureEditor, onPreviewNode, onReorderInput, onSelectKit, onUpdateParameter, paintNames, readOnly, relatedNodes, searchMatches, selectNode, textureOptions, variables]);
  const [stableNodeData, setStableNodeData] = useState<{ raw: FlowNodeData[]; stable: FlowNodeData[] }>(
    () => ({ raw: [], stable: [] }),
  );
  let stableData = stableNodeData.stable;
  if (stableNodeData.raw !== nodeData) {
    const previousById = new Map(stableNodeData.stable.map((data) => [data.graphNode.id, data]));
    stableData = nodeData.map((data) => {
      const previous = previousById.get(data.graphNode.id);
      return previous && sameFlowNodeData(previous, data) ? previous : data;
    });
    setStableNodeData({ raw: nodeData, stable: stableData });
  }
  const flowNodes = useMemo((): FlowNode[] => stableData.map((data): FlowNode => {
    const node = data.graphNode;
    const defaultPosition = layout[node.id] ?? { x: 0, y: 0 };
    const isActive = data.emphasis === 'active';
    return {
      id: node.id,
      type: 'operation',
      position: positions[node.id] ?? { x: defaultPosition.x, y: defaultPosition.y },
      ...(measurements[node.id] ? { measured: measurements[node.id] } : {}),
      data,
      selected: isActive,
      // Selected cards open editors and dropdowns, which must draw over their neighbours.
      ...(isActive ? { zIndex: SELECTED_NODE_Z_INDEX } : {}),
      draggable: !readOnly && node.kind !== 'output',
    };
  }), [layout, measurements, positions, readOnly, stableData]);

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
        (relatedNodes.size <= 1 || onPath) && (!normalizedQuery || (searchMatches.has(edge.source) && searchMatches.has(edge.target))) ? '' : 'opacity-14',
        traced ? 'graph-edge-traced' : '',
        direct ? 'graph-edge-direct' : '',
      ].filter(Boolean).join(' '),
      animated: false,
    };
  }), [activeNodeId, disconnectEdgeById, graph.edges, nodesById, normalizedQuery, readOnly, relatedNodes, searchMatches, selectedEdgeId]);

  useLayoutEffect(() => {
    flowNodesRef.current = flowNodes;
    nodeIdsRef.current = graph.nodes.map((node) => node.id);
  }, [flowNodes, graph.nodes]);

  const stageCount = graph.nodes.filter((node) => node.kind !== 'output').length;
  const errorCount = validation.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;

  return (
    <div ref={canvasRef} className="@container flex h-full min-h-0 min-w-0 flex-1 flex-col bg-panel text-11 text-text outline-none" data-slot="graph-editor" tabIndex={0} onKeyDown={handleCanvasKeyDown}>
      <div className={cn(EDITOR_HEAD, 'bg-panel')} data-slot="graph-toolbar">
        <div className="flex min-w-max items-baseline gap-1.75 @max-[600px]:hidden">
          <strong className={EDITOR_TITLE}>Operation Graph</strong>
          <span className={cn(EDITOR_NOTE, 'font-normal tabular-nums @max-[800px]:hidden')}>{stageCount} stage{stageCount === 1 ? '' : 's'}</span>
          {errorCount > 0 && (
            <span className="inline-flex items-center gap-0.75 self-center text-10 text-fail tabular-nums" title="This draft is not serializable yet">
              <AlertCircle size={12} /> {errorCount}
            </span>
          )}
        </div>
        <div className="flex min-h-control max-w-75 min-w-30 flex-[1_1_100px] items-center gap-1.5 rounded-sm border border-border bg-panel pr-1 pl-2 text-dim transition-fast hover:border-strong has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 has-[input:focus-visible]:outline-accent" role="search" title="Search stages by name, type, or source path">
          <Search className="flex-none" size={14} />
          <Input
            className="h-6.5 min-h-0 min-w-0 flex-1 border-0 bg-transparent p-0 [font-family:inherit] text-11 text-text placeholder:text-dim focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
            data-slot="graph-search-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find stages..."
            aria-label="Find stages"
          />
          {normalizedQuery && (
            <>
              <span className="flex-none text-10 text-dim tabular-nums">
                {searchMatchIds.length > 0 ? searchMatchIndex + 1 : 0} of {searchMatchIds.length}
              </span>
              <Button variant="ghost" size="icon-sm" className={SEARCH_BUTTON} title="Previous match" aria-label="Previous search match" onClick={() => stepSearchMatch(-1)} disabled={searchMatchIds.length === 0}><ChevronUp size={12} /></Button>
              <Button variant="ghost" size="icon-sm" className={SEARCH_BUTTON} title="Next match (Enter)" aria-label="Next search match" onClick={() => stepSearchMatch(1)} disabled={searchMatchIds.length === 0}><ChevronDown size={12} /></Button>
            </>
          )}
          {query && <Button variant="ghost" size="icon-sm" className={SEARCH_BUTTON} title="Clear search" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></Button>}
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2 @max-[620px]:ml-0 @max-[620px]:w-full">
          <div className={TOOLBAR_GROUP}>
            <Button size="compact" className={EDITOR_BUTTON} title="Focus selected stage (F)" onClick={() => focusNode(activeNodeId)} disabled={!activeNodeId}><Focus size={14} /><span className={TOOLBAR_LABEL_SECONDARY}>Focus</span></Button>
            <ToggleGroup
              size="inline"
              label="Trace direction"
              value={traceMode}
              onChange={setTraceMode}
              options={TRACE_OPTIONS.map((option) => ({
                value: option.mode,
                title: option.title,
                ariaLabel: option.title,
                disabled: !activeNodeId,
                label: (
                  <>
                    {option.mode === 'both' ? <Waypoints size={13} aria-hidden /> : null}
                    {option.mode === 'upstream' ? <ArrowUp size={13} aria-hidden /> : null}
                    {option.mode === 'downstream' ? <ArrowDown size={13} aria-hidden /> : null}
                    <span className={TOOLBAR_LABEL}>{option.label}</span>
                  </>
                ),
              }))}
            />
            <Button size="compact" className={EDITOR_BUTTON} title="Arrange stages automatically" onClick={arrange}><LayoutDashboard size={14} /><span className={TOOLBAR_LABEL_SECONDARY}>Arrange</span></Button>
          </div>
          {!readOnly && (
            <div className={TOOLBAR_GROUP}>
              <Button size="compact" className={EDITOR_BUTTON} title="Duplicate selected stage (Ctrl+D)" onClick={handleDuplicate} disabled={!activeNodeId}><Copy size={14} /><span className={TOOLBAR_LABEL_SECONDARY}>Duplicate</span></Button>
              <Button variant="danger" size="compact" className={EDITOR_BUTTON} title="Delete the selected stage or connection (Delete)" onClick={handleDelete} disabled={!activeNodeId && !selectedEdge}><Trash2 size={14} /><span className={TOOLBAR_LABEL_SECONDARY}>Delete</span></Button>
              <div className="relative" ref={addMenuRef}>
                <Button variant="accent" size="compact" className={cn(EDITOR_BUTTON, 'aria-expanded:bg-accent aria-expanded:text-accent-text')} data-slot="graph-add-stage" aria-haspopup="menu" aria-expanded={addMenuOpen} onClick={() => setAddMenuOpen((open) => !open)}><Plus size={14} /> <span>Add Stage</span><ChevronDown size={12} /></Button>
                {addMenuOpen && (
                  <div className="absolute top-[calc(100%+5px)] right-0 z-1100 grid w-58 rounded-md border border-strong bg-panel p-1 shadow-pop" role="menu">
                    {STAGE_OPTIONS.map((option) => (
                      <button
                        type="button"
                        key={option.kind}
                        role="menuitem"
                        className="group flex cursor-pointer items-center gap-2 rounded-sm border-0 bg-transparent px-1.75 py-1.5 text-left text-text focus-ring hover:bg-accent hover:text-accent-text focus-visible:-outline-offset-2"
                        data-graph-kind={option.kind.replaceAll('_', '-')}
                        onClick={() => handleAddNode(option.kind)}
                      >
                        <span className="grid size-5 flex-none place-items-center rounded-sm border border-(--graph-kind)/45 bg-(--graph-kind)/12 text-(--graph-kind) group-hover:bg-panel"><NodeKindIcon kind={option.kind} /></span>
                        <span className="grid gap-px">{option.label}<small className="text-9 text-dim group-hover:text-inherit group-hover:opacity-72">{option.description}</small></span>
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
        className="group/canvas relative min-h-0 flex-auto bg-panel-2/40"
        data-slot="graph-canvas"
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
          minZoom={GRAPH_MIN_ZOOM}
          maxZoom={2.5}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          proOptions={PRO_OPTIONS}
        >
          <Background gap={24} size={1} />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap position="bottom-right" pannable zoomable maskStrokeWidth={1} />
        </ReactFlow>
      </div>
      <footer className="flex min-h-6 flex-none items-center gap-3 border-t border-border px-3 text-10.5 text-dim">
        <span>
          {readOnly
            ? 'Read-only graph'
            : isConnecting
              ? 'Release on a highlighted input to connect'
              : selectedEdge
                ? 'Connection selected. Delete removes it, or drag either end to move it.'
                : activeNodeId
                  ? 'Traced connections animate toward where this stage feeds. Drag from a port to connect.'
                  : 'Select a stage to edit its values and trace its path. Drag from a port to connect.'}
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
