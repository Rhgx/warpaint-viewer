import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import type { DataSource } from '../../data/loader';
import type { useCustomDefinitions } from '../../hooks/useCustomDefinitions';
import type { SourceTextureProvider } from '../../source/provider';
import type { CustomWarpaintWorkbench } from '../../ui/workbench/CustomWarpaintWorkbench';
import type { ControlsState } from '../../viewer/controls';
import type { Viewer } from '../../viewer/Viewer';
import type { WarpaintAssetOverrides, WorkbenchTab } from '../../workbench/types';
import { discoverGroupTextureTarget } from './groupTargets';
import {
  compatibleGroupTextures,
  formatGroupNameForDisplay,
  loadGroupNameReference,
  lookupGroupNameForBucket,
  groupTextureLoadRef,
  normalizeGroupTextureReference,
  preferredAlbedoGroupIds,
} from './groupNames';
import {
  groupBucketsInImage,
  groupByteToCompositorBucket,
  rawGroupIdForBucket,
  sampleGroupAtUv,
  type RgbaImageDataLike,
} from './groupSampling';
import { loadRgbaImageData, loadRgbaThumbnail, rgbaThumbnailDataUrl } from './imageData';
import { chooseEditorLayerColors, EDITOR_LAYER_MAP_COLORS, linearLayerColorToCss } from './layerMap';
import type { EditorCore } from '../useEditorCore';
import type { EditorLayers } from './useEditorLayers';

/** The `editor` prop the workbench takes, whose slices the editor hooks build. */
export type WorkbenchEditorProps = NonNullable<ComponentProps<typeof CustomWarpaintWorkbench>['editor']>;

/** The parts and layer slice of the workbench editor props. */
type PartsEditorProps = Pick<WorkbenchEditorProps,
  | 'enabled'
  | 'unavailableReason'
  | 'selectedGroupIds'
  | 'selectionContextId'
  | 'groupLabels'
  | 'notice'
  | 'activeLayerIndex'
  | 'activeLayerLabel'
  | 'groupLayerIndex'
  | 'layerColors'
  | 'layerSwatchColors'
  | 'layerThumbnails'
  | 'baseLayer'
  | 'showLayerMap'
  | 'onShowLayerMapChange'
  | 'onToggleGroup'
  | 'onClearSelection'
  | 'clearSelectionDisabled'
  | 'onPreviewGroup'
  | 'groupTextureChoices'
  | 'activeGroupTextureRef'
  | 'onGroupTextureChange'
  | 'selectors'
  | 'activeSelectorId'
  | 'onActiveSelectorChange'
>;

interface UsePartsEditorOptions extends
  Pick<EditorCore,
    | 'editableKitId'
    | 'editorStatus'
    | 'editorTool'
    | 'paintSubView'
    | 'provenanceRecipe'
    | 'weaponSlots'
    | 'assignSessionGroups'
    | 'clearSessionGroups'
    | 'setSessionGroupTexture'
  >,
  Pick<EditorLayers,
    | 'activeEditorSelector'
    | 'setActiveEditorSelector'
    | 'weaponBaseLayerActive'
    | 'setWeaponBaseLayerActive'
    | 'groupDiscovery'
    | 'baseTextureTransform'
    | 'baseLayerTextureRef'
    | 'editableGroupTargets'
    | 'editorSelectors'
    | 'activeGroupTarget'
    | 'activeResolvedGroupSelect'
    | 'activeGroupRef'
    | 'groupAssignmentTargets'
    | 'activeGroupAssignmentTarget'
    | 'activeGroupEditTarget'
    | 'activeEditorLayerIndex'
  > {
  workbenchOpen: boolean;
  workbenchTab: WorkbenchTab;
  editorTabActive: boolean;
  state: ControlsState;
  definitions: ReturnType<typeof useCustomDefinitions>;
  data: DataSource | null;
  engineReady: boolean;
  viewerRef: React.RefObject<Viewer | null>;
  sourceProvider: SourceTextureProvider;
  packageGeneration: number;
  assetOverrides: WarpaintAssetOverrides;
  activeTextureOverrides: Record<string, string>;
}

/**
 * A group map image shared through `cache`, keyed by the package generation and
 * the override in force. A failed load leaves nothing behind so it can retry.
 */
function loadGroupImage(
  cache: Map<string, Promise<RgbaImageDataLike>>,
  ref: string,
  packageGeneration: number,
  activeTextureOverrides: Record<string, string>,
  sourceProvider: SourceTextureProvider,
): Promise<RgbaImageDataLike> {
  const cacheKey = `${packageGeneration}:${activeTextureOverrides[ref] ?? ref}`;
  let pending = cache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const url = activeTextureOverrides[ref] ?? await sourceProvider.resolvePreview(ref);
      return loadRgbaImageData(url);
    })();
    cache.set(cacheKey, pending);
    void pending.catch(() => cache.delete(cacheKey));
  }
  return pending;
}

/**
 * Part selection on the weapon surface: which editable areas exist, which of
 * them the active layer owns, the Shift+click sampling, and the layer map and
 * highlight overlays drawn on the model.
 */
export function usePartsEditor({
  workbenchOpen,
  workbenchTab,
  editorTabActive,
  state,
  definitions,
  data,
  engineReady,
  viewerRef,
  sourceProvider,
  packageGeneration,
  assetOverrides,
  activeTextureOverrides,
  editableKitId,
  editorStatus,
  editorTool,
  paintSubView,
  provenanceRecipe,
  weaponSlots,
  assignSessionGroups,
  clearSessionGroups,
  setSessionGroupTexture,
  activeEditorSelector,
  setActiveEditorSelector,
  weaponBaseLayerActive,
  setWeaponBaseLayerActive,
  groupDiscovery,
  baseTextureTransform,
  baseLayerTextureRef,
  editableGroupTargets,
  editorSelectors,
  activeGroupTarget,
  activeResolvedGroupSelect,
  activeGroupRef,
  groupAssignmentTargets,
  activeGroupAssignmentTarget,
  activeGroupEditTarget,
  activeEditorLayerIndex,
}: UsePartsEditorOptions) {
  const [groupNameReferenceGeneration, setGroupNameReferenceGeneration] = useState(0);
  useEffect(() => {
    if (!workbenchOpen || workbenchTab !== 'editor' || groupNameReferenceGeneration > 0) return;
    let cancelled = false;
    void loadGroupNameReference().then(() => {
      if (!cancelled) setGroupNameReferenceGeneration((generation) => generation + 1);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [groupNameReferenceGeneration, workbenchOpen, workbenchTab]);

  const [groupImage, setGroupImage] = useState<RgbaImageDataLike | null>(null);
  const [groupImageError, setGroupImageError] = useState<string | null>(null);
  const [requestedGroupTextureRef, setRequestedGroupTextureRef] = useState<string | null>(null);
  const groupImageCacheRef = useRef(new Map<string, Promise<RgbaImageDataLike>>());
  const autoAlbedoAssignmentKeysRef = useRef(new Set<string>());
  const [editorAssignmentNotice, setEditorAssignmentNotice] = useState<string | null>(null);
  const [showLayerMap, setShowLayerMap] = useState(false);
  const [layerMapImages, setLayerMapImages] = useState<Record<string, RgbaImageDataLike>>({});
  const [layerTextureThumbnails, setLayerTextureThumbnails] = useState<Record<string, RgbaImageDataLike | null>>({});
  const [layerTexturePreviewUrls, setLayerTexturePreviewUrls] = useState<Record<string, string | null>>({});
  const layerThumbnailCacheRef = useRef(new Map<string, Promise<RgbaImageDataLike | null>>());
  const layerThumbnailGenerationRef = useRef('');
  const [panelPreviewGroup, setPanelPreviewGroup] = useState<number | null>(null);
  const groupPointerRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // Only the bucket under the pointer is kept: a per-texel sample would render
  // the whole app on every pointer move, and nothing reads it.
  const [hoverBucket, setHoverBucket] = useState<number | null>(null);

  useEffect(() => {
    if (!editorAssignmentNotice) return;
    const timeout = window.setTimeout(() => setEditorAssignmentNotice(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [editorAssignmentNotice]);

  useEffect(() => setShowLayerMap(false), [editableKitId, state.weaponKey]);

  const resolvedGroupTextureValue = activeGroupRef ? normalizeGroupTextureReference(activeGroupRef) : undefined;
  const activeGroupTextureValue = requestedGroupTextureRef ?? resolvedGroupTextureValue;
  // The requested value is the list's normalized path; load it in the spelling the resolver knows.
  const displayedGroupRef = requestedGroupTextureRef ? groupTextureLoadRef(requestedGroupTextureRef) : activeGroupRef;
  const groupTextureChoices = useMemo(
    () => {
      if (!displayedGroupRef) return [];
      const hasBuiltInNames = normalizeGroupTextureReference(displayedGroupRef).startsWith('models/items/paintkit_tool/');
      return groupNameReferenceGeneration > 0 || hasBuiltInNames
        ? compatibleGroupTextures(displayedGroupRef)
        : [];
    },
    [displayedGroupRef, groupNameReferenceGeneration],
  );
  const activeWeaponVariablePath = weaponSlots.find((slot) => slot.weaponKey === state.weaponKey)?.path;
  const groupTextureTarget = useMemo(() => discoverGroupTextureTarget(
    provenanceRecipe?.provenance,
    activeGroupRef,
    activeWeaponVariablePath ? [...activeWeaponVariablePath, 'data', 'variable'] : undefined,
  ), [activeGroupRef, activeWeaponVariablePath, provenanceRecipe?.provenance]);

  useEffect(() => {
    if (requestedGroupTextureRef && requestedGroupTextureRef === resolvedGroupTextureValue) {
      setRequestedGroupTextureRef(null);
    }
  }, [requestedGroupTextureRef, resolvedGroupTextureValue]);

  useEffect(() => {
    setRequestedGroupTextureRef(null);
    setGroupImage(null);
    groupImageCacheRef.current.clear();
    autoAlbedoAssignmentKeysRef.current.clear();
  }, [editableKitId, state.weaponKey]);
  const activeGroupBuckets = useMemo(
    () => groupImage ? groupBucketsInImage(groupImage) : [],
    [groupImage],
  );
  // The operation can inherit its starting selector values from the selected
  // weapon or wear. Show the values the model is actually using until an edit
  // intentionally locks those slots into the draft operation.
  const explicitActiveSelectedRawGroupIds = useMemo(() => (
    activeGroupTarget?.hasInheritedVariableValues
      ? activeResolvedGroupSelect?.select
      : activeGroupTarget?.selectedGroupIds
  )?.filter((id, index, values) => id > 0 && values.indexOf(id) === index).sort((a, b) => a - b) ?? [], [
    activeGroupTarget,
    activeResolvedGroupSelect,
  ]);
  const activeSelectedRawGroupIds = useMemo(() => {
    if (!weaponBaseLayerActive) return explicitActiveSelectedRawGroupIds;
    const assigned = new Set(groupAssignmentTargets.flatMap((target) => target.selectedGroupIds));
    return activeGroupBuckets
      .map(rawGroupIdForBucket)
      .filter((groupId): groupId is number => groupId !== null && !assigned.has(groupId));
  }, [activeGroupBuckets, explicitActiveSelectedRawGroupIds, groupAssignmentTargets, weaponBaseLayerActive]);
  const activeSelectedGroupBuckets = useMemo(() => activeSelectedRawGroupIds
    .map(groupByteToCompositorBucket)
    .filter((bucket): bucket is number => bucket !== null && bucket > 0)
    .filter((bucket, index, buckets) => buckets.indexOf(bucket) === index)
    .sort((a, b) => a - b), [activeSelectedRawGroupIds]);

  const activeGroupLabels = useMemo(() => {
    if (!displayedGroupRef) return {};
    const labels: Record<number, string> = {};
    const hasBuiltInNames = normalizeGroupTextureReference(displayedGroupRef).startsWith('models/items/paintkit_tool/');
    for (let bucket = 1; bucket <= 16; bucket += 1) {
      const name = groupNameReferenceGeneration > 0 || hasBuiltInNames
        ? lookupGroupNameForBucket(displayedGroupRef, bucket)
        : null;
      if (name) labels[bucket] = name;
    }
    for (const bucket of activeGroupBuckets) {
      if (!labels[bucket]) labels[bucket] = 'Part';
    }
    return labels;
  }, [activeGroupBuckets, displayedGroupRef, groupNameReferenceGeneration]);
  useEffect(() => {
    if (!displayedGroupRef || !groupImage || editableKitId === null) return;
    const assignmentKey = `${editableKitId}:${state.weaponKey}:${normalizeGroupTextureReference(displayedGroupRef)}`;
    if (autoAlbedoAssignmentKeysRef.current.has(assignmentKey)) return;
    const presentRawIds = new Set(activeGroupBuckets
      .map(rawGroupIdForBucket)
      .filter((groupId): groupId is number => groupId !== null));
    const unassignedDefaults = preferredAlbedoGroupIds(displayedGroupRef).filter((groupId) => (
      presentRawIds.has(groupId)
      &&
      !groupAssignmentTargets.some((target) => target.selectedGroupIds.includes(groupId))
    ));
    if (unassignedDefaults.length === 0) return;
    const albedoTarget = groupAssignmentTargets.find((target) => (
      target.canAssign && target.label.trim().toLowerCase() === 'albedo'
    ));
    if (!albedoTarget) return;
    if (assignSessionGroups(albedoTarget, groupAssignmentTargets, unassignedDefaults)) {
      autoAlbedoAssignmentKeysRef.current.add(assignmentKey);
    }
  }, [activeGroupBuckets, assignSessionGroups, displayedGroupRef, editableKitId, groupAssignmentTargets, groupImage, state.weaponKey]);
  // The parts board needs to know which layer every assigned part belongs to,
  // not just the active one, so it can render each chip's true state (in this
  // layer / in another layer / unassigned) rather than only a binary toggle.
  const groupBucketLayerIndex = useMemo(() => {
    const map: Record<number, number> = {};
    groupAssignmentTargets.forEach((target, layerIndex) => {
      target.selectedGroupIds
        .map(groupByteToCompositorBucket)
        .filter((bucket): bucket is number => bucket !== null && bucket > 0)
        .forEach((bucket) => { map[bucket] = layerIndex; });
    });
    if (baseTextureTransform) {
      const baseLayerIndex = groupAssignmentTargets.length;
      for (const bucket of activeGroupBuckets) {
        if (map[bucket] === undefined) map[bucket] = baseLayerIndex;
      }
    }
    return map;
  }, [activeGroupBuckets, baseTextureTransform, groupAssignmentTargets]);
  // Selection edits recreate the assignment target objects, but preserve this
  // layer order and each texture reference. The chooser is deterministic, so
  // re-evaluation after an assignment cannot reshuffle layer colours.
  const editableLayerTextureRefs = useMemo(
    () => groupAssignmentTargets.map((target) => target.textureRef),
    [groupAssignmentTargets],
  );
  const layerColorTextureRefs = useMemo(
    () => baseLayerTextureRef
      ? [...editableLayerTextureRefs, baseLayerTextureRef]
      : editableLayerTextureRefs,
    [baseLayerTextureRef, editableLayerTextureRefs],
  );

  useEffect(() => {
    const generation = `${packageGeneration}:${definitions.generation}:${assetOverrides.revision}`;
    if (layerThumbnailGenerationRef.current !== generation) {
      layerThumbnailGenerationRef.current = generation;
      layerThumbnailCacheRef.current.clear();
    }
    const refs = [...new Set(layerColorTextureRefs
      .filter((ref): ref is string => Boolean(ref)))];
    if (refs.length === 0) {
      setLayerTextureThumbnails({});
      setLayerTexturePreviewUrls({});
      return;
    }
    let cancelled = false;
    void Promise.all(refs.map(async (ref) => {
      try {
        const overrideUrl = activeTextureOverrides[ref];
        const stockThumbnailUrl = !overrideUrl && data?.manifest.textures?.[ref]
          ? `${import.meta.env.BASE_URL}data/thumbnails/${ref}`
          : null;
        const load = (url: string) => {
          const cacheKey = `${generation}\u0000${url}`;
          let thumbnail = layerThumbnailCacheRef.current.get(cacheKey);
          if (!thumbnail) {
            thumbnail = loadRgbaThumbnail(url).catch(() => null);
            layerThumbnailCacheRef.current.set(cacheKey, thumbnail);
          }
          return thumbnail;
        };
        let url = stockThumbnailUrl ?? overrideUrl ?? await sourceProvider.resolveThumbnail(ref);
        let pixels = await load(url);
        // Community definitions may assign a shipped texture that no stock
        // paint uses as a layer. Such refs have no generated thumbnail, so use
        // the same lazy exact path as an imported image instead of showing grey.
        if (!pixels && stockThumbnailUrl) {
          url = await sourceProvider.resolveThumbnail(ref);
          pixels = await load(url);
        }
        // Layer rows are identification aids, not a composited preview. Show
        // the authored RGB at full opacity so translucent masks remain easy to
        // tell apart at this small size.
        return [
          ref,
          pixels,
          pixels ? url === stockThumbnailUrl ? url : rgbaThumbnailDataUrl(pixels) : null,
        ] as const;
      } catch {
        return [ref, null, null] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      const next = Object.fromEntries(entries.map(([ref, thumbnail]) => [ref, thumbnail]));
      const nextUrls = Object.fromEntries(entries.map(([ref, , url]) => [ref, url]));
      setLayerTextureThumbnails((current) => {
        const keys = Object.keys(next);
        return keys.length === Object.keys(current).length
          && keys.every((key) => current[key] === next[key])
          ? current
          : next;
      });
      setLayerTexturePreviewUrls(nextUrls);
    });
    return () => { cancelled = true; };
  }, [
    activeTextureOverrides,
    assetOverrides.revision,
    definitions.generation,
    data?.manifest.textures,
    layerColorTextureRefs,
    packageGeneration,
    sourceProvider,
  ]);

  const editorLayerColors = useMemo(() => chooseEditorLayerColors(
    layerColorTextureRefs.map((textureRef, index) => ({
      thumbnail: textureRef ? layerTextureThumbnails[textureRef] : null,
      fallbackIndex: index,
    })),
  ), [layerColorTextureRefs, layerTextureThumbnails]);
  const activeEditorLayerColor = editorLayerColors[activeEditorLayerIndex]
    ?? EDITOR_LAYER_MAP_COLORS[activeEditorLayerIndex % EDITOR_LAYER_MAP_COLORS.length];
  // editorLayerColors are linear 0..1 triples, matching the shader math the
  // Viewer overlay uses. CSS colours are sRGB, so the context column swatches
  // and the parts board squares need their own converted copy or they will
  // read lighter than the on-model layer map they are meant to match.
  const editorLayerCssColors = useMemo(
    () => editorLayerColors.map((color) => linearLayerColorToCss(color, 1.35)),
    [editorLayerColors],
  );
  const editorLayerSwatchCssColors = useMemo(
    () => editorLayerColors.map((color) => linearLayerColorToCss(color, 1.85)),
    [editorLayerColors],
  );

  // Cache entries are keyed by the override they resolved, so a new overrides
  // object with the same paths (every edit builds one) must not flush the
  // decoded group images; only a change in the paths does.
  const activeTextureOverridesKey = useMemo(() => JSON.stringify(activeTextureOverrides), [activeTextureOverrides]);
  useEffect(() => {
    groupImageCacheRef.current.clear();
  }, [activeTextureOverridesKey, packageGeneration]);

  useEffect(() => {
    setHoverBucket(null);
    setGroupImageError(null);
    if (!displayedGroupRef) {
      setGroupImage(null);
      return;
    }
    let cancelled = false;
    void loadGroupImage(
      groupImageCacheRef.current,
      displayedGroupRef,
      packageGeneration,
      activeTextureOverrides,
      sourceProvider,
    ).then((image) => {
      if (!cancelled) setGroupImage(image);
    }).catch((cause) => {
        console.warn('[warpaint-viewer] editable areas could not be loaded:', cause);
        if (!cancelled) setGroupImageError('The editable areas could not be loaded.');
    });
    return () => { cancelled = true; };
  }, [activeTextureOverrides, displayedGroupRef, sourceProvider, packageGeneration]);

  const editorEnabled = editorStatus === 'ready' && Boolean(activeGroupEditTarget && groupImage);
  const groupAssignActive = editorEnabled && editorTabActive && editorTool === 'paint' && paintSubView === 'parts';

  useEffect(() => {
    if (!groupAssignActive || !showLayerMap) {
      setLayerMapImages({});
      return;
    }
    const refs = [...new Set(groupAssignmentTargets.map((target) => target.groupsRef))];
    let cancelled = false;
    void Promise.all(refs.map(async (ref) => {
      try {
        if (normalizeGroupTextureReference(ref) === normalizeGroupTextureReference(displayedGroupRef ?? '') && groupImage) {
          return [ref, groupImage] as const;
        }
        return [
          ref,
          await loadGroupImage(groupImageCacheRef.current, ref, packageGeneration, activeTextureOverrides, sourceProvider),
        ] as const;
      } catch (cause) {
        console.warn('[warpaint-viewer] one layer-map source could not be loaded:', cause);
        return null;
      }
    })).then((entries) => {
      if (!cancelled) setLayerMapImages(Object.fromEntries(entries.filter((entry) => entry !== null)));
    });
    return () => { cancelled = true; };
  }, [
    activeTextureOverrides,
    displayedGroupRef,
    groupAssignmentTargets,
    groupAssignActive,
    groupImage,
    packageGeneration,
    showLayerMap,
    sourceProvider,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    const pixels = groupImage?.data;
    const bucket = panelPreviewGroup ?? hoverBucket;
    if (!viewer) return;
    if (groupAssignActive
      && bucket !== null && bucket > 0
      && (pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)
      && groupImage) {
      viewer.setGroupHighlight(
        pixels,
        groupImage.width,
        groupImage.height,
        bucket,
        activeEditorLayerColor,
      );
    } else {
      viewer.clearGroupHighlight();
    }
  }, [
    activeEditorLayerColor,
    engineReady,
    groupAssignActive,
    groupImage,
    hoverBucket,
    panelPreviewGroup,
    viewerRef,
  ]);

  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    if (!groupAssignActive || !showLayerMap) {
      viewer.clearGroupLayerOverlay();
      return;
    }
    const maps = Object.entries(layerMapImages).flatMap(([groupsRef, image]) => {
      const pixels = image.data;
      if (!(pixels instanceof Uint8Array || pixels instanceof Uint8ClampedArray)) return [];
      const layers = groupAssignmentTargets.flatMap((target, layerIndex) => {
        if (target.groupsRef !== groupsRef) return [];
        const color = editorLayerColors[layerIndex]
          ?? EDITOR_LAYER_MAP_COLORS[layerIndex % EDITOR_LAYER_MAP_COLORS.length];
        return target.selectedGroupIds
          .map(groupByteToCompositorBucket)
          .filter((bucket): bucket is number => bucket !== null && bucket > 0)
          .filter((bucket, index, buckets) => buckets.indexOf(bucket) === index)
          .map((bucket) => ({ bucket, color }));
      });
      return layers.length > 0 ? [{
        pixels,
        width: image.width,
        height: image.height,
        layers,
      }] : [];
    });
    viewer.setGroupLayerOverlay(maps);
  }, [
    engineReady,
    editorLayerColors,
    groupAssignActive,
    groupAssignmentTargets,
    layerMapImages,
    showLayerMap,
    viewerRef,
  ]);

  useEffect(() => {
    if (groupAssignActive) return;
    groupPointerRef.current = null;
    setHoverBucket(null);
    setPanelPreviewGroup(null);
  }, [groupAssignActive]);
  const editorUnavailableReason = useMemo(() => {
    if (editableKitId === null) return 'Choose a war paint to edit.';
    if (editorStatus === 'loading') return 'Loading editable areas…';
    if (editorStatus === 'error') return 'This paint could not be opened.';
    if (!groupDiscovery) return 'This paint can’t be edited yet.';
    if (editableGroupTargets.length === 0) {
      return 'This paint can’t be edited yet.';
    }
    if (!activeGroupEditTarget) return 'Loading editable areas…';
    if (groupImageError) return groupImageError;
    if (!groupImage) return 'Loading editable areas…';
    return undefined;
  }, [editableKitId, editorStatus, groupDiscovery, editableGroupTargets.length, activeGroupEditTarget, groupImageError, groupImage]);

  const toggleEditorGroup = useCallback((bucket: number) => {
    if (weaponBaseLayerActive) {
      const owner = groupAssignmentTargets.find((target) => target.selectedGroupIds.some(
        (groupId) => groupByteToCompositorBucket(groupId) === bucket,
      ));
      if (!owner?.canAssign) return;
      const ownedIds = owner.selectedGroupIds.filter(
        (groupId) => groupByteToCompositorBucket(groupId) === bucket,
      );
      if (ownedIds.length === 0 || !clearSessionGroups(owner.target, ownedIds)) return;
      const part = formatGroupNameForDisplay(activeGroupLabels[bucket] ?? 'Part');
      setHoverBucket(null);
      setPanelPreviewGroup(null);
      setEditorAssignmentNotice(`${part} moved to ${baseTextureTransform?.label ?? 'the base texture'}.`);
      return;
    }
    if (!activeGroupEditTarget || !activeGroupAssignmentTarget) return;
    const selectedRawIds = activeSelectedRawGroupIds.filter(
      (groupId) => groupByteToCompositorBucket(groupId) === bucket,
    );
    const rawIds = selectedRawIds.length > 0
      ? selectedRawIds
      : [rawGroupIdForBucket(bucket)].filter((groupId): groupId is number => groupId !== null);
    let moveNotice: string | null = null;
    const results = assignSessionGroups(activeGroupAssignmentTarget, groupAssignmentTargets, rawIds);
    if (results && results.length > 0) {
      for (const result of results) {
        if (result.action !== 'moved') continue;
        const from = result.displacedLabels.length === 1
          ? result.displacedLabels[0]
          : result.displacedLabels.length > 1
            ? 'other paint layers'
            : 'another paint layer';
        const part = formatGroupNameForDisplay(activeGroupLabels[bucket] ?? 'Part');
        moveNotice = `${part} moved from ${from}.`;
      }
      // The marker is only a targeting aid. Once an edit lands, remove it so
      // the recomposed paint itself is immediately readable. This also covers
      // a chip being clicked while hovered: its unmount does not reliably
      // produce a mouse-leave event for the preview callback.
      setHoverBucket(null);
      setPanelPreviewGroup(null);
      setEditorAssignmentNotice(moveNotice);
    }
  }, [activeGroupAssignmentTarget, activeGroupEditTarget, activeGroupLabels, activeSelectedRawGroupIds, assignSessionGroups, baseTextureTransform?.label, clearSessionGroups, groupAssignmentTargets, weaponBaseLayerActive]);

  const clearEditorGroups = useCallback(() => {
    if (weaponBaseLayerActive || !activeGroupEditTarget) return;
    if (clearSessionGroups(activeGroupEditTarget, activeSelectedRawGroupIds)) {
      setHoverBucket(null);
      setPanelPreviewGroup(null);
      setEditorAssignmentNotice(null);
    }
  }, [activeGroupEditTarget, activeSelectedRawGroupIds, clearSessionGroups, weaponBaseLayerActive]);

  const sampleEditorSurface = useCallback((clientX: number, clientY: number) => {
    if (!groupAssignActive || !groupImage) return null;
    const hit = viewerRef.current?.pickWeaponUv(clientX, clientY);
    if (!hit) {
      setHoverBucket(null);
      return null;
    }
    const sampled = sampleGroupAtUv(groupImage, hit.uv[0], hit.uv[1]);
    if (!sampled) {
      setHoverBucket(null);
      return null;
    }
    setHoverBucket(sampled.bucket);
    return sampled;
  }, [groupAssignActive, groupImage, viewerRef]);

  const props: PartsEditorProps = {
    enabled: editorEnabled,
    unavailableReason: editorUnavailableReason,
    selectedGroupIds: activeSelectedGroupBuckets,
    selectionContextId: weaponBaseLayerActive ? 'weapon-base' : String(activeEditorSelector),
    groupLabels: activeGroupLabels,
    notice: editorAssignmentNotice,
    activeLayerIndex: activeEditorLayerIndex,
    activeLayerLabel: weaponBaseLayerActive ? baseTextureTransform?.label : editorSelectors[activeEditorLayerIndex]?.label,
    groupLayerIndex: groupBucketLayerIndex,
    layerColors: editorLayerCssColors,
    layerSwatchColors: editorLayerSwatchCssColors,
    layerThumbnails: editableLayerTextureRefs.map((textureRef) => (
      textureRef ? layerTexturePreviewUrls[textureRef] ?? null : null
    )),
    baseLayer: baseTextureTransform ? {
      label: baseTextureTransform.label,
      thumbnail: baseLayerTextureRef ? layerTexturePreviewUrls[baseLayerTextureRef] ?? null : null,
      active: weaponBaseLayerActive,
      onSelect: () => {
        setPanelPreviewGroup(null);
        setEditorAssignmentNotice(null);
        setWeaponBaseLayerActive(true);
      },
    } : undefined,
    showLayerMap,
    onShowLayerMapChange: setShowLayerMap,
    onToggleGroup: toggleEditorGroup,
    onClearSelection: clearEditorGroups,
    clearSelectionDisabled: weaponBaseLayerActive,
    onPreviewGroup: setPanelPreviewGroup,
    groupTextureChoices,
    activeGroupTextureRef: activeGroupTextureValue,
    onGroupTextureChange: groupTextureTarget ? (ref) => {
      const normalizedRef = normalizeGroupTextureReference(ref);
      setRequestedGroupTextureRef(normalizedRef);
      const defaultIds = preferredAlbedoGroupIds(ref).filter((groupId) => (
        !groupAssignmentTargets.some((target) => target.selectedGroupIds.includes(groupId))
      ));
      const albedoTarget = defaultIds.length > 0
        ? groupAssignmentTargets.find((target) => (
          target.canAssign && target.label.trim().toLowerCase() === 'albedo'
        ))
        : undefined;
      const defaultAssignment = albedoTarget ? {
        active: albedoTarget,
        candidates: groupAssignmentTargets,
        groupIds: defaultIds,
      } : undefined;
      if (setSessionGroupTexture(groupTextureTarget, ref, defaultAssignment)) {
        setHoverBucket(null);
        setPanelPreviewGroup(null);
      } else {
        setRequestedGroupTextureRef(null);
      }
    } : undefined,
    selectors: editorSelectors,
    activeSelectorId: weaponBaseLayerActive ? 'weapon-base' : String(activeEditorSelector),
    onActiveSelectorChange: (id) => {
      setPanelPreviewGroup(null);
      setEditorAssignmentNotice(null);
      setWeaponBaseLayerActive(false);
      setActiveEditorSelector(Number(id));
    },
  };

  return {
    groupImage,
    activeSelectedGroupBuckets,
    groupAssignActive,
    groupPointerRef,
    setHoverBucket,
    setPanelPreviewGroup,
    sampleEditorSurface,
    toggleEditorGroup,
    props,
  };
}
export type PartsEditor = ReturnType<typeof usePartsEditor>;
