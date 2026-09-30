import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComposeResult, Compositor } from '../../compositor/compositor';
import { resolveRecipe as resolveSeededRecipe } from '../../compositor/resolve';
import type { DataSource } from '../../data/loader';
import type { useCustomDefinitions } from '../../hooks/useCustomDefinitions';
import type { useStockDefinitions } from '../../hooks/useStockDefinitions';
import { isCustomKitId } from '../../protodefs/types';
import type { SeedRangeDivergence, SeedRangeValue } from '../../ui/editor/SeedRangeField';
import type { TextureTransformFields, TextureTransformPanelProps } from '../../ui/editor/TextureTransformPanel';
import type { ControlsState } from '../../viewer/controls';
import type { Viewer } from '../../viewer/Viewer';
import { groupByteToCompositorBucket } from '../layers/groupSampling';
import { readTextureLayerTeamColors } from '../mutations';
import { collectResolvedLayerTextureNodes } from '../layers/recipeLayers';
import { mapResolvedTextureReferences } from '../sticker/stickerSurface';
import { collectResolvedLayerIsolationNodes, preferredLayerOccurrenceIndex } from './transformIsolation';
import {
  TRANSFORM_FIELD_TO_PROTO,
  TRANSFORM_LIVE_PREVIEW_MAX_SIZE,
  previewTextureTransformRange,
  transformFieldsFromInfo,
  transformInfoHasEdits,
  transformInfosEqual,
  transformRangeStatesEqual,
  transformTargetForScope,
} from './transformFields';
import {
  discoverBaseTextureTransformTarget,
  discoverLayerTransforms,
  discoverTextureTransformTargets,
} from './transformTargets';
import type { EditorCore } from '../useEditorCore';
import type { EditorLayers } from '../layers/useEditorLayers';
import type { PartsEditor } from '../layers/usePartsEditor';

interface UseTransformEditorOptions extends
  Pick<EditorCore,
    | 'editableKitId'
    | 'editorStatus'
    | 'editorCurrent'
    | 'editorOriginal'
    | 'editorDefinitionGeneration'
    | 'provenanceRecipe'
    | 'weaponSlots'
    | 'paintSubView'
    | 'beginSessionTransformGesture'
    | 'endSessionTransformGesture'
    | 'setSessionTransformRange'
    | 'pushSessionTransformRangeToAll'
    | 'setSessionTransformFlip'
    | 'setSessionLayerTeamColors'
    | 'setSessionLayerTeamTexture'
  >,
  Pick<EditorLayers,
    | 'activeEditorLayerIndex'
    | 'activeGroupVisualIndex'
    | 'activeGroupTarget'
    | 'weaponBaseLayerActive'
    | 'baseTextureTransform'
    | 'transformDiscovery'
    | 'editableGroupTargets'
    | 'groupDiscovery'
    | 'recipeLayerNodes'
    | 'baseRecipeLayerNode'
    | 'editorSelectors'
  >,
  Pick<PartsEditor, 'groupImage' | 'activeSelectedGroupBuckets'> {
  state: ControlsState;
  weaponName: string;
  data: DataSource | null;
  engineReady: boolean;
  editorTabActive: boolean;
  viewerRef: React.RefObject<Viewer | null>;
  compositorRef: React.RefObject<Compositor | null>;
  activeTextureOverrides: Record<string, string>;
  definitions: ReturnType<typeof useCustomDefinitions>;
  stockEditGeneration: ReturnType<typeof useStockDefinitions>['editGeneration'];
  getImportedRecipeWithProvenance: ReturnType<typeof useCustomDefinitions>['getRecipeWithProvenance'];
  getStockRecipeWithProvenance: ReturnType<typeof useStockDefinitions>['getRecipeWithProvenance'];
  resetComposeKey: () => void;
}

/**
 * Per-layer texture transforms: the discovery of each layer's rotation, scale
 * and offsets, the live draft while a slider is dragged, the UV and on-model
 * isolation previews, and the props for the Transform panel.
 */
export function useTransformEditor({
  editableKitId,
  editorStatus,
  editorCurrent,
  editorOriginal,
  editorDefinitionGeneration,
  provenanceRecipe,
  weaponSlots,
  paintSubView,
  beginSessionTransformGesture,
  endSessionTransformGesture,
  setSessionTransformRange,
  pushSessionTransformRangeToAll,
  setSessionTransformFlip,
  setSessionLayerTeamColors,
  setSessionLayerTeamTexture,
  activeEditorLayerIndex,
  activeGroupVisualIndex,
  activeGroupTarget,
  weaponBaseLayerActive,
  baseTextureTransform,
  transformDiscovery,
  editableGroupTargets,
  groupDiscovery,
  recipeLayerNodes,
  baseRecipeLayerNode,
  editorSelectors,
  groupImage,
  activeSelectedGroupBuckets,
  state,
  weaponName,
  data,
  engineReady,
  editorTabActive,
  viewerRef,
  compositorRef,
  activeTextureOverrides,
  definitions,
  stockEditGeneration,
  getImportedRecipeWithProvenance,
  getStockRecipeWithProvenance,
  resetComposeKey,
}: UseTransformEditorOptions) {
  const [transformScope, setTransformScope] = useState<'all' | 'weapon'>('all');
  const [transformIsolateLayer, setTransformIsolateLayer] = useState(false);
  const [transformUvSurfaceUrl, setTransformUvSurfaceUrl] = useState<string | null>(null);
  const [transformUvSurfaceLoading, setTransformUvSurfaceLoading] = useState(false);
  const transformUvSurfaceUrlRef = useRef<string | null>(null);
  const transformUvSurfaceGenerationRef = useRef(0);
  const [transformUvIsolationOverlayUrl, setTransformUvIsolationOverlayUrl] = useState<string | null>(null);
  const transformUvIsolationOverlayUrlRef = useRef<string | null>(null);
  const transformUvIsolationOverlayGenerationRef = useRef(0);
  const [transformGestureActive, setTransformGestureActive] = useState(false);
  const transformGestureActiveRef = useRef(false);
  const transformDraftRef = useRef<{ key: keyof TextureTransformFields; value: SeedRangeValue } | null>(null);
  const transformDraftCommitGenerationRef = useRef<number | null>(null);
  const [transformDraft, setTransformDraft] = useState<{ key: keyof TextureTransformFields; value: SeedRangeValue } | null>(null);
  const [transformDivergence, setTransformDivergence] = useState<Partial<Record<keyof TextureTransformFields, SeedRangeDivergence>>>({});

  const sharedLayerTransforms = useMemo(
    () => editorCurrent ? discoverLayerTransforms(editorCurrent) : null,
    [editorCurrent],
  );
  const originalLayerTransforms = useMemo(
    () => editorOriginal ? discoverLayerTransforms(editorOriginal, provenanceRecipe?.provenance) : null,
    [editorOriginal, provenanceRecipe],
  );
  const originalSharedLayerTransforms = useMemo(
    () => editorOriginal ? discoverLayerTransforms(editorOriginal) : null,
    [editorOriginal],
  );
  const sharedTransformDiscovery = sharedLayerTransforms?.layers ?? null;
  const sharedBaseTextureTransform = sharedLayerTransforms?.base ?? null;
  const originalTransformDiscovery = originalLayerTransforms?.layers ?? null;
  const originalBaseTextureTransform = originalLayerTransforms?.base ?? null;
  const originalSharedTransformDiscovery = originalSharedLayerTransforms?.layers ?? null;
  const originalSharedBaseTextureTransform = originalSharedLayerTransforms?.base ?? null;
  const activeTransformTargetInfo = weaponBaseLayerActive
    ? (transformScope === 'all' ? sharedBaseTextureTransform : baseTextureTransform)?.transform ?? null
    : activeGroupVisualIndex >= 0
      ? (transformScope === 'all' ? sharedTransformDiscovery : transformDiscovery)?.targets[activeGroupVisualIndex] ?? null
      : null;
  const originalTransformTargetInfo = weaponBaseLayerActive
    ? (transformScope === 'all' ? originalSharedBaseTextureTransform : originalBaseTextureTransform)?.transform ?? null
    : activeGroupVisualIndex >= 0
      ? (transformScope === 'all' ? originalSharedTransformDiscovery : originalTransformDiscovery)?.targets[activeGroupVisualIndex] ?? null
      : null;
  const activeTransformLayerNode = weaponBaseLayerActive
    ? baseRecipeLayerNode
    : activeGroupVisualIndex >= 0
      ? recipeLayerNodes[activeGroupVisualIndex] ?? null
      : null;
  const transformPreviewRecipe = useMemo(() => {
    if (!provenanceRecipe || !transformDraft
      || (!activeTransformLayerNode && !(weaponBaseLayerActive && baseTextureTransform))) {
      return provenanceRecipe?.tree ?? null;
    }
    return previewTextureTransformRange(
      provenanceRecipe.tree,
      activeTransformLayerNode,
      weaponBaseLayerActive ? baseTextureTransform?.textureRef ?? null : null,
      transformDraft.key,
      transformDraft.value,
    );
  }, [activeTransformLayerNode, baseTextureTransform, provenanceRecipe, transformDraft, weaponBaseLayerActive]);
  useEffect(() => {
    const generation = ++transformUvIsolationOverlayGenerationRef.current;
    const clearOverlay = () => {
      const priorUrl = transformUvIsolationOverlayUrlRef.current;
      transformUvIsolationOverlayUrlRef.current = null;
      setTransformUvIsolationOverlayUrl(null);
      if (priorUrl) URL.revokeObjectURL(priorUrl);
    };
    if (!transformIsolateLayer || paintSubView !== 'transform' || !groupImage
      || activeSelectedGroupBuckets.length === 0) {
      clearOverlay();
      return;
    }

    // The UV pane is capped at 460 CSS pixels. A 512px mask preserves crisp
    // group edges at its actual display size while avoiding four times the
    // pixel work and memory of a 1024px intermediate.
    const maxDimension = 512;
    const scale = Math.min(1, maxDimension / Math.max(groupImage.width, groupImage.height));
    const width = Math.max(1, Math.round(groupImage.width * scale));
    const height = Math.max(1, Math.round(groupImage.height * scale));
    const selectedBuckets = new Set(activeSelectedGroupBuckets);
    const overlayPixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      const sourceY = Math.min(groupImage.height - 1, Math.floor(y / scale));
      for (let x = 0; x < width; x += 1) {
        const sourceX = Math.min(groupImage.width - 1, Math.floor(x / scale));
        const sourceOffset = (sourceY * groupImage.width + sourceX) * 4;
        const bucket = groupByteToCompositorBucket(Number(groupImage.data[sourceOffset]));
        if (bucket !== null && selectedBuckets.has(bucket)) continue;
        const offset = (y * width + x) * 4;
        overlayPixels[offset] = 255;
        overlayPixels[offset + 1] = 255;
        overlayPixels[offset + 2] = 255;
        overlayPixels[offset + 3] = 255;
      }
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      clearOverlay();
      return;
    }
    context.putImageData(new ImageData(overlayPixels, width, height), 0, 0);
    canvas.toBlob((blob) => {
      if (generation !== transformUvIsolationOverlayGenerationRef.current) return;
      if (!blob) {
        clearOverlay();
        return;
      }
      const nextUrl = URL.createObjectURL(blob);
      const priorUrl = transformUvIsolationOverlayUrlRef.current;
      transformUvIsolationOverlayUrlRef.current = nextUrl;
      setTransformUvIsolationOverlayUrl(nextUrl);
      if (priorUrl) URL.revokeObjectURL(priorUrl);
    }, 'image/png');
  }, [activeSelectedGroupBuckets, groupImage, paintSubView, transformIsolateLayer]);

  useEffect(() => () => {
    transformUvIsolationOverlayGenerationRef.current += 1;
    const priorUrl = transformUvIsolationOverlayUrlRef.current;
    transformUvIsolationOverlayUrlRef.current = null;
    if (priorUrl) URL.revokeObjectURL(priorUrl);
  }, []);
  // Aligned with editorSelectors/groupAssignmentTargets (one entry per visible
  // layer), unlike transformDiscovery.targets which is aligned with the raw,
  // undeduplicated groupDiscovery.targets.
  const layerTransformInfos = useMemo(() => editableGroupTargets.map((target) => {
    const operationIndex = groupDiscovery
      ? preferredLayerOccurrenceIndex(groupDiscovery.targets, target)
      : -1;
    return operationIndex >= 0 ? transformDiscovery?.targets[operationIndex] ?? null : null;
  }), [editableGroupTargets, groupDiscovery, transformDiscovery]);
  const layerHasTransformEdits = useMemo(() => {
    const layers = layerTransformInfos.map((info) => (info ? transformInfoHasEdits(info) : false));
    const base = baseTextureTransform?.transform;
    if (base) layers.push(transformInfoHasEdits(base));
    return layers;
  }, [baseTextureTransform, layerTransformInfos]);

  const layerTransformLocked = useMemo(() => {
    const layers = editableGroupTargets.map((target, index) => (
      target.label.trim().toLowerCase() === 'albedo'
        || !layerTransformInfos[index]
        || layerTransformInfos[index].blockers.length > 0
    ));
    if (baseTextureTransform) layers.push(
      baseTextureTransform.transformLocked || baseTextureTransform.transform.blockers.length > 0,
    );
    return layers;
  }, [baseTextureTransform, editableGroupTargets, layerTransformInfos]);

  // Open on the selected weapon whenever this layer actually resolves one of
  // its transform fields from a weapon-local source. Otherwise show the shared
  // value. The user can still change scope afterward because scope itself is
  // deliberately not a dependency of this synchronization.
  useEffect(() => {
    const weaponInfo = weaponBaseLayerActive
      ? baseTextureTransform?.transform
      : activeGroupVisualIndex >= 0 ? transformDiscovery?.targets[activeGroupVisualIndex] : null;
    const sharedInfo = weaponBaseLayerActive
      ? sharedBaseTextureTransform?.transform
      : activeGroupVisualIndex >= 0 ? sharedTransformDiscovery?.targets[activeGroupVisualIndex] : null;
    const differsFromShared = Boolean(weaponInfo && sharedInfo && !transformInfosEqual(weaponInfo, sharedInfo));
    setTransformScope(differsFromShared ? 'weapon' : 'all');
  }, [
    activeEditorLayerIndex,
    activeGroupVisualIndex,
    editableKitId,
    sharedTransformDiscovery,
    state.weaponKey,
    transformDiscovery,
    baseTextureTransform,
    sharedBaseTextureTransform,
    weaponBaseLayerActive,
  ]);

  useEffect(() => {
    const committedAt = transformDraftCommitGenerationRef.current;
    if (committedAt === null || editorDefinitionGeneration <= committedAt) return;
    transformDraftCommitGenerationRef.current = null;
    transformDraftRef.current = null;
    setTransformDraft(null);
  }, [editorDefinitionGeneration]);
  const resolvedPreviewRecipe = useMemo(
    () => transformPreviewRecipe ? resolveSeededRecipe(transformPreviewRecipe, state.seed) : null,
    [state.seed, transformPreviewRecipe],
  );
  const activeTransformIsolationNode = useMemo(() => {
    const mapReference = (reference: string) => activeTextureOverrides[reference] ?? reference;
    if (weaponBaseLayerActive) {
      if (!activeTransformLayerNode) return null;
      return mapResolvedTextureReferences(resolveSeededRecipe(activeTransformLayerNode, state.seed), mapReference);
    }
    if (!resolvedPreviewRecipe || activeGroupVisualIndex < 0) return null;
    const resolved = mapResolvedTextureReferences(resolvedPreviewRecipe, mapReference);
    return collectResolvedLayerIsolationNodes(resolved)[activeGroupVisualIndex] ?? null;
  }, [activeGroupVisualIndex, activeTextureOverrides, activeTransformLayerNode, resolvedPreviewRecipe, state.seed, weaponBaseLayerActive]);
  const activeSeedTransform = useMemo(() => {
    if (weaponBaseLayerActive) {
      if (!activeTransformLayerNode) return null;
      const resolvedBase = resolveSeededRecipe(activeTransformLayerNode, state.seed);
      return resolvedBase.type === 'texture_lookup' ? resolvedBase : null;
    }
    if (!resolvedPreviewRecipe) return null;
    if (activeGroupVisualIndex < 0) return null;
    return collectResolvedLayerTextureNodes(resolvedPreviewRecipe)[activeGroupVisualIndex] ?? null;
  }, [activeGroupVisualIndex, activeTransformLayerNode, resolvedPreviewRecipe, state.seed, weaponBaseLayerActive]);

  useEffect(() => {
    if (paintSubView !== 'transform' || editableKitId === null
      || (!weaponBaseLayerActive && activeGroupVisualIndex < 0) || !activeTransformTargetInfo) {
      setTransformDivergence({});
      return;
    }
    const resolver = isCustomKitId(editableKitId)
      ? getImportedRecipeWithProvenance
      : getStockRecipeWithProvenance;
    const currentValues = transformFieldsFromInfo(activeTransformTargetInfo);
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void Promise.all([...new Set(weaponSlots.map((slot) => slot.weaponKey))].map(async (weaponKey) => {
        const recipe = await resolver(editableKitId, weaponKey, state.team, state.wearIndex);
        if (!recipe || !editorCurrent) return null;
        const info = weaponBaseLayerActive
          ? discoverBaseTextureTransformTarget(editorCurrent, recipe.provenance)?.transform
          : discoverTextureTransformTargets(editorCurrent, recipe.provenance).targets[activeGroupVisualIndex];
        if (!info) return null;
        return { weaponKey, values: transformFieldsFromInfo(info) };
      })).then((rows) => {
        if (cancelled) return;
        const next: Partial<Record<keyof TextureTransformFields, SeedRangeDivergence>> = {};
        for (const key of Object.keys(currentValues) as (keyof TextureTransformFields)[]) {
          const weapons = rows.flatMap((row) => row && !transformRangeStatesEqual(row.values[key], currentValues[key])
            ? [data?.manifest.weapons.find((weapon) => weapon.key === row.weaponKey)?.name ?? row.weaponKey]
            : []);
          if (weapons.length > 0) next[key] = { count: weapons.length, weapons };
        }
        setTransformDivergence(next);
      }).catch(() => {
        if (!cancelled) setTransformDivergence({});
      });
    }, 180);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [
    activeGroupVisualIndex,
    activeTransformTargetInfo,
    data,
    editableKitId,
    editorCurrent,
    getImportedRecipeWithProvenance,
    getStockRecipeWithProvenance,
    paintSubView,
    state.team,
    state.wearIndex,
    weaponSlots,
    weaponBaseLayerActive,
    definitions.editGeneration,
    stockEditGeneration,
  ]);

  const handleVisiblePaintResult = useCallback((
    result: ComposeResult,
    context: { interactive: boolean },
  ) => {
    if (!editorTabActive || paintSubView !== 'transform') return;
    const compositor = compositorRef.current;
    if (!compositor) return;
    const generation = ++transformUvSurfaceGenerationRef.current;
    setTransformUvSurfaceLoading(true);
    let previewBlob: Promise<Blob>;
    try {
      previewBlob = compositor.toPreviewBlob(
        result.target,
        context.interactive ? TRANSFORM_LIVE_PREVIEW_MAX_SIZE : 1024,
      );
    } catch {
      if (generation === transformUvSurfaceGenerationRef.current) setTransformUvSurfaceLoading(false);
      return;
    }
    void previewBlob.then((blob) => {
      if (generation !== transformUvSurfaceGenerationRef.current) return;
      const nextUrl = URL.createObjectURL(blob);
      const priorUrl = transformUvSurfaceUrlRef.current;
      transformUvSurfaceUrlRef.current = nextUrl;
      setTransformUvSurfaceUrl(nextUrl);
      setTransformUvSurfaceLoading(false);
      if (priorUrl) URL.revokeObjectURL(priorUrl);
    }).catch(() => {
      if (generation === transformUvSurfaceGenerationRef.current) setTransformUvSurfaceLoading(false);
    });
  }, [compositorRef, editorTabActive, paintSubView]);

  useEffect(() => {
    if (editorTabActive && paintSubView === 'transform') return;
    transformUvSurfaceGenerationRef.current += 1;
    const priorUrl = transformUvSurfaceUrlRef.current;
    transformUvSurfaceUrlRef.current = null;
    setTransformUvSurfaceUrl(null);
    setTransformUvSurfaceLoading(false);
    if (priorUrl) URL.revokeObjectURL(priorUrl);
  }, [editorTabActive, paintSubView]);

  useEffect(() => () => {
    transformUvSurfaceGenerationRef.current += 1;
    const priorUrl = transformUvSurfaceUrlRef.current;
    transformUvSurfaceUrlRef.current = null;
    if (priorUrl) URL.revokeObjectURL(priorUrl);
  }, []);

  const isolatedTransformResultRef = useRef<ComposeResult | null>(null);
  useEffect(() => {
    const compositor = compositorRef.current;
    const viewer = viewerRef.current;
    const groupPixels = groupImage?.data;
    const clearIsolation = () => {
      const prior = isolatedTransformResultRef.current;
      isolatedTransformResultRef.current = null;
      viewer?.clearTransformIsolation();
      if (prior && compositor) compositor.releaseResult(prior);
    };
    if (!engineReady || paintSubView !== 'transform' || !transformIsolateLayer
      || !activeTransformIsolationNode || !compositor || !viewer || !data
      || !groupImage
      || !(groupPixels instanceof Uint8Array || groupPixels instanceof Uint8ClampedArray)
      || activeSelectedGroupBuckets.length === 0) {
      clearIsolation();
      return;
    }
    const weapon = data.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    if (!weapon) return;
    let cancelled = false;
    const fullWidth = weapon.compositeWidth ?? 1024;
    const fullHeight = weapon.compositeHeight ?? 1024;
    const scale = transformDraft
      ? Math.min(1, TRANSFORM_LIVE_PREVIEW_MAX_SIZE / Math.max(fullWidth, fullHeight))
      : 1;
    const compose = transformDraft
      ? compositor.composeResolvedLatest('transform-isolation', activeTransformIsolationNode, {
        width: Math.max(1, Math.round(fullWidth * scale)),
        height: Math.max(1, Math.round(fullHeight * scale)),
      })
      : compositor.composeResolved(activeTransformIsolationNode, {
        width: Math.max(1, Math.round(fullWidth * scale)),
        height: Math.max(1, Math.round(fullHeight * scale)),
      });
    void compose.then((result) => {
      if (!result) return;
      if (cancelled) {
        compositor.releaseResult(result);
        return;
      }
      const prior = isolatedTransformResultRef.current;
      isolatedTransformResultRef.current = result;
      if (groupImage && (groupPixels instanceof Uint8Array || groupPixels instanceof Uint8ClampedArray)) {
        viewer.setTransformIsolation(
          result.texture,
          groupPixels,
          groupImage.width,
          groupImage.height,
          activeSelectedGroupBuckets,
        );
      }
      if (prior && prior !== result) compositor.releaseResult(prior);
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    activeTransformIsolationNode,
    activeSelectedGroupBuckets,
    data,
    engineReady,
    groupImage,
    paintSubView,
    state.weaponKey,
    transformGestureActive,
    transformDraft,
    transformIsolateLayer,
    weaponBaseLayerActive,
    compositorRef,
    viewerRef,
  ]);

  useEffect(() => () => {
    viewerRef.current?.clearTransformIsolation();
    const prior = isolatedTransformResultRef.current;
    isolatedTransformResultRef.current = null;
    if (prior) compositorRef.current?.releaseResult(prior);
  }, [compositorRef, viewerRef]);

  const albedoTransformLocked = weaponBaseLayerActive
    ? baseTextureTransform?.transformLocked ?? false
    : activeGroupTarget?.label.trim().toLowerCase() === 'albedo';
  const transformDisabled = editorStatus !== 'ready' || albedoTransformLocked
    || !activeTransformTargetInfo || activeTransformTargetInfo.blockers.length > 0;
  const activeTransformTarget = activeTransformTargetInfo?.target ?? null;
  const commitTransformField = (key: keyof TextureTransformFields, value: SeedRangeValue) => {
    if (!activeTransformTarget || transformDisabled) return;
    if (transformScope === 'all') {
      pushSessionTransformRangeToAll(
        activeTransformTarget,
        TRANSFORM_FIELD_TO_PROTO[key],
        value,
        weaponSlots.map((slot) => [...slot.path, 'data', 'variable']),
      );
      return;
    }
    setSessionTransformRange(transformTargetForScope(activeTransformTarget, transformScope), TRANSFORM_FIELD_TO_PROTO[key], value);
  };
  const handleTransformFieldChange = (key: keyof TextureTransformFields, value: SeedRangeValue) => {
    if (!transformGestureActiveRef.current) {
      commitTransformField(key, value);
      return;
    }
    const draft = { key, value };
    transformDraftRef.current = draft;
    setTransformDraft(draft);
  };
  const handleTransformFlipChange = (axis: 'u' | 'v', allowed: boolean) => {
    if (!activeTransformTarget || transformDisabled) return;
    setSessionTransformFlip(transformTargetForScope(activeTransformTarget, transformScope), axis, allowed);
  };
  const handleTransformResetAll = () => {
    if (!activeTransformTarget || transformDisabled) return;
    const target = transformTargetForScope(activeTransformTarget, transformScope);
    const original = originalTransformTargetInfo;
    const originalFields = transformFieldsFromInfo(original);
    beginSessionTransformGesture();
    setSessionTransformRange(target, 'rotation', originalFields.rotation);
    setSessionTransformRange(target, 'scale_uv', originalFields.scale);
    setSessionTransformRange(target, 'translate_u', originalFields.offsetU);
    setSessionTransformRange(target, 'translate_v', originalFields.offsetV);
    setSessionTransformFlip(target, 'u', original?.flipU.allowed ?? false);
    setSessionTransformFlip(target, 'v', original?.flipV.allowed ?? false);
    endSessionTransformGesture();
  };
  const authoredTransformFields = transformFieldsFromInfo(activeTransformTargetInfo);
  const transformFields: TextureTransformFields = transformDraft
    ? { ...authoredTransformFields, [transformDraft.key]: transformDraft.value }
    : authoredTransformFields;
  const originalTransformFields = transformFieldsFromInfo(originalTransformTargetInfo);
  const handlePushTransformFieldToAll = (key: keyof TextureTransformFields) => {
    if (!activeTransformTarget || transformDisabled) return;
    const overridePaths = weaponSlots.map((slot) => [...slot.path, 'data', 'variable']);
    pushSessionTransformRangeToAll(
      activeTransformTarget,
      TRANSFORM_FIELD_TO_PROTO[key],
      transformFields[key],
      overridePaths,
    );
  };
  const transformEditorProps: TextureTransformPanelProps | undefined = editorSelectors.length > 0 ? {
    layerLabel: weaponBaseLayerActive
      ? baseTextureTransform?.label ?? 'Base texture'
      : editorSelectors[activeEditorLayerIndex]?.label ?? 'Paint layer',
    layerIndex: activeEditorLayerIndex,
    layerCount: editorSelectors.length + (baseTextureTransform ? 1 : 0),
    fields: transformFields,
    currentSeedValues: activeSeedTransform ? {
      rotation: activeSeedTransform.rotationDeg,
      scale: activeSeedTransform.scale,
      offsetU: activeSeedTransform.translateU,
      offsetV: activeSeedTransform.translateV,
    } : undefined,
    originalValues: originalTransformFields,
    divergence: transformDivergence,
    flipU: activeTransformTargetInfo?.flipU.allowed ?? false,
    flipV: activeTransformTargetInfo?.flipV.allowed ?? false,
    scope: transformScope,
    scopeWeaponLabel: weaponName,
    isolateLayer: transformIsolateLayer,
    uvTextureSrc: transformUvSurfaceUrl,
    uvIsolationOverlaySrc: transformUvIsolationOverlayUrl,
    previewAspect: (() => {
      const weapon = data?.manifest.weapons.find((entry) => entry.key === state.weaponKey);
      return (weapon?.compositeWidth ?? 1024) / (weapon?.compositeHeight ?? 1024);
    })(),
    uvSurfaceLoading: transformUvSurfaceLoading,
    disabled: transformDisabled,
    onFieldChange: handleTransformFieldChange,
    onFlipChange: handleTransformFlipChange,
    onScopeChange: setTransformScope,
    onIsolateLayerChange: (active) => {
      if (!active) resetComposeKey();
      setTransformIsolateLayer(active);
    },
    onPushFieldToAll: handlePushTransformFieldToAll,
    onResetAll: handleTransformResetAll,
    onInteractionStart: () => {
      transformGestureActiveRef.current = true;
      transformDraftRef.current = null;
      transformDraftCommitGenerationRef.current = null;
      setTransformGestureActive(true);
    },
    onInteractionEnd: () => {
      const draft = transformDraftRef.current;
      transformGestureActiveRef.current = false;
      transformDraftRef.current = null;
      if (draft) {
        transformDraftCommitGenerationRef.current = editorDefinitionGeneration;
        commitTransformField(draft.key, draft.value);
      }
      setTransformGestureActive(false);
    },
  } : undefined;

  const teamColors = (() => {
    // The base slot is the paint's main texture unless it is
    // the weapon's own albedo, which belongs to the model.
    const info = weaponBaseLayerActive && baseTextureTransform?.transformLocked !== false
      ? null
      : activeTransformTargetInfo;
    if (!editorCurrent || !info || info.blockers.some((blocker) => (
      blocker === 'no-texture-lookup-stage' || blocker === 'ambiguous-source-stage'
    ))) return undefined;
    const team = readTextureLayerTeamColors(editorCurrent, info.target);
    if (!team?.red) return undefined;
    return {
      enabled: team.enabled,
      team: state.team,
      red: team.red,
      blu: team.blu,
      onToggle: (enabled: boolean) => { setSessionLayerTeamColors(info.target, enabled); },
      onSetTexture: (side: 'red' | 'blu', reference: string) => {
        setSessionLayerTeamTexture(info.target, side, reference);
      },
    };
  })();

  return {
    transformDraft,
    transformPreviewRecipe,
    handleVisiblePaintResult,
    resolvedPreviewRecipe,
    props: transformEditorProps,
    teamColors,
    layerHasTransformEdits,
    layerTransformLocked,
  };
}
export type TransformEditor = ReturnType<typeof useTransformEditor>;
