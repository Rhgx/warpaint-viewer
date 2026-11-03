import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentProps } from 'react';

import type { DataSource } from '../../data/loader';
import type { useCustomDefinitions } from '../../hooks/useCustomDefinitions';
import type { SourceTextureProvider } from '../../source/provider';
import type { CustomWarpaintWorkbench } from '../../ui/workbench/CustomWarpaintWorkbench';
import type { ControlsState } from '../../viewer/controls';
import type { Viewer } from '../../viewer/Viewer';
import type { WarpaintAssetOverrides, WorkbenchTab } from '../../workbench/types';
import { discoverGroupTextureTarget, discoverLiteralGroupTextureTarget } from './groupTargets';
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
import { chooseEditorLayerColors, fallbackColor, linearLayerColorToCss } from './layerMap';
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
    | 'editorActiveScope'
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

const NO_LAYER_MAP_IMAGES: Record<string, RgbaImageDataLike> = {};
const NO_LAYER_THUMBNAILS: Record<string, RgbaImageDataLike | null> = {};
const NO_LAYER_PREVIEW_URLS: Record<string, string | null> = {};

/** Loads a group map through `cache`, keyed by package generation and override. Failed loads are evicted so they can retry. */
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

/** Part selection on the weapon surface: editable areas, the active layer's parts, Shift+click sampling and layer map overlays. */
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
  editorActiveScope,
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
  const [layerMapImages, setLayerMapImages] = useState(NO_LAYER_MAP_IMAGES);
  const [layerTextureThumbnails, setLayerTextureThumbnails] = useState(NO_LAYER_THUMBNAILS);
  const [layerTexturePreviewUrls, setLayerTexturePreviewUrls] = useState(NO_LAYER_PREVIEW_URLS);
  const layerThumbnailCacheRef = useRef(new Map<string, Promise<RgbaImageDataLike | null>>());
  const layerThumbnailGenerationRef = useRef('');
  const [panelPreviewGroup, setPanelPreviewGroup] = useState<number | null>(null);
  const groupPointerRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // Keep only the hovered bucket; a per-texel sample would re-render the app on every pointer move.
  const [hoverBucket, setHoverBucket] = useState<number | null>(null);

  useEffect(() => {
    if (!editorAssignmentNotice) return;
    const timeout = window.setTimeout(() => setEditorAssignmentNotice(null), 3000);
    return () => window.clearTimeout(timeout);
  }, [editorAssignmentNotice]);

  // A different paint or weapon starts with its own layer map, requested texture and group image.
  const [partsScope, setPartsScope] = useState({ kitId: editableKitId, weaponKey: state.weaponKey });
  if (partsScope.kitId !== editableKitId || partsScope.weaponKey !== state.weaponKey) {
    setPartsScope({ kitId: editableKitId, weaponKey: state.weaponKey });
    setShowLayerMap(false);
    setRequestedGroupTextureRef(null);
    setGroupImage(null);
  }

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
  const perWearSession = editorActiveScope !== null;
  const groupTextureTarget = useMemo(() => discoverGroupTextureTarget(
    provenanceRecipe?.provenance,
    activeGroupRef,
    activeWeaponVariablePath ? [...activeWeaponVariablePath, 'data', 'variable'] : undefined,
  ) ?? discoverLiteralGroupTextureTarget(activeGroupTarget?.groupsRef, perWearSession), [
    activeGroupRef,
    activeGroupTarget?.groupsRef,
    activeWeaponVariablePath,
    perWearSession,
    provenanceRecipe?.provenance,
  ]);

  if (requestedGroupTextureRef && requestedGroupTextureRef === resolvedGroupTextureValue) {
    setRequestedGroupTextureRef(null);
  }

  useEffect(() => {
    groupImageCacheRef.current.clear();
    autoAlbedoAssignmentKeysRef.current.clear();
  }, [editableKitId, state.weaponKey]);
  const activeGroupBuckets = useMemo(
    () => groupImage ? groupBucketsInImage(groupImage) : [],
    [groupImage],
  );
  // Inherited selector values show what the model uses until an edit locks them into the draft.
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
  // The parts board needs every part's owning layer, not only the active one, to show each chip's true state.
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
  // Target objects are recreated on each edit, but layer order and texture refs stay stable, so colours do not reshuffle.
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

  const hasLayerColorRefs = layerColorTextureRefs.some(Boolean);
  if (!hasLayerColorRefs && (layerTextureThumbnails !== NO_LAYER_THUMBNAILS || layerTexturePreviewUrls !== NO_LAYER_PREVIEW_URLS)) {
    setLayerTextureThumbnails(NO_LAYER_THUMBNAILS);
    setLayerTexturePreviewUrls(NO_LAYER_PREVIEW_URLS);
  }

  useEffect(() => {
    const generation = `${packageGeneration}:${definitions.generation}:${assetOverrides.revision}`;
    if (layerThumbnailGenerationRef.current !== generation) {
      layerThumbnailGenerationRef.current = generation;
      layerThumbnailCacheRef.current.clear();
    }
    const refs = [...new Set(layerColorTextureRefs
      .filter((ref): ref is string => Boolean(ref)))];
    if (refs.length === 0) return;
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
        // Community definitions may use shipped textures with no generated thumbnail; fall back to the exact image, not grey.
        if (!pixels && stockThumbnailUrl) {
          url = await sourceProvider.resolveThumbnail(ref);
          pixels = await load(url);
        }
        // Layer rows are identification aids: show authored RGB at full opacity so translucent masks stay distinct.
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
      const next = Object.fromEntries(entries.map(([ref, thumbnail]) => [ref, thumbnail] as const));
      const nextUrls = Object.fromEntries(entries.map(([ref, , url]) => [ref, url] as const));
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
    ?? fallbackColor(activeEditorLayerIndex);
  // Layer colours are linear 0..1 for the shader; CSS needs sRGB copies or swatches read lighter than the on-model map.
  const editorLayerCssColors = useMemo(
    () => editorLayerColors.map((color) => linearLayerColorToCss(color, 1.35)),
    [editorLayerColors],
  );
  const editorLayerSwatchCssColors = useMemo(
    () => editorLayerColors.map((color) => linearLayerColorToCss(color, 1.85)),
    [editorLayerColors],
  );

  // Key on the override paths, not object identity, so each edit does not flush decoded group images.
  const activeTextureOverridesKey = useMemo(() => JSON.stringify(activeTextureOverrides), [activeTextureOverrides]);
  useEffect(() => {
    groupImageCacheRef.current.clear();
  }, [activeTextureOverridesKey, packageGeneration]);

  const [groupImageInputs, setGroupImageInputs] = useState({
    activeTextureOverrides,
    displayedGroupRef,
    sourceProvider,
    packageGeneration,
  });
  if (groupImageInputs.activeTextureOverrides !== activeTextureOverrides
    || groupImageInputs.displayedGroupRef !== displayedGroupRef
    || groupImageInputs.sourceProvider !== sourceProvider
    || groupImageInputs.packageGeneration !== packageGeneration) {
    setGroupImageInputs({ activeTextureOverrides, displayedGroupRef, sourceProvider, packageGeneration });
    setHoverBucket(null);
    setGroupImageError(null);
    if (!displayedGroupRef) setGroupImage(null);
  }

  useEffect(() => {
    if (!displayedGroupRef) return;
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
      // Clearing a workspace can briefly ask for a path that does not exist; that load is already cancelled by then.
      if (cancelled) return;
      console.warn('[warpaint-viewer] editable areas could not be loaded:', cause);
      setGroupImageError('The editable areas could not be loaded.');
    });
    return () => { cancelled = true; };
  }, [activeTextureOverrides, displayedGroupRef, sourceProvider, packageGeneration]);

  const editorEnabled = editorStatus === 'ready' && Boolean(activeGroupEditTarget && groupImage);
  const groupAssignActive = editorEnabled && editorTabActive && editorTool === 'paint' && paintSubView === 'parts';

  const layerMapActive = groupAssignActive && showLayerMap;
  if (!layerMapActive && layerMapImages !== NO_LAYER_MAP_IMAGES) setLayerMapImages(NO_LAYER_MAP_IMAGES);

  useEffect(() => {
    if (!layerMapActive) return;
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
    groupImage,
    layerMapActive,
    packageGeneration,
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
          ?? fallbackColor(layerIndex);
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

  if (!groupAssignActive && (hoverBucket !== null || panelPreviewGroup !== null)) {
    setHoverBucket(null);
    setPanelPreviewGroup(null);
  }

  useEffect(() => {
    if (!groupAssignActive) groupPointerRef.current = null;
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
      // The hover marker is only a targeting aid, so clear it once an edit lands. This also covers a chip
      // clicked while hovered, which may not get a mouse-leave.
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
