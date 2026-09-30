import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Compositor } from '../compositor/compositor';
import type { DataSource } from '../data/loader';
import type { PaintkitEntry } from '../data/types';
import type { OperationNodeMsg, VarDefMsg } from '../protodefs/messages';
import { isSupportedTexturePath } from '../source/paths';
import type { SourceTextureProvider } from '../source/provider';
import { downloadBlob } from '../ui/common/download';
import type {
  OperationGraphEditorChange,
  OperationGraphExportFormat,
} from '../ui/workbench/OperationGraphEditor';
import type { GraphComboboxOption, GraphVariableOption } from '../ui/workbench/operationGraphFieldValues';
import type { ControlsState } from '../viewer/controls';
import {
  connectOperationGraph,
  deleteOperationGraphSubtree,
  disconnectOperationGraph,
  duplicateOperationGraphSubtree,
  operationGraphChildren,
  operationToGraph,
  composeOperationGraphNode,
  exportOperationGraphPng,
  exportOperationGraphVtf,
  operationGraphPreviewObjectUrl,
  reconnectOperationGraph,
  reorderOperationGraphInputs,
  createOperationGraphNode,
  setOperationGraphParameter,
  summarizeOperationGraphDiagnostics,
  validateOperationGraph,
  type OperationGraph,
  type OperationGraphDiagnostic,
  type OperationGraphEditResult,
  type OperationGraphParameterAddress,
  type OperationGraphParameterValue,
} from './graph';
import {
  boundOperationGraphVariable,
  graphNodeOperationPath,
  graphTextureRef,
  isRecordValue,
  operationGraphTextureRefs,
  operationMessageForGraph,
  varDefList,
} from './graph/graphBoundary';
import type { EditorCore } from './useEditorCore';
import type { EditorLayers } from './useEditorLayers';
import type { WorkbenchEditorProps } from './usePartsEditor';
import type { StickerEditor } from './useStickerEditor';

/** The graph slice of the workbench editor props. */
type GraphEditorProps = NonNullable<WorkbenchEditorProps['graph']>;

function downloadBytes(bytes: Uint8Array, fileName: string, mimeType: string): void {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  downloadBlob(new Blob([copy], { type: mimeType }), fileName);
}

interface UseOperationGraphEditorOptions extends
  Pick<EditorCore,
    | 'editableKitId'
    | 'editorStatus'
    | 'editorCurrent'
    | 'editorRevision'
    | 'provenanceRecipe'
    | 'paintSubView'
    | 'setPaintSubView'
    | 'setEditorTool'
    | 'replaceOperationGraph'
    | 'setDefinitionVariable'
  >,
  Pick<EditorLayers,
    | 'groupDiscovery'
    | 'transformDiscovery'
    | 'baseTextureTransform'
    | 'editableGroupTargets'
    | 'setActiveEditorSelector'
    | 'setWeaponBaseLayerActive'
  >,
  Pick<StickerEditor, 'stickerTargets' | 'updateStickerDraft' | 'setActiveStickerTarget'> {
  state: ControlsState;
  data: DataSource | null;
  engineReady: boolean;
  compositorRef: React.RefObject<Compositor | null>;
  sourceProvider: SourceTextureProvider;
  packageGeneration: number;
  selectedKit: PaintkitEntry | null;
}

/**
 * The operation graph view of the working definition: the graph itself with
 * its draft and validation state, per-node preview renders, node export, the
 * jumps into the other editors, and the props for the Graph panel.
 */
export function useOperationGraphEditor({
  editableKitId,
  editorStatus,
  editorCurrent,
  editorRevision,
  provenanceRecipe,
  paintSubView,
  setPaintSubView,
  setEditorTool,
  replaceOperationGraph,
  setDefinitionVariable,
  groupDiscovery,
  transformDiscovery,
  baseTextureTransform,
  editableGroupTargets,
  setActiveEditorSelector,
  setWeaponBaseLayerActive,
  stickerTargets,
  updateStickerDraft,
  setActiveStickerTarget,
  state,
  data,
  engineReady,
  compositorRef,
  sourceProvider,
  packageGeneration,
  selectedKit,
}: UseOperationGraphEditorOptions) {
  const committedOperationGraph = useMemo<OperationGraph | null>(() => {
    if (!editorCurrent) return null;
    const operation = operationMessageForGraph(editorCurrent.operation);
    if (!operation) return null;
    try {
      return operationToGraph(operation);
    } catch {
      return null;
    }
  }, [editorCurrent]);
  const [operationGraphDraft, setOperationGraphDraft] = useState<{
    readonly revision: number;
    readonly graph: OperationGraph;
    readonly diagnostics: readonly OperationGraphDiagnostic[];
  } | null>(null);
  const [operationGraphEditError, setOperationGraphEditError] = useState<string | null>(null);
  const [selectedOperationGraphNodeId, setSelectedOperationGraphNodeId] = useState<string | null>(null);
  const [operationGraphPreviewUrls, setOperationGraphPreviewUrls] = useState<Record<string, string>>({});
  const operationGraphPreviewUrlLeasesRef = useRef(new Map<string, { url: string; dispose: () => void }>());
  const operationGraph = operationGraphDraft?.revision === editorRevision
    ? operationGraphDraft.graph
    : committedOperationGraph;
  /**
   * Texture choices for the graph's on-node pickers: what this graph already
   * uses, what the imported package carries, then everything the viewer ships.
   * Ordering matters more than completeness here, because the first group is
   * almost always the one someone is reaching for.
   */
  /**
   * Bindable variables, nearest scope first. A paint kit declares the ones an
   * operation's stages actually bind to, while an operation only declares its
   * own when it overrides a wear level, so both have to be offered.
   */
  const operationGraphVariables = useMemo<GraphVariableOption[]>(() => {
    const options: GraphVariableOption[] = [];
    const seen = new Set<string>();
    const push = (variable: VarDefMsg, scope: string, editable: boolean): void => {
      if (seen.has(variable.name)) return;
      seen.add(variable.name);
      options.push({
        name: variable.name,
        scope,
        editable,
        ...(variable.value !== undefined ? { value: variable.value } : {}),
      });
    };
    for (const variable of varDefList(operationGraph?.operationSnapshot?.header.variables)) {
      push(variable, 'This operation', true);
    }
    const definitionHeader = editorCurrent && isRecordValue(editorCurrent.definition.header)
      ? editorCurrent.definition.header
      : undefined;
    for (const variable of varDefList(definitionHeader?.variables)) push(variable, 'This paint kit', true);
    return options;
  }, [editorCurrent, operationGraph]);

  const operationGraphTextureOptions = useMemo<GraphComboboxOption[]>(() => {
    const options: GraphComboboxOption[] = [];
    const seen = new Set<string>();
    const push = (ref: string, group: string, secondary = false): void => {
      if (seen.has(ref)) return;
      seen.add(ref);
      const thumbnail = data?.manifest.textures?.[`textures/${ref}.webp`]
        ? `${import.meta.env.BASE_URL}data/thumbnails/textures/${ref}.webp`
        : undefined;
      options.push({
        value: ref,
        label: ref,
        group,
        ...(secondary ? { secondary: true } : {}),
        ...(thumbnail ? { thumbnailUrl: thumbnail } : {}),
      });
    };

    const pkg = sourceProvider.package;
    const packageRefs = new Set<string>();
    if (pkg) {
      for (const path of pkg.entries.keys()) {
        if (!isSupportedTexturePath(path)) continue;
        const ref = graphTextureRef(path);
        if (ref) packageRefs.add(ref);
      }
    }
    const exists = (ref: string): boolean => (
      packageRefs.has(ref) || data?.manifest.textures?.[`textures/${ref}.webp`] !== undefined
    );

    // What this paint already draws with, first: literal refs on its stages,
    // then the variable declarations that resolve to a real file. Templated
    // declarations such as a per-weapon albedo path name no single file, so
    // they are left out rather than offered as a dead choice.
    for (const ref of operationGraphTextureRefs(operationGraph)) push(ref, 'In this paint');
    for (const variable of operationGraphVariables) {
      const ref = variable.value ? graphTextureRef(variable.value) : null;
      if (ref && exists(ref)) push(ref, 'In this paint');
    }
    for (const ref of packageRefs) push(ref, pkg ? `From ${pkg.name}` : 'Imported package');
    for (const path of Object.keys(data?.manifest.textures ?? {})) {
      const ref = graphTextureRef(path);
      if (ref) push(ref, 'Shipped with the viewer', true);
    }
    return options;
    // packageGeneration changes whenever a different archive is mounted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.manifest.textures, operationGraph, operationGraphVariables, packageGeneration, sourceProvider]);
  useEffect(() => {
    setOperationGraphDraft(null);
    setOperationGraphEditError(null);
  }, [editableKitId, editorRevision]);

  useEffect(() => {
    setSelectedOperationGraphNodeId(null);
  }, [editableKitId]);

  useEffect(() => {
    if (!operationGraphEditError) return;
    const timeout = window.setTimeout(() => setOperationGraphEditError(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [operationGraphEditError]);

  const applyOperationGraphEdit = useCallback(<T,>(
    edit: (graph: OperationGraph) => OperationGraphEditResult<T>,
    onSuccess?: (value: T) => void,
  ): void => {
    if (!operationGraph) return;
    const result = edit(operationGraph);
    if (!result.ok) {
      const validation = validateOperationGraph(result.graph);
      setOperationGraphDraft({ revision: editorRevision, graph: result.graph, diagnostics: validation.diagnostics });
      setOperationGraphEditError(summarizeOperationGraphDiagnostics(result.diagnostics));
      return;
    }
    const validation = validateOperationGraph(result.graph);
    onSuccess?.(result.value);
    if (!validation.valid) {
      setOperationGraphDraft({ revision: editorRevision, graph: result.graph, diagnostics: validation.diagnostics });
      setOperationGraphEditError(summarizeOperationGraphDiagnostics(validation.diagnostics));
      return;
    }
    if (replaceOperationGraph(result.graph)) {
      setOperationGraphDraft(null);
      setOperationGraphEditError(null);
      return;
    }
    setOperationGraphDraft({ revision: editorRevision, graph: result.graph, diagnostics: validation.diagnostics });
    setOperationGraphEditError('The valid operation graph could not be serialized.');
  }, [editorRevision, operationGraph, replaceOperationGraph]);

  const updateOperationGraphRaw = useCallback((nodeId: string, raw: OperationNodeMsg): void => {
    if (!operationGraph) return;
    const node = operationGraph.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.locked) return;
    const next: OperationGraph = {
      ...operationGraph,
      nodes: operationGraph.nodes.map((candidate) => (
        candidate.id === nodeId ? { ...candidate, raw: structuredClone(raw) } : candidate
      )),
    };
    const validation = validateOperationGraph(next);
    if (!validation.valid) {
      setOperationGraphDraft({ revision: editorRevision, graph: next, diagnostics: validation.diagnostics });
      setOperationGraphEditError(summarizeOperationGraphDiagnostics(validation.diagnostics));
      return;
    }
    if (replaceOperationGraph(next)) {
      setOperationGraphDraft(null);
      setOperationGraphEditError(null);
    } else {
      setOperationGraphDraft({ revision: editorRevision, graph: next, diagnostics: validation.diagnostics });
      setOperationGraphEditError('The operation graph could not be serialized.');
    }
  }, [editorRevision, operationGraph, replaceOperationGraph]);

  const updateOperationGraphParameter = useCallback((
    nodeId: string,
    address: OperationGraphParameterAddress,
    value: OperationGraphParameterValue,
  ): void => {
    // Writing a bound parameter means writing its declaration. The graph layer
    // owns operation-scope variables; paint-kit ones live a level up, so route
    // those to the definition instead of failing the whole edit.
    if (value.mode === 'literal' && value.preserveVariable !== false && operationGraph) {
      const bound = boundOperationGraphVariable(operationGraph, nodeId, address);
      const declaredInOperation = varDefList(operationGraph.operationSnapshot?.header.variables)
        .some((variable) => variable.name === bound);
      if (bound && !declaredInOperation) {
        if (!setDefinitionVariable(bound, String(value.value))) return;
        setOperationGraphEditError(null);
        return;
      }
    }
    applyOperationGraphEdit((graph) => setOperationGraphParameter(graph, { nodeId, address, value }));
  }, [applyOperationGraphEdit, operationGraph, setDefinitionVariable]);

  const handleOperationGraphChange = useCallback((change: OperationGraphEditorChange): void => {
    if (!operationGraph) return;
    switch (change.type) {
      case 'move':
      case 'arrange':
        return;
      case 'connect':
        applyOperationGraphEdit((graph) => connectOperationGraph(
          graph,
          change.connection.source,
          change.connection.target,
          change.connection.inputIndex,
        ));
        return;
      case 'reconnect':
        applyOperationGraphEdit((graph) => reconnectOperationGraph(
          graph,
          change.previous.id,
          change.connection.source,
          change.connection.target,
          change.connection.inputIndex,
        ));
        return;
      case 'disconnect':
        applyOperationGraphEdit((graph) => disconnectOperationGraph(graph, change.edge.id));
        return;
      case 'add':
        applyOperationGraphEdit(
          (graph) => createOperationGraphNode(graph, change.kind),
          (value) => setSelectedOperationGraphNodeId(value.nodeId),
        );
        return;
      case 'duplicate':
        applyOperationGraphEdit(
          (graph) => duplicateOperationGraphSubtree(graph, change.nodeId),
          (value) => setSelectedOperationGraphNodeId(value.rootId),
        );
        return;
      case 'delete':
        applyOperationGraphEdit(
          (graph) => deleteOperationGraphSubtree(graph, change.nodeId, { allowInvalid: true }),
          (value) => {
            if (value.deletedNodeIds.includes(selectedOperationGraphNodeId ?? '')) {
              setSelectedOperationGraphNodeId(null);
            }
          },
        );
        return;
      case 'reorder': {
        const order = operationGraphChildren(operationGraph, change.nodeId);
        if (change.fromIndex < 0 || change.fromIndex >= order.length
          || change.toIndex < 0 || change.toIndex >= order.length) return;
        const nextOrder = [...order];
        const [moved] = nextOrder.splice(change.fromIndex, 1);
        if (moved === undefined) return;
        nextOrder.splice(change.toIndex, 0, moved);
        applyOperationGraphEdit((graph) => reorderOperationGraphInputs(graph, change.nodeId, nextOrder));
        return;
      }
    }
  }, [applyOperationGraphEdit, operationGraph, selectedOperationGraphNodeId]);
  useEffect(() => {
    const previewUrlLeases = operationGraphPreviewUrlLeasesRef.current;
    const disposePreviews = () => {
      for (const lease of previewUrlLeases.values()) lease.dispose();
      previewUrlLeases.clear();
      setOperationGraphPreviewUrls({});
    };
    disposePreviews();
    if (!operationGraph || paintSubView !== 'graph' || !provenanceRecipe || !engineReady) return;
    const compositor = compositorRef.current;
    if (!compositor) return;
    let cancelled = false;
    const previewNodes = operationGraph.nodes.filter((node) => (
      node.kind !== 'output'
      && node.kind !== 'operation_template'
      && node.kind !== 'invalid'
    ));
    const render = async (): Promise<void> => {
      let completedBatch: Record<string, string> = {};
      let completedBatchSize = 0;
      const publishBatch = (): void => {
        if (completedBatchSize === 0) return;
        const published = completedBatch;
        completedBatch = {};
        completedBatchSize = 0;
        setOperationGraphPreviewUrls((current) => ({ ...current, ...published }));
      };
      for (const node of previewNodes) {
        const result = await composeOperationGraphNode(compositor, {
          graph: operationGraph,
          nodeId: node.id,
          recipeRoots: provenanceRecipe.tree,
          seed: state.seed,
          dimensions: { width: 256, height: 256 },
        } as const);
        if (cancelled) {
          if (result.ok) result.render.dispose();
          return;
        }
        if (!result.ok) continue;
        try {
          const urlLease = await operationGraphPreviewObjectUrl(result.render, { maxDimension: 180 });
          if (cancelled) {
            urlLease.dispose();
            return;
          }
          previewUrlLeases.set(node.id, urlLease);
          completedBatch[node.id] = urlLease.url;
          completedBatchSize += 1;
          if (completedBatchSize >= 6) publishBatch();
        } catch {
          // Individual unsupported previews do not block the rest of the graph.
        } finally {
          result.render.dispose();
        }
      }
      if (!cancelled) publishBatch();
    };
    void render().catch(() => undefined);
    return () => {
      cancelled = true;
      disposePreviews();
    };
  }, [compositorRef, editorRevision, engineReady, operationGraph, paintSubView, state.seed, provenanceRecipe]);

  const exportOperationGraphNode = useCallback(async (
    nodeId: string,
    format: OperationGraphExportFormat,
  ): Promise<void> => {
    if (!operationGraph || !provenanceRecipe || !compositorRef.current) return;
    const result = await composeOperationGraphNode(compositorRef.current, {
      graph: operationGraph,
      nodeId,
      recipeRoots: provenanceRecipe.tree,
      seed: state.seed,
      dimensions: { width: 1024, height: 1024 },
    });
    if (!result.ok) return;
    const render = result.render;
    try {
      const node = operationGraph.nodes.find((candidate) => candidate.id === nodeId);
      const stage = node?.raw?.stage;
      const sourceField = stage?.texture_lookup?.texture
        ?? stage?.texture_lookup?.texture_red
        ?? stage?.texture_lookup?.texture_blue
        ?? stage?.select?.groups;
      const sourceHint = sourceField?.variable ?? sourceField?.string;
      const stageIndex = operationGraph.nodes
        .filter((candidate) => candidate.kind !== 'output')
        .findIndex((candidate) => candidate.id === nodeId) + 1;
      const parts = [
        selectedKit?.name ?? 'warpaint',
        state.weaponKey.replace(/^c_/, '') || 'weapon',
        state.team,
        data?.manifest.wearNames[state.wearIndex] ?? `wear-${state.wearIndex}`,
        `stage-${String(stageIndex).padStart(2, '0')}`,
        node?.label ?? 'operation',
        sourceHint?.replaceAll('\\', '/').split('/').at(-1),
      ];
      const fileBase = parts
        .filter((part): part is string => Boolean(part))
        .map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
        .filter(Boolean)
        .join('_')
        .slice(0, 160) || 'warpaint_stage';
      if (format === 'png') {
        downloadBytes(await exportOperationGraphPng(render, { maxDimension: 1024 }), `${fileBase}.png`, 'image/png');
      } else {
        downloadBytes(exportOperationGraphVtf(render), `${fileBase}.vtf`, 'application/octet-stream');
      }
    } catch (cause) {
      setOperationGraphEditError(cause instanceof Error ? cause.message : 'The graph node could not be exported.');
    } finally {
      render.dispose();
    }
  }, [compositorRef, data?.manifest.wearNames, operationGraph, selectedKit?.name, state.seed, state.team, state.wearIndex, state.weaponKey, provenanceRecipe]);
  const openOperationTextureNode = (nodeId: string): void => {
    const node = operationGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== 'texture_lookup') return;
    const stagePath = [...graphNodeOperationPath(node), 'stage', 'texture_lookup'];
    const samePath = (left: readonly string[] | undefined, right: readonly string[]) => (
      Boolean(left) && left!.join('\0') === right.join('\0')
    );
    if (baseTextureTransform && samePath(baseTextureTransform.transform.target.stagePath, stagePath)) {
      setWeaponBaseLayerActive(true);
      setPaintSubView('transform');
      setEditorTool('paint');
      return;
    }
    const targetIndex = transformDiscovery?.targets.findIndex((target) => (
      target !== null && samePath(target.target.stagePath, stagePath)
    )) ?? -1;
    if (targetIndex < 0 || !groupDiscovery) return;
    const groupTarget = groupDiscovery.targets[targetIndex];
    const selectorIndex = groupTarget
      ? editableGroupTargets.findIndex((target) => target.sourceKey === groupTarget.sourceKey)
      : -1;
    if (selectorIndex < 0) return;
    setWeaponBaseLayerActive(false);
    setActiveEditorSelector(selectorIndex);
    setPaintSubView('transform');
    setEditorTool('paint');
  };

  const openOperationSelectNode = (nodeId: string): void => {
    const node = operationGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== 'select' || !groupDiscovery) return;
    const selectNodes = operationGraph?.nodes.filter((candidate) => candidate.kind === 'select') ?? [];
    const operationIndex = selectNodes.findIndex((candidate) => candidate.id === node.id);
    const groupTarget = operationIndex >= 0 ? groupDiscovery.targets[operationIndex] : undefined;
    const selectorIndex = groupTarget
      ? editableGroupTargets.findIndex((target) => target.sourceKey === groupTarget.sourceKey)
      : -1;
    if (selectorIndex < 0) return;
    setWeaponBaseLayerActive(false);
    setActiveEditorSelector(selectorIndex);
    setPaintSubView('parts');
    setEditorTool('paint');
  };

  const openOperationStickerNode = (nodeId: string): void => {
    const node = operationGraph?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind !== 'apply_sticker') return;
    const stagePath = [...graphNodeOperationPath(node), 'stage', 'apply_sticker'];
    const targetIndex = stickerTargets.findIndex((target) => target.stagePaths.some((path) => (
      path.join('\0') === stagePath.join('\0')
    )));
    if (targetIndex < 0) return;
    updateStickerDraft(null);
    setActiveStickerTarget(targetIndex);
    setEditorTool('sticker');
  };

  const graphEditorProps: GraphEditorProps | undefined = operationGraph ? {
    graph: operationGraph,
    selectedNodeId: selectedOperationGraphNodeId ?? undefined,
    onSelectNode: setSelectedOperationGraphNodeId,
    onGraphChange: handleOperationGraphChange,
    onUpdateNodeRaw: updateOperationGraphRaw,
    onUpdateParameter: updateOperationGraphParameter,
    textureOptions: operationGraphTextureOptions,
    variables: operationGraphVariables,
    onOpenTextureEditor: openOperationTextureNode,
    onOpenSelectEditor: openOperationSelectNode,
    onOpenStickerEditor: openOperationStickerNode,
    onPreviewNode: (nodeId) => operationGraphPreviewUrls[nodeId],
    onExportNode: (nodeId, format) => { void exportOperationGraphNode(nodeId, format); },
    readOnly: editorStatus !== 'ready',
  } : undefined;

  return {
    props: graphEditorProps,
    operationGraphEditError,
  };
}
