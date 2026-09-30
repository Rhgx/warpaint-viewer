import { useEffect, useMemo, useState } from 'react';
import type { ControlsState } from '../../viewer/controls';
import type { WearRecipe } from '../../workbench/types';
import { discoverGroupSelectTargets } from './groupTargets';
import { collectRecipeLayerNodes, collectResolvedGroupSelects, findRecipeTextureNode } from './recipeLayers';
import { discoverLayerTransforms } from '../transform/transformTargets';
import { preferredLayerOccurrenceIndex } from '../transform/transformIsolation';
import type { EditorCore } from '../useEditorCore';

interface UseEditorLayersOptions extends Pick<EditorCore, 'editableKitId' | 'editorCurrent' | 'provenanceRecipe'> {
  editorRecipes: WearRecipe[];
  state: ControlsState;
}

/**
 * The paint layers of the working definition: which selector is active, what
 * each layer targets, and which parts are assigned to it. Parts, transform,
 * sticker and graph editing all navigate by this.
 */
export function useEditorLayers({
  editableKitId,
  editorCurrent,
  provenanceRecipe,
  editorRecipes,
  state,
}: UseEditorLayersOptions) {
  const [activeEditorSelector, setActiveEditorSelector] = useState(0);
  const [weaponBaseLayerActive, setWeaponBaseLayerActive] = useState(false);

  const groupDiscovery = useMemo(
    () => editorCurrent ? discoverGroupSelectTargets(editorCurrent, provenanceRecipe?.provenance) : null,
    [editorCurrent, provenanceRecipe],
  );
  // Position-aligned with groupDiscovery.targets: both walk the same operation
  // tree in the same order, so index i here describes the stage masked by
  // select stage i there (see transformTargets.ts's module comment).
  const currentLayerTransforms = useMemo(
    () => editorCurrent ? discoverLayerTransforms(editorCurrent, provenanceRecipe?.provenance) : null,
    [editorCurrent, provenanceRecipe],
  );
  const transformDiscovery = currentLayerTransforms?.layers ?? null;
  const baseTextureTransform = currentLayerTransforms?.base ?? null;
  const editableGroupTargets = useMemo(() => (
    groupDiscovery?.targets.filter((target, index, targets) => (
      target.canToggle && targets.findIndex((candidate) => candidate.canToggle && candidate.sourceKey === target.sourceKey) === index
    )) ?? []
  ), [groupDiscovery]);
  const editorSelectors = useMemo(() => editableGroupTargets.map((target, index) => ({
    id: String(index),
    label: target.label,
  })), [editableGroupTargets]);
  const activeGroupTarget = editableGroupTargets[activeEditorSelector] ?? editableGroupTargets[0] ?? null;
  const activeGroupOperationIndex = activeGroupTarget && groupDiscovery
    ? groupDiscovery.targets.indexOf(activeGroupTarget)
    : -1;
  // TF2 templates can reuse one authored layer in an early wear branch and a
  // later colour branch. Transform editing and previews follow the final
  // occurrence that matches the finished paint; group assignment retains the
  // first authored selector target because both share the same source slots.
  const activeGroupVisualIndex = groupDiscovery
    ? preferredLayerOccurrenceIndex(groupDiscovery.targets, activeGroupTarget)
    : -1;
  // The RecipeNode counterpart of activeTransformTargetInfo, used to composite
  // preview tiles (which need the authored subtree, not just its field values).
  const recipeLayerNodes = useMemo(
    () => provenanceRecipe ? collectRecipeLayerNodes(provenanceRecipe.tree) : [],
    [provenanceRecipe],
  );
  const baseRecipeLayerNode = baseTextureTransform && provenanceRecipe
    ? findRecipeTextureNode(provenanceRecipe.tree, baseTextureTransform.textureRef)
    : null;
  const baseLayerTextureRef = baseRecipeLayerNode?.type === 'texture_lookup'
    ? baseRecipeLayerNode.texture
    : baseTextureTransform?.textureRef;
  const resolvedGroupSelects = useMemo(() => {
    const recipe = editorRecipes.find((entry) => entry.wearIndex === state.wearIndex)?.recipe
      ?? editorRecipes[0]?.recipe;
    return recipe ? collectResolvedGroupSelects(recipe) : [];
  }, [editorRecipes, state.wearIndex]);
  const activeResolvedGroupSelect = activeGroupOperationIndex >= 0
    ? resolvedGroupSelects[activeGroupOperationIndex]
    : undefined;
  const activeGroupRef = activeResolvedGroupSelect?.groups ?? activeGroupTarget?.groupsRef;
  const groupAssignmentTargets = useMemo(() => editableGroupTargets.map((target, index) => {
    const matchingOperationIndexes = groupDiscovery?.targets.flatMap((candidate, operationIndex) => (
      candidate.sourceKey === target.sourceKey ? [operationIndex] : []
    )) ?? [];
    const resolvedMatches = matchingOperationIndexes.flatMap((operationIndex) => (
      resolvedGroupSelects[operationIndex] ? [resolvedGroupSelects[operationIndex]] : []
    ));
    const resolved = resolvedMatches.at(-1);
    const selectedGroupIds = target.hasInheritedVariableValues ? resolved?.select : target.selectedGroupIds;
    return {
      label: editorSelectors[index]?.label ?? target.label,
      groupsRef: resolved?.groups ?? target.groupsRef,
      textureRef: resolved?.textureRef ?? target.textureRef,
      selectedGroupIds: selectedGroupIds ?? [],
      target: {
        ...target.target,
        ...(target.hasInheritedVariableValues && resolved
          ? { effectiveSelectValues: resolved.select }
          : {}),
      },
      canAssign: !target.hasInheritedVariableValues || Boolean(resolved),
    };
  }), [editableGroupTargets, editorSelectors, groupDiscovery, resolvedGroupSelects]);
  const activeGroupAssignmentTarget = groupAssignmentTargets[activeEditorSelector]
    ?? groupAssignmentTargets[0]
    ?? null;
  const activeGroupEditTarget = activeGroupAssignmentTarget?.canAssign
    ? activeGroupAssignmentTarget.target
    : null;
  // Keep the focused part cue in the same stable color as this layer's
  // all-layer map entry. This remains useful even when the map itself is
  // hidden: switching layers is enough to establish the cue's color.
  const activeEditorLayerIndex = weaponBaseLayerActive
    ? groupAssignmentTargets.length
    : activeGroupAssignmentTarget === null
    ? 0
    : Math.max(0, groupAssignmentTargets.indexOf(activeGroupAssignmentTarget));

  useEffect(() => {
    setWeaponBaseLayerActive(false);
  }, [editableKitId, state.weaponKey]);

  useEffect(() => {
    if (activeEditorSelector >= editableGroupTargets.length) setActiveEditorSelector(0);
  }, [activeEditorSelector, editableGroupTargets.length]);

  return {
    activeEditorSelector,
    setActiveEditorSelector,
    weaponBaseLayerActive,
    setWeaponBaseLayerActive,
    groupDiscovery,
    transformDiscovery,
    baseTextureTransform,
    editableGroupTargets,
    editorSelectors,
    activeGroupTarget,
    activeGroupVisualIndex,
    recipeLayerNodes,
    baseRecipeLayerNode,
    baseLayerTextureRef,
    activeResolvedGroupSelect,
    activeGroupRef,
    groupAssignmentTargets,
    activeGroupAssignmentTarget,
    activeGroupEditTarget,
    activeEditorLayerIndex,
  };
}
export type EditorLayers = ReturnType<typeof useEditorLayers>;
