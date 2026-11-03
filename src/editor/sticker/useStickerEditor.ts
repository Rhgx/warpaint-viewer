import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

import type { ComposeResult, Compositor } from '../../compositor/compositor';
import type { ResolvedNode } from '../../compositor/resolve';
import type { DataSource } from '../../data/loader';
import { applyTextureOverrides } from '../../hooks/useComposedPaint';
import type { SourceTextureProvider } from '../../source/provider';
import type { StickerTransformTool } from '../../ui/editor/stickerPlacementEditorTypes';
import type { ControlsState } from '../../viewer/controls';
import type { StickerGizmoDrag } from '../../viewer/overlays/stickerOverlay';
import type { Viewer } from '../../viewer/Viewer';
import { protoTextureReference, isStickerArtworkReference, stickerTargetLabel, textureChoiceLabel, discoverStickerPlacementTargets, type StickerPlacementTarget } from './stickerTargets';
import { stickerWeightFromString, texturePublicPath } from '../../protodefs/values';
import { collectPackageStickerSpecularOverrides, stickerSpecularRef } from '../../workbench/assetSlots';
import { isSupportedTexturePath } from '../../source/paths';
import { collectAppliedStickers } from '../layers/recipeLayers';
import {
  DEFAULT_STICKER_PLACEMENT,
  constrainStickerPlacementToTexture,
  fitStickerPlacement,
  stickerPlacementFromQuad,
  applyStickerPlacementToQuad,
  stickerPlacementToQuad,
  type StickerPlacement,
} from './stickerGeometry';
import {
  mapResolvedTextureReferences,
  recipeWithoutStickerOccurrences,
  resolvedGroupStickerContext,
  type ResolvedGroupStickerContext,
} from './stickerSurface';
import {
  matchResolvedStickerArtworkGroups,
  prepareStickerArtwork,
  stickerArtworkNeedsComposedPreview,
} from './stickerArtwork';
import { showStickerPreview } from './stickerPreview';
import { constrainStickerQuadToTexture, stickerQuadsEqual, type StickerPlacementQuad } from './viewerStickerPlacement';
import type { EditorCore } from '../useEditorCore';
import type { TransformEditor } from '../transform/useTransformEditor';
import type { WorkbenchEditorProps } from '../layers/usePartsEditor';

/** The sticker slice of the workbench editor props. */
type StickerEditorProps = NonNullable<WorkbenchEditorProps['sticker']>;

interface UseStickerEditorOptions extends
  Pick<EditorCore,
    | 'editableKitId'
    | 'editorCurrent'
    | 'editorTool'
    | 'setEditorTool'
    | 'provenanceRecipe'
    | 'setSessionStickerQuad'
    | 'addSessionSticker'
    | 'removeSessionSticker'
    | 'moveSessionSticker'
    | 'setSessionStickerBase'
    | 'setSessionStickerVariantWeight'
    | 'addSessionStickerVariant'
    | 'removeSessionStickerVariant'
    | 'setSessionStickerVariantBase'
    | 'equalizeSessionStickerVariantWeights'
    | 'undoEditor'
    | 'redoEditor'
    | 'resetEditor'
  >,
  Pick<TransformEditor, 'resolvedPreviewRecipe'> {
  state: ControlsState;
  data: DataSource | null;
  engineReady: boolean;
  /** Bumped after a WebGL context restore, which leaves the retained bases blank. */
  contextRestores: number;
  editorTabActive: boolean;
  viewerRef: React.RefObject<Viewer | null>;
  compositorRef: React.RefObject<Compositor | null>;
  selectedAssetKey: string;
  sourceProvider: SourceTextureProvider;
  packageGeneration: number;
  activeTextureOverrides: Record<string, string>;
  manualTextureOverrides: Record<string, string>;
  packageStickerSpecularOverrides: ReturnType<typeof collectPackageStickerSpecularOverrides>;
  mountedSourcePackage: SourceTextureProvider['package'];
  setHintDismissed: Dispatch<SetStateAction<boolean>>;
}

type StickerVariantSource = StickerPlacementTarget['stickers'][number];

interface GroupStickerResources {
  key: string;
  targetId: string;
  maskUrl: string;
  selectorBase: ComposeResult;
  selectorBaseUrl: string;
  endpointZero: ComposeResult;
  endpointZeroUrl: string;
  endpointOne: ComposeResult;
  endpointOneUrl: string;
  artworkUrl: string;
  levels: readonly [number, number, number];
}

/** Every variant's weight as resolved for the selected weapon, team, and wear. */
function resolvedVariantWeights(variants: readonly StickerVariantSource[]): number[] {
  return variants.map((variant) => stickerWeightFromString(variant.weight.resolvedValue));
}

/** Variant rows for the active sticker. `picked` marks the seeded artwork only when it is unambiguous. */
function stickerVariantRows(
  variants: readonly StickerVariantSource[],
  pickedBase: string | undefined,
  thumbnails: ReadonlyMap<string, string | null | undefined>,
  previewingIndex: number,
) {
  const values = variants.map((variant) => variant.base.resolvedValue ?? variant.base.authoredValue);
  const files = values.map((value) => texturePublicPath(value));
  const pickedCount = files.filter((file) => file !== null && file === pickedBase).length;
  return variants.map((variant, index) => {
    const value = values[index];
    return {
      index,
      baseReference: value,
      thumbnail: value ? (thumbnails.get(protoTextureReference(value)) ?? null) : null,
      weight: stickerWeightFromString(variant.weight.resolvedValue),
      picked: pickedCount === 1 && files[index] === pickedBase,
      previewing: index === previewingIndex,
    };
  });
}

/**
 * Sticker placement: targets, preview artwork, the direct-manipulation draft and panel props.
 * Also owns undo, redo and reset so a stale gesture cannot restore a discarded draft.
 */
export function useStickerEditor({
  editableKitId,
  editorCurrent,
  editorTool,
  setEditorTool,
  provenanceRecipe,
  setSessionStickerQuad,
  addSessionSticker,
  removeSessionSticker,
  moveSessionSticker,
  setSessionStickerBase,
  setSessionStickerVariantWeight,
  addSessionStickerVariant,
  removeSessionStickerVariant,
  setSessionStickerVariantBase,
  equalizeSessionStickerVariantWeights,
  undoEditor,
  redoEditor,
  resetEditor,
  resolvedPreviewRecipe,
  state,
  data,
  engineReady,
  contextRestores,
  editorTabActive,
  viewerRef,
  compositorRef,
  selectedAssetKey,
  sourceProvider,
  packageGeneration,
  activeTextureOverrides,
  manualTextureOverrides,
  packageStickerSpecularOverrides,
  mountedSourcePackage,
  setHintDismissed,
}: UseStickerEditorOptions) {
  // One mode for both UV and on-model controls, so a handle in one view never moves the other.
  const [stickerTransformTool, setStickerTransformTool] = useState<StickerTransformTool>('move');
  const [stickerAspectLocked, setStickerAspectLocked] = useState(true);
  const [modelPartPickingActive, setModelPartPickingActive] = useState(false);
  const [hiddenModelPartCount, setHiddenModelPartCount] = useState(0);
  const [activeStickerTarget, setActiveStickerTarget] = useState(0);
  // Pinned preview variant. It names its sticker, so a stale pin never applies elsewhere.
  const [previewVariant, setPreviewVariant] = useState<{ targetId: string; index: number } | null>(null);
  const [pendingAddedStickerRef, setPendingAddedStickerRef] = useState<string | null>(null);
  const [stickerTargetThumbnails, setStickerTargetThumbnails] = useState<Record<string, string>>({});
  const [stickerTargetArtwork, setStickerTargetArtwork] = useState<Record<string, string>>({});
  const [stickerSpecularUrl, setStickerSpecularUrl] = useState<string | null>(null);
  const [groupStickerArtwork, setGroupStickerArtwork] = useState<Record<string, { key: string; url: string }>>({});
  const [stickerSurfaceUrl, setStickerSurfaceUrl] = useState<string | null>(null);
  const [stickerBaseSurfaceKey, setStickerBaseSurfaceKey] = useState<string | null>(null);
  const [groupStickerResources, setGroupStickerResources] = useState<GroupStickerResources | null>(null);
  const groupStickerResourcesKey = groupStickerResources?.key ?? null;
  const [stickerAspect, setStickerAspect] = useState(1);
  const [stickerSurfaceAspect, setStickerSurfaceAspect] = useState(1.6);
  const [stickerDraftStore] = useState(() => createStore<StickerPlacementQuad | null>(() => null));
  const stickerDraftActive = useStore(stickerDraftStore, (quad) => quad !== null);
  const stickerDraftRef = useRef<StickerPlacementQuad | null>(null);
  const stickerBaseSurfaceResultRef = useRef<ComposeResult | null>(null);
  const groupStickerResourcesRef = useRef<GroupStickerResources | null>(null);
  const groupStickerPreparationRef = useRef<{
    targetId: string;
    context: ResolvedGroupStickerContext;
  } | null>(null);
  const stickerArtworkCacheRef = useRef(new Map<string, { url: string; dispose(): void }>());
  const stickerGestureRef = useRef<{
    pointerId: number;
    base: StickerPlacementQuad;
    latest: StickerPlacementQuad;
  } | null>(null);
  const stickerGizmoGestureRef = useRef<{
    pointerId: number;
    drag: StickerGizmoDrag;
    preserveAspect: boolean;
    base: StickerPlacementQuad;
    latest: StickerPlacementQuad;
  } | null>(null);
  const modelPartPointerRef = useRef<{
    pointerId: number;
    captureTarget: HTMLDivElement;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const updateStickerDraft = useCallback((quad: StickerPlacementQuad | null) => {
    stickerDraftRef.current = quad;
    stickerDraftStore.setState(quad, true);
  }, [stickerDraftStore]);
  const discardStickerDraft = useCallback(() => {
    // Draft coordinates live only during a gesture. History replaces the authored proto, so a stale draft must not win.
    stickerGestureRef.current = null;
    stickerGizmoGestureRef.current = null;
    updateStickerDraft(null);
  }, [updateStickerDraft]);
  const undoEditorSynced = useCallback(() => {
    discardStickerDraft();
    undoEditor();
  }, [discardStickerDraft, undoEditor]);
  const redoEditorSynced = useCallback(() => {
    discardStickerDraft();
    redoEditor();
  }, [discardStickerDraft, redoEditor]);
  const resetEditorSynced = useCallback(() => {
    discardStickerDraft();
    resetEditor();
  }, [discardStickerDraft, resetEditor]);
  const allStickerTextureChoices = useMemo(() => {
    const choices = new Map<string, { ref: string; label: string; thumbnail?: string | null }>();
    for (const reference of Object.keys(data?.manifest.textures ?? {})) {
      if (!isStickerArtworkReference(reference)) continue;
      const ref = protoTextureReference(reference);
      choices.set(ref, { ref, label: textureChoiceLabel(reference), thumbnail: data?.resolveTexture(reference) });
    }
    for (const [reference, thumbnail] of Object.entries(activeTextureOverrides)) {
      if (!isStickerArtworkReference(reference)) continue;
      const ref = protoTextureReference(reference);
      choices.set(ref, { ref, label: textureChoiceLabel(reference), thumbnail });
    }
    for (const entry of mountedSourcePackage?.entries.values() ?? []) {
      if (!isSupportedTexturePath(entry.path) || !isStickerArtworkReference(entry.path)) continue;
      const ref = protoTextureReference(entry.path);
      if (!choices.has(ref)) choices.set(ref, { ref, label: textureChoiceLabel(entry.path) });
    }
    return [...choices.values()].sort((a, b) => a.label.localeCompare(b.label) || a.ref.localeCompare(b.ref));
  }, [activeTextureOverrides, data, mountedSourcePackage]);

  const stickerTargets = useMemo(
    () => editorCurrent ? discoverStickerPlacementTargets(editorCurrent, provenanceRecipe) : [],
    [editorCurrent, provenanceRecipe],
  );

  const currentStickerTextureChoices = useMemo(() => {
    const choices = new Map(allStickerTextureChoices.map((choice) => [choice.ref, choice]));
    const generatedReferences = Object.keys(data?.manifest.textures ?? {});
    const generatedReferencesByProtoRef = new Map(
      generatedReferences.map((reference) => [protoTextureReference(reference), reference]),
    );
    const referenced = stickerTargets.flatMap((target) => target.stickers.flatMap((sticker) => {
      const value = sticker.base.resolvedValue ?? sticker.base.authoredValue;
      if (!value) return [];
      try {
        const ref = protoTextureReference(value);
        if (!choices.has(ref)) {
          const generated = generatedReferencesByProtoRef.get(ref);
          choices.set(ref, {
            ref,
            label: textureChoiceLabel(value),
            thumbnail: generated ? data?.resolveTexture(generated) : undefined,
          });
        }
        return [ref];
      } catch { return []; }
    }));
    return [...new Set(referenced)].flatMap((ref) => choices.get(ref) ?? []);
  }, [allStickerTextureChoices, data, stickerTargets]);
  const resolvedStickerStages = useMemo(
    () => resolvedPreviewRecipe ? collectAppliedStickers(resolvedPreviewRecipe) : [],
    [resolvedPreviewRecipe],
  );
  const matchedStickerStageGroups = useMemo(() => matchResolvedStickerArtworkGroups(
    stickerTargets.map((target) => ({
      bases: target.stickers.flatMap((sticker) => [sticker.base.resolvedValue, sticker.base.authoredValue]),
      quad: target.quad,
      occurrenceCount: target.occurrences.length,
    })),
    resolvedStickerStages,
  ), [resolvedStickerStages, stickerTargets]);
  const selectedStickerIndex = stickerTargets[activeStickerTarget] ? activeStickerTarget : (stickerTargets.length > 0 ? 0 : -1);
  const selectedStickerTarget = selectedStickerIndex >= 0 ? stickerTargets[selectedStickerIndex] : null;
  const previewedVariantIndex = selectedStickerTarget && previewVariant?.targetId === selectedStickerTarget.id
    && selectedStickerTarget.stickers[previewVariant.index]
    ? previewVariant.index
    : -1;
  const previewedVariant = selectedStickerTarget && previewedVariantIndex >= 0
    ? selectedStickerTarget.stickers[previewedVariantIndex]
    : null;
  // Resolved stages use public texture paths, so convert the variant's raw reference the same way.
  const previewedVariantBase = previewedVariant
    ? texturePublicPath(previewedVariant.base.resolvedValue ?? previewedVariant.base.authoredValue) ?? undefined
    : undefined;
  // A pinned variant replaces the seeded artwork for its sticker only. Keep the resolved stage object: the group context finds it by identity.
  const matchedStickerStages = useMemo(() => matchedStickerStageGroups.map((stages, index) => {
    const stage = stages[0] ?? null;
    if (!stage || index !== selectedStickerIndex || !previewedVariant || !previewedVariantBase) return stage;
    return {
      ...stage,
      base: previewedVariantBase,
      spec: texturePublicPath(previewedVariant.spec.resolvedValue ?? previewedVariant.spec.authoredValue) ?? undefined,
    };
  }), [matchedStickerStageGroups, previewedVariant, previewedVariantBase, selectedStickerIndex]);
  const composedStickerTargetIds = useMemo(() => new Set(stickerTargets.filter((target) => (
    stickerArtworkNeedsComposedPreview(target.stickers.flatMap((sticker) => [
      sticker.base.resolvedValue,
      sticker.base.authoredValue,
    ]))
  )).map((target) => target.id)), [stickerTargets]);
  const selectedStickerUsesComposedArtwork = selectedStickerTarget
    ? composedStickerTargetIds.has(selectedStickerTarget.id)
    : false;
  const selectedResolvedStickerStages = useMemo(() => {
    if (selectedStickerIndex < 0) return [];
    return matchedStickerStageGroups[selectedStickerIndex] ?? [];
  }, [matchedStickerStageGroups, selectedStickerIndex]);
  const selectedStickerSpecularRef = (() => {
    const sticker = matchedStickerStages[selectedStickerIndex];
    if (!sticker) return null;
    if (sticker.spec) return sticker.spec;
    const inferred = stickerSpecularRef(sticker.base);
    return packageStickerSpecularOverrides[inferred] || manualTextureOverrides[inferred] ? inferred : null;
  })();
  const selectedGroupStickerContext = useMemo(() => {
    if (!selectedStickerUsesComposedArtwork || selectedResolvedStickerStages.length === 0 || !resolvedPreviewRecipe) return null;
    const context = resolvedGroupStickerContext(resolvedPreviewRecipe, selectedResolvedStickerStages);
    if (!context) return null;
    const mapReference = (reference: string) => activeTextureOverrides[reference] ?? reference;
    return {
      ...context,
      // The group mask is the sticker's base, so a pinned variant replaces it here.
      sticker: previewedVariantBase ? { ...context.sticker, base: previewedVariantBase } : context.sticker,
      base: mapResolvedTextureReferences(context.base, mapReference),
      selectorBase: mapResolvedTextureReferences(context.selectorBase, mapReference),
      endpointZero: mapResolvedTextureReferences(context.endpointZero, mapReference),
      endpointOne: mapResolvedTextureReferences(context.endpointOne, mapReference),
    };
  }, [activeTextureOverrides, previewedVariantBase, resolvedPreviewRecipe, selectedResolvedStickerStages, selectedStickerUsesComposedArtwork]);
  const authoredStickerQuad = selectedStickerTarget?.quad ?? null;
  const stickerPlacementRead = useMemo(
    () => authoredStickerQuad ? stickerPlacementFromQuad(authoredStickerQuad) : { editable: false as const },
    [authoredStickerQuad],
  );
  const stickerPlacement = stickerPlacementRead.placement;
  const stickerTargetEditable = Boolean(selectedStickerTarget?.editable && authoredStickerQuad);
  const stickerEditorEnabled = Boolean(stickerTargetEditable && stickerPlacement);
  // Remove only this sticker occurrence from the full recipe; composing just its child would lose visible work.
  const stickerSurfaceNode = useMemo(
    () => selectedStickerTarget
      ? recipeWithoutStickerOccurrences(provenanceRecipe?.tree ?? null, selectedStickerTarget.occurrences)
      : null,
    [selectedStickerTarget, provenanceRecipe],
  );
  // Destination points are absent, so the key stays stable while a sticker moves.
  const stickerSurfaceComposeKey = useMemo(() => {
    if (!stickerSurfaceNode) return null;
    return JSON.stringify({
      recipe: stickerSurfaceNode,
      seed: state.seed,
      overrides: activeTextureOverrides,
      weapon: state.weaponKey,
      contextRestores,
    });
  }, [activeTextureOverrides, contextRestores, state.seed, state.weaponKey, stickerSurfaceNode]);
  const groupStickerComposeKey = selectedStickerUsesComposedArtwork && selectedStickerTarget
    && selectedGroupStickerContext && stickerSurfaceComposeKey
    ? `${selectedStickerTarget.id}\0${stickerSurfaceComposeKey}\0${activeTextureOverrides[selectedGroupStickerContext.sticker.base] ?? selectedGroupStickerContext.sticker.base}\0${selectedGroupStickerContext.sticker.black}\0${selectedGroupStickerContext.sticker.white}\0${selectedGroupStickerContext.sticker.gamma}`
    : null;
  useLayoutEffect(() => {
    groupStickerPreparationRef.current = selectedStickerTarget && selectedGroupStickerContext
      ? { targetId: selectedStickerTarget.id, context: selectedGroupStickerContext }
      : null;
  });
  const preparedGroupStickerArtwork = selectedStickerTarget
    ? groupStickerArtwork[selectedStickerTarget.id]
    : null;
  const stickerTextureUrl = selectedStickerTarget
    ? selectedStickerUsesComposedArtwork
      ? preparedGroupStickerArtwork?.key === groupStickerComposeKey
        ? preparedGroupStickerArtwork.url
        : null
      : stickerTargetArtwork[selectedStickerTarget.id] ?? null
    : null;
  const exactGroupStickerResources = groupStickerResourcesKey === groupStickerComposeKey
    ? groupStickerResources
    : null;
  // The draft stays authoritative until the provenance recipe reports the committed destination.
  // The base does not depend on destination, so retained resources avoid a preparation flash.
  const destinationEditSettling = Boolean(stickerDraftActive && selectedStickerTarget);
  const retainedGroupStickerResources = destinationEditSettling
    && groupStickerResources?.targetId === selectedStickerTarget?.id
    ? groupStickerResources
    : null;
  const activeGroupStickerResources = exactGroupStickerResources ?? retainedGroupStickerResources;
  const effectiveStickerTextureUrl = stickerTextureUrl
    ?? (selectedStickerUsesComposedArtwork ? retainedGroupStickerResources?.artworkUrl ?? null : null);

  const [specularInputs, setSpecularInputs] = useState({
    manualTextureOverrides,
    packageGeneration,
    selectedStickerSpecularRef,
    selectedStickerUsesComposedArtwork,
    sourceProvider,
  });
  if (specularInputs.manualTextureOverrides !== manualTextureOverrides
    || specularInputs.packageGeneration !== packageGeneration
    || specularInputs.selectedStickerSpecularRef !== selectedStickerSpecularRef
    || specularInputs.selectedStickerUsesComposedArtwork !== selectedStickerUsesComposedArtwork
    || specularInputs.sourceProvider !== sourceProvider) {
    setSpecularInputs({
      manualTextureOverrides,
      packageGeneration,
      selectedStickerSpecularRef,
      selectedStickerUsesComposedArtwork,
      sourceProvider,
    });
    setStickerSpecularUrl(null);
  }

  useEffect(() => {
    if (selectedStickerUsesComposedArtwork || !selectedStickerSpecularRef) return;
    let cancelled = false;
    const override = manualTextureOverrides[selectedStickerSpecularRef];
    void (override ? Promise.resolve(override) : sourceProvider.resolvePreview(selectedStickerSpecularRef))
      .then((url) => { if (!cancelled) setStickerSpecularUrl(url); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [
    manualTextureOverrides,
    packageGeneration,
    selectedStickerSpecularRef,
    selectedStickerUsesComposedArtwork,
    sourceProvider,
  ]);
  const groupStickerUvPreview = selectedStickerUsesComposedArtwork
    && activeGroupStickerResources
    ? {
        maskSrc: activeGroupStickerResources.maskUrl,
        selectorBaseSrc: activeGroupStickerResources.selectorBaseUrl,
        endpointZeroSrc: activeGroupStickerResources.endpointZeroUrl,
        endpointOneSrc: activeGroupStickerResources.endpointOneUrl,
        levels: activeGroupStickerResources.levels,
      }
    : null;
  // Both views need the same stripped base, so show preparation until the target and artwork are ready.
  const stickerEditorReady = Boolean(
    stickerEditorEnabled
    && effectiveStickerTextureUrl
    && (stickerBaseSurfaceKey === stickerSurfaceComposeKey || destinationEditSettling)
    && stickerBaseSurfaceKey !== null
    && (!selectedStickerUsesComposedArtwork
      || groupStickerResourcesKey === groupStickerComposeKey
      || activeGroupStickerResources)
  );

  if (activeStickerTarget > 0 && activeStickerTarget >= stickerTargets.length) setActiveStickerTarget(0);

  useEffect(() => {
    if (stickerTargets.length === 0 && editorTool === 'sticker') setEditorTool('paint');
  }, [editorTool, setEditorTool, stickerTargets.length]);

  if (pendingAddedStickerRef) {
    const addedIndex = stickerTargets.findLastIndex((target) => target.stickers.some((sticker) => (
      sticker.base.resolvedValue === pendingAddedStickerRef
      || sticker.base.authoredValue === pendingAddedStickerRef
    )));
    if (addedIndex >= 0) {
      setActiveStickerTarget(addedIndex);
      setPendingAddedStickerRef(null);
    }
  }

  useEffect(() => {
    updateStickerDraft(null);
  }, [activeStickerTarget, editableKitId, state.weaponKey, updateStickerDraft]);

  const previewVariantScope = JSON.stringify([activeStickerTarget, editableKitId, editorTool, state.weaponKey]);
  const [seenPreviewVariantScope, setSeenPreviewVariantScope] = useState(previewVariantScope);
  if (seenPreviewVariantScope !== previewVariantScope) {
    setSeenPreviewVariantScope(previewVariantScope);
    setPreviewVariant(null);
  }

  useEffect(() => {
    viewerRef.current?.resetStickerGizmoAnchor();
  }, [selectedStickerTarget?.id, editableKitId, state.weaponKey, viewerRef]);

  useEffect(() => {
    // Keep a completed gesture's draft until the authored quad catches up, or it snaps back for a frame.
    // History actions clear drafts through the synchronized wrappers above.
    if (stickerGestureRef.current || stickerGizmoGestureRef.current) return;
    const draft = stickerDraftRef.current;
    if (draft && authoredStickerQuad && stickerQuadsEqual(draft, authoredStickerQuad)) {
      discardStickerDraft();
    }
  }, [authoredStickerQuad, discardStickerDraft]);

  // Show the stage output, not the raw source: some Flak Furnished stickers are white masks that only their levels make visible.
  useEffect(() => {
    let cancelled = false;
    const created = new Map<string, { url: string; dispose(): void }>();
    void (async () => {
      const cache = stickerArtworkCacheRef.current;
      const currentKeys = new Set<string>();
      const entries = await Promise.all(stickerTargets.map(async (target, index) => {
        const resolved = matchedStickerStages[index];
        const ref = resolved?.base ?? target.stickers[0]?.base.resolvedValue;
        if (!ref) return [target.id, null] as const;
        try {
          // Group artwork comes from the compositor effect below; raw c0/c1 sources are untruthful previews, most visibly for black selectors.
          if (composedStickerTargetIds.has(target.id)) return [target.id, null] as const;
          const sourceUrl = activeTextureOverrides[ref] ?? await sourceProvider.resolvePreview(ref);
          const levels = {
            black: resolved?.black ?? 0,
            white: resolved?.white ?? 1,
            gamma: resolved?.gamma ?? 1,
          };
          const key = `${target.id}\0decal\0${sourceUrl}\0${levels.black}\0${levels.white}\0${levels.gamma}`;
          currentKeys.add(key);
          let artwork = cache.get(key);
          if (!artwork) {
            artwork = await prepareStickerArtwork(sourceUrl, levels);
            created.set(key, artwork);
            cache.set(key, artwork);
          }
          return [target.id, artwork.url, artwork.url] as const;
        } catch {
          return [target.id, null] as const;
        }
      }));
      if (cancelled) {
        for (const [key, artwork] of created) {
          if (cache.get(key) === artwork) cache.delete(key);
          artwork.dispose();
        }
        return;
      }
      const nextArtwork: Record<string, string> = {};
      const nextThumbnails: Record<string, string> = {};
      for (const [id, artworkUrl, thumbnailUrl] of entries) {
        if (artworkUrl) nextArtwork[id] = artworkUrl;
        if (thumbnailUrl) nextThumbnails[id] = thumbnailUrl;
      }
      setStickerTargetArtwork(nextArtwork);
      setStickerTargetThumbnails(nextThumbnails);
      for (const [key, artwork] of cache) {
        if (currentKeys.has(key)) continue;
        cache.delete(key);
        artwork.dispose();
      }
    })().catch(() => {
      for (const [key, artwork] of created) {
        if (stickerArtworkCacheRef.current.get(key) === artwork) stickerArtworkCacheRef.current.delete(key);
        artwork.dispose();
      }
    });
    return () => { cancelled = true; };
  }, [
    activeTextureOverrides,
    composedStickerTargetIds,
    matchedStickerStages,
    packageGeneration,
    sourceProvider,
    stickerTargets,
  ]);

  // Prepared group artwork depends on paint, weapon and seed, not destination, so destination-only edits stay instant.
  const groupArtworkScope = JSON.stringify([
    editableKitId,
    packageGeneration,
    state.seed,
    state.team,
    state.wearIndex,
    state.weaponKey,
  ]);
  const [seenGroupArtworkScope, setSeenGroupArtworkScope] = useState(groupArtworkScope);
  if (seenGroupArtworkScope !== groupArtworkScope) {
    setSeenGroupArtworkScope(groupArtworkScope);
    setGroupStickerArtwork({});
  }

  useEffect(() => () => {
    for (const artwork of stickerArtworkCacheRef.current.values()) artwork.dispose();
    stickerArtworkCacheRef.current.clear();
  }, []);

  // Stickers use a retained base with their stage removed. Group stickers rebuild their layer selector from the full source mask.
  useEffect(() => {
    const viewer = viewerRef.current;
    const compositor = compositorRef.current;
    const discardCurrentBase = () => {
      viewer?.clearStickerPreview();
      viewer?.setStickerEditorBaseMap(null);
      const current = stickerBaseSurfaceResultRef.current;
      stickerBaseSurfaceResultRef.current = null;
      if (current && compositor) compositor.releaseResult(current);
      setStickerBaseSurfaceKey(null);
    };

    if (!engineReady || editorTool !== 'sticker' || !data || !stickerSurfaceNode || !stickerSurfaceComposeKey) {
      discardCurrentBase();
      // The state resets pair with releasing the compositor result above; both follow the external base composition.
      // oxlint-disable-next-line react/set-state-in-effect
      setStickerSurfaceUrl(null);
      return;
    }
    const weapon = data.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    if (!compositor || !weapon) return;
    // A destination-only edit keeps the stripped recipe, so keep the base until the new location's composite arrives.
    if (stickerBaseSurfaceKey === stickerSurfaceComposeKey && stickerBaseSurfaceResultRef.current) return;

    discardCurrentBase();
    setStickerSurfaceUrl(null);
    let cancelled = false;
    const dimensions = {
      width: weapon.compositeWidth ?? 1024,
      height: weapon.compositeHeight ?? 1024,
    };
    const composition = selectedGroupStickerContext
      ? compositor.composeResolved(selectedGroupStickerContext.base, dimensions)
      : compositor.compose(applyTextureOverrides(stickerSurfaceNode, activeTextureOverrides), state.seed, dimensions);
    void composition.then((result) => {
      if (cancelled) {
        compositor.releaseResult(result);
        return;
      }
      stickerBaseSurfaceResultRef.current = result;
      setStickerSurfaceUrl(compositor.toPreviewDataUrl(result.target));
      setStickerBaseSurfaceKey(stickerSurfaceComposeKey);
    }).catch(() => {
      if (!cancelled) setStickerBaseSurfaceKey(null);
    });
    return () => { cancelled = true; };
  }, [
    activeTextureOverrides,
    data,
    editorTool,
    engineReady,
    packageGeneration,
    state.seed,
    state.weaponKey,
    selectedGroupStickerContext,
    stickerBaseSurfaceKey,
    stickerSurfaceComposeKey,
    stickerSurfaceNode,
    viewerRef,
    compositorRef,
  ]);

  // Group stickers write a layer selector, not RGBA. Retain the selector and both endpoints so movement only changes destination uniforms.
  useEffect(() => {
    const compositor = compositorRef.current;
    const viewer = viewerRef.current;
    const preparation = groupStickerPreparationRef.current;
    const release = (resources: typeof groupStickerResourcesRef.current) => {
      if (!resources || !compositor) return;
      compositor.releaseResult(resources.selectorBase);
      compositor.releaseResult(resources.endpointZero);
      compositor.releaseResult(resources.endpointOne);
    };
    const previous = groupStickerResourcesRef.current;
    if (previous?.key === groupStickerComposeKey) {
      setGroupStickerResources(previous);
      return;
    }
    if (previous) {
      viewer?.clearStickerPreview();
      groupStickerResourcesRef.current = null;
      release(previous);
    }
    setGroupStickerResources(null);

    if (!engineReady || editorTool !== 'sticker' || !data || !compositor
      || !preparation || !groupStickerComposeKey) return;
    const weapon = data.manifest.weapons.find((entry) => entry.key === state.weaponKey);
    if (!weapon) return;
    let cancelled = false;
    const produced: ComposeResult[] = [];
    const dimensions = {
      width: weapon.compositeWidth ?? 1024,
      height: weapon.compositeHeight ?? 1024,
    };
    const compose = async (node: ResolvedNode) => {
      const result = await compositor.composeResolved(node, dimensions);
      produced.push(result);
      return result;
    };
    void (async () => {
      const { context, targetId } = preparation;
      const maskRef = context.sticker.base;
      const maskUrl = activeTextureOverrides[maskRef] ?? await sourceProvider.resolvePreview(maskRef);
      const selectorBase = await compose(context.selectorBase);
      const endpointZero = await compose(context.endpointZero);
      const endpointOne = await compose(context.endpointOne);
      const selectorBaseUrl = compositor.toPreviewDataUrl(selectorBase.target);
      const endpointZeroUrl = compositor.toPreviewDataUrl(endpointZero.target);
      const endpointOneUrl = compositor.toPreviewDataUrl(endpointOne.target);
      const levels = [
        context.sticker.black,
        context.sticker.white,
        context.sticker.gamma,
      ] as const;
      const artworkUrl = await compositor.composeGroupStickerArtworkDataUrl({
        mask: maskRef,
        selectorBase: selectorBase.texture,
        endpointZero: endpointZero.texture,
        endpointOne: endpointOne.texture,
        levels,
        destTl: context.sticker.destTl,
        destTr: context.sticker.destTr,
        destBl: context.sticker.destBl,
      });
      if (cancelled) {
        for (const result of produced) compositor.releaseResult(result);
        return;
      }
      const resources: GroupStickerResources = {
        key: groupStickerComposeKey,
        targetId,
        maskUrl,
        selectorBase,
        selectorBaseUrl,
        endpointZero,
        endpointZeroUrl,
        endpointOne,
        endpointOneUrl,
        artworkUrl,
        levels,
      };
      groupStickerResourcesRef.current = resources;
      setGroupStickerArtwork((current) => ({
        ...current,
        [targetId]: { key: groupStickerComposeKey, url: artworkUrl },
      }));
      setGroupStickerResources(resources);
    })().catch(() => {
      for (const result of produced) compositor.releaseResult(result);
      if (!cancelled) setGroupStickerResources(null);
    });

    return () => {
      cancelled = true;
      const current = groupStickerResourcesRef.current;
      if (current?.key === groupStickerComposeKey) {
        viewer?.clearStickerPreview();
        groupStickerResourcesRef.current = null;
        release(current);
      }
    };
  }, [
    activeTextureOverrides,
    data,
    editorTool,
    engineReady,
    groupStickerComposeKey,
    sourceProvider,
    state.weaponKey,
    viewerRef,
    compositorRef,
  ]);

  // The editor owns the composed base while Viewer uses it. Release it only when abandoned or unmounted, not on ordinary renders.
  useEffect(() => () => {
    const result = stickerBaseSurfaceResultRef.current;
    stickerBaseSurfaceResultRef.current = null;
    viewerRef.current?.setStickerEditorBaseMap(null);
    if (result) compositorRef.current?.releaseResult(result);
  }, [compositorRef, viewerRef]);

  useEffect(() => {
    let cancelled = false;
    const measure = (url: string | null, fallback: number, install: (value: number) => void) => {
      if (!url) {
        install(fallback);
        return;
      }
      const image = new Image();
      image.onload = () => {
        if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
          install(image.naturalWidth / image.naturalHeight);
        }
      };
      image.onerror = () => { if (!cancelled) install(fallback); };
      image.src = url;
    };
    measure(effectiveStickerTextureUrl, 1, setStickerAspect);
    measure(stickerSurfaceUrl, 1.6, setStickerSurfaceAspect);
    return () => { cancelled = true; };
  }, [effectiveStickerTextureUrl, stickerSurfaceUrl]);
  const stickerEditingActive = editorTabActive && editorTool === 'sticker';
  const stickerEditorPreparing = editorTabActive && editorTool === 'sticker'
    && stickerTargetEditable && !stickerEditorReady;
  const stickerPlacementActive = editorTabActive && editorTool === 'sticker' && stickerEditorReady;
  const stickerPartPickingActive = stickerEditingActive && modelPartPickingActive;
  const clearModelPartPickingInteraction = useCallback(() => {
    const gesture = modelPartPointerRef.current;
    if (gesture?.captureTarget.hasPointerCapture(gesture.pointerId)) {
      gesture.captureTarget.releasePointerCapture(gesture.pointerId);
    }
    modelPartPointerRef.current = null;
    viewerRef.current?.clearModelPartHover();
  }, [viewerRef]);

  const releaseModelPartPicking = useCallback(() => {
    viewerRef.current?.restoreHiddenModelParts();
    clearModelPartPickingInteraction();
  }, [clearModelPartPickingInteraction, viewerRef]);

  // Hidden parts must not leak into another model or editor session.
  const modelPartPickingScope = JSON.stringify([selectedAssetKey, state.weaponKey]);
  const [seenModelPartPickingScope, setSeenModelPartPickingScope] = useState(modelPartPickingScope);
  const modelPartPickingIdle = !(stickerEditingActive && engineReady);
  if (seenModelPartPickingScope !== modelPartPickingScope
    || (modelPartPickingIdle && (modelPartPickingActive || hiddenModelPartCount !== 0))) {
    setSeenModelPartPickingScope(modelPartPickingScope);
    setModelPartPickingActive(false);
    setHiddenModelPartCount(0);
  }

  useEffect(() => {
    if (stickerEditingActive && engineReady) return;
    releaseModelPartPicking();
  }, [engineReady, releaseModelPartPicking, stickerEditingActive]);

  useEffect(() => {
    releaseModelPartPicking();
  }, [releaseModelPartPicking, selectedAssetKey, state.weaponKey]);

  useEffect(() => {
    if (stickerPartPickingActive) return;
    clearModelPartPickingInteraction();
  }, [clearModelPartPickingInteraction, stickerPartPickingActive]);

  const beginStickerInteraction = useCallback(() => {
    if (authoredStickerQuad) stickerDraftRef.current = authoredStickerQuad;
  }, [authoredStickerQuad]);

  const previewStickerDraft = useCallback((quad: StickerPlacementQuad) => {
    if (!stickerPlacementActive || !effectiveStickerTextureUrl) return;
    showStickerPreview(viewerRef.current, quad, {
      groupResources: selectedStickerUsesComposedArtwork ? activeGroupStickerResources : null,
      textureUrl: effectiveStickerTextureUrl,
      specularUrl: stickerSpecularUrl,
      tool: stickerTransformTool,
    });
  }, [
    activeGroupStickerResources,
    selectedStickerUsesComposedArtwork,
    stickerPlacementActive,
    effectiveStickerTextureUrl,
    stickerSpecularUrl,
    stickerTransformTool,
    viewerRef,
  ]);

  const changeStickerPlacement = useCallback((placement: StickerPlacement) => {
    const constrained = constrainStickerPlacementToTexture(placement);
    const base = stickerDraftRef.current ?? authoredStickerQuad;
    const quad = base
      ? applyStickerPlacementToQuad(base, constrained)
      : stickerPlacementToQuad(constrained);
    if (!quad) return;
    // Push shader uniforms now, not in an effect, so a dense pointer stream cannot make the model preview trail the box.
    // The composed base is unchanged; the destination commits at interaction end.
    previewStickerDraft(quad);
    updateStickerDraft(quad);
  }, [authoredStickerQuad, previewStickerDraft, updateStickerDraft]);

  const changeStickerQuad = useCallback((quad: StickerPlacementQuad) => {
    const constrained = constrainStickerQuadToTexture(quad);
    previewStickerDraft(constrained);
    updateStickerDraft(constrained);
  }, [previewStickerDraft, updateStickerDraft]);

  const finishStickerInteraction = useCallback(() => {
    const next = stickerDraftRef.current;
    if (next && authoredStickerQuad && !stickerQuadsEqual(next, authoredStickerQuad)
      && selectedStickerTarget?.editable) {
      if (!setSessionStickerQuad(selectedStickerTarget.target, next)) updateStickerDraft(null);
    } else {
      updateStickerDraft(null);
    }
  }, [authoredStickerQuad, selectedStickerTarget, setSessionStickerQuad, updateStickerDraft]);

  const setModelPartPicking = useCallback((active: boolean) => {
    if (!stickerEditingActive) return;
    setModelPartPickingActive(active);
    // Entering the picker re-shows the hint; leaving it does not.
    if (active) setHintDismissed(false);
  }, [setHintDismissed, stickerEditingActive]);

  const restoreHiddenModelParts = useCallback(() => {
    viewerRef.current?.restoreHiddenModelParts();
    setHiddenModelPartCount(0);
  }, [viewerRef]);

  const selectStickerTarget = (id: string) => {
    const nextIndex = stickerTargets.findIndex((target) => target.id === id);
    if (nextIndex < 0 || nextIndex === activeStickerTarget) return;
    updateStickerDraft(null);
    setActiveStickerTarget(nextIndex);
  };

  const stickerThumbnailByRef = new Map<string, string | null | undefined>(
    currentStickerTextureChoices.map((choice) => [choice.ref, choice.thumbnail]),
  );
  const stickerEditorProps: StickerEditorProps | undefined = stickerTargets.length > 0 ? {
    targets: (() => {
      // Repeated labels get an ordinal, so stickers sharing a source stay distinguishable.
      const seen = new Map<string, number>();
      const bases = stickerTargets.map((target) => {
        const base = target.stickers[0]?.base;
        return base?.resolvedValue ?? base?.authoredValue;
      });
      const files = bases.map((base) => (base ? texturePublicPath(base) : null));
      return stickerTargets.map((target, index) => {
        const label = stickerTargetLabel(target.stickers[0]?.base.resolvedValue, index);
        const count = (seen.get(label) ?? 0) + 1;
        seen.set(label, count);
        return {
          id: target.id,
          label: count > 1 ? `${label} ${count}` : label,
          canMoveEarlier: target.canMoveEarlier,
          canMoveLater: target.canMoveLater,
          baseReference: bases[index],
          sharedWith: files[index] ? files.filter((file) => file === files[index]).length - 1 : 0,
          variantCount: target.stickers.length,
          thumbnail: groupStickerArtwork[target.id]?.url
            ?? stickerTargetThumbnails[target.id]
            ?? null,
        };
      });
    })(),
    textureChoices: currentStickerTextureChoices,
    allTextureChoices: allStickerTextureChoices,
    selectionTargets: stickerTargets.flatMap((target, index) => {
      if (!target.quad) return [];
      const read = stickerPlacementFromQuad(target.quad);
      if (!read.editable || !read.placement) return [];
      return [{
        id: target.id,
        label: stickerTargetLabel(target.stickers[0]?.base.resolvedValue, index),
        placement: read.placement,
      }];
    }),
    activeSelectionId: selectedStickerTarget?.id,
    onSelectionChange: selectStickerTarget,
    activeTargetId: selectedStickerTarget?.id ?? stickerTargets[0].id,
    onActiveTargetChange: selectStickerTarget,
    onAddTarget: (baseReference: string) => {
      if (!selectedStickerTarget?.quad) return;
      if (addSessionSticker(
        { stagePaths: selectedStickerTarget.stagePaths },
        selectedStickerTarget.quad,
        baseReference,
      )) setPendingAddedStickerRef(baseReference);
    },
    onSetTargetTexture: (baseReference: string) => {
      if (!selectedStickerTarget) return;
      setSessionStickerBase({ stagePaths: selectedStickerTarget.stagePaths }, baseReference);
    },
    variants: selectedStickerTarget
      ? stickerVariantRows(selectedStickerTarget.stickers, selectedResolvedStickerStages[0]?.base, stickerThumbnailByRef, previewedVariantIndex)
      : [],
    onPreviewVariant: (index: number) => {
      if (!selectedStickerTarget) return;
      const targetId = selectedStickerTarget.id;
      setPreviewVariant((current) => (
        current?.targetId === targetId && current.index === index ? null : { targetId, index }
      ));
    },
    onSetVariantWeight: (index: number, weight: number) => {
      if (!selectedStickerTarget) return;
      setSessionStickerVariantWeight({
        stagePaths: selectedStickerTarget.stagePaths,
        effectiveWeights: resolvedVariantWeights(selectedStickerTarget.stickers),
      }, index, weight);
    },
    onSetVariantBase: (index: number, baseReference: string) => {
      if (!selectedStickerTarget) return;
      setSessionStickerVariantBase({ stagePaths: selectedStickerTarget.stagePaths }, index, baseReference);
    },
    onEqualizeVariantWeights: () => {
      if (!selectedStickerTarget) return;
      equalizeSessionStickerVariantWeights({ stagePaths: selectedStickerTarget.stagePaths });
    },
    onAddVariant: (baseReference: string) => {
      if (!selectedStickerTarget) return;
      addSessionStickerVariant({ stagePaths: selectedStickerTarget.stagePaths }, baseReference);
    },
    onRemoveVariant: (index: number) => {
      if (!selectedStickerTarget) return;
      removeSessionStickerVariant({
        stagePaths: selectedStickerTarget.stagePaths,
        effectiveWeights: resolvedVariantWeights(selectedStickerTarget.stickers),
      }, index);
    },
    onRemoveTarget: () => {
      if (!selectedStickerTarget) return;
      if (removeSessionSticker({ stagePaths: selectedStickerTarget.stagePaths })) {
        setActiveStickerTarget(Math.max(0, selectedStickerIndex - 1));
      }
    },
    onMoveTarget: (direction: -1 | 1) => {
      if (!selectedStickerTarget) return;
      if (moveSessionSticker({ stagePaths: selectedStickerTarget.stagePaths }, direction)) {
        setActiveStickerTarget(selectedStickerIndex + direction);
      }
    },
    textureSrc: stickerSurfaceUrl,
    stickerSrc: effectiveStickerTextureUrl,
    groupPreview: groupStickerUvPreview,
    renderStickerArtwork: !selectedStickerUsesComposedArtwork,
    textureAspect: stickerSurfaceAspect,
    onCreatePlacement: selectedStickerTarget?.editable && !stickerPlacementRead.editable
      ? () => {
          const quad = stickerPlacementToQuad(fitStickerPlacement(stickerAspect));
          if (quad) setSessionStickerQuad(selectedStickerTarget.target, quad);
        }
      : undefined,
    placement: stickerPlacement ?? DEFAULT_STICKER_PLACEMENT,
    quad: authoredStickerQuad ?? undefined,
    draftStore: stickerDraftStore,
    onPlacementChange: changeStickerPlacement,
    onQuadChange: changeStickerQuad,
    protoVariableNames: selectedStickerTarget ? {
      tl: selectedStickerTarget.destTl.variableName,
      tr: selectedStickerTarget.destTr.variableName,
      bl: selectedStickerTarget.destBl.variableName,
    } : undefined,
    activeTool: stickerTransformTool,
    onActiveToolChange: setStickerTransformTool,
    aspectLocked: stickerAspectLocked,
    onAspectLockedChange: setStickerAspectLocked,
    modelPartPickingActive: stickerPartPickingActive,
    hiddenModelPartCount,
    onModelPartPickingChange: setModelPartPicking,
    onRestoreHiddenModelParts: restoreHiddenModelParts,
    onInteractionStart: beginStickerInteraction,
    onInteractionEnd: finishStickerInteraction,
    onInteractionCancel: () => updateStickerDraft(null),
    disabled: !stickerEditorReady,
    notice: (!selectedStickerTarget?.editable || !stickerPlacementRead.editable)
      ? selectedStickerTarget?.reason
        ?? stickerPlacementRead.reason
        ?? 'This sticker position cannot be changed.'
      : (!stickerEditorReady ? 'Preparing sticker editor…' : null),
  } : undefined;

  return {
    stickerTransformTool,
    stickerAspectLocked,
    modelPartPickingActive,
    setHiddenModelPartCount,
    stickerTargets,
    setActiveStickerTarget,
    selectedStickerTarget,
    selectedStickerUsesComposedArtwork,
    authoredStickerQuad,
    activeGroupStickerResources,
    destinationEditSettling,
    stickerBaseSurfaceKey,
    stickerDraftActive,
    stickerSpecularUrl,
    stickerSurfaceComposeKey,
    effectiveStickerTextureUrl,
    stickerBaseSurfaceResultRef,
    stickerDraftRef,
    stickerGestureRef,
    stickerGizmoGestureRef,
    modelPartPointerRef,
    updateStickerDraft,
    undoEditorSynced,
    redoEditorSynced,
    resetEditorSynced,
    stickerEditorPreparing,
    stickerPlacementActive,
    stickerPartPickingActive,
    beginStickerInteraction,
    previewStickerDraft,
    props: stickerEditorProps,
  };
}

export type StickerEditor = ReturnType<typeof useStickerEditor>;
