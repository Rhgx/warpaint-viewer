import { useEffect, useMemo, useRef, useState } from 'react';

import type { ResolveRecipe } from './useComposedPaint';
import type { DataSource } from '../data/loader';
import type { PaintkitEntry } from '../data/types';
import { collectTextureRefs, exportPathFor, resolvePackageTextures } from '../export/plan';
import { isCustomKitId } from '../protodefs/types';
import { sourceTextureIdentity } from '../source/paths';
import type { SourceTextureProvider } from '../source/provider';
import type { ControlsState } from '../viewer/controls';
import { collectSlots } from '../workbench/assetSlots';
import type { WearRecipe, WorkbenchTab } from '../workbench/types';
import type { useCustomDefinitions } from './useCustomDefinitions';

interface UseWorkbenchRecipesOptions {
  workbenchMounted: boolean;
  workbenchOpen: boolean;
  workbenchTab: WorkbenchTab;
  data: DataSource | null;
  resolveRecipe: ResolveRecipe;
  selectedKit: PaintkitEntry | null;
  state: ControlsState;
  editorDefinitionGeneration: number;
  packageGeneration: number;
  kitHasTeamTextures: boolean;
}

/** Fans recipes out for the open workbench surface and owns the resolved editor recipes. */
export function useWorkbenchRecipes({
  workbenchMounted,
  workbenchOpen,
  workbenchTab,
  data,
  resolveRecipe,
  selectedKit,
  state,
  editorDefinitionGeneration,
  packageGeneration,
  kitHasTeamTextures,
}: UseWorkbenchRecipesOptions) {
  const [editorRecipes, setEditorRecipes] = useState<WearRecipe[]>([]);
  const [editorLoading, setEditorLoading] = useState(false);
  const editorRecipesRef = useRef<WearRecipe[]>([]);
  const editorRecipeScopeRef = useRef('');
  const editorRecipeVariantRef = useRef('');
  const editorRecipeCompleteRef = useRef(false);

  // Files and Export need every input the paint can use, across wears and teams.
  // Team-aware stages resolve texture_red and texture_blue to different refs, so
  // one team alone drops artwork. Edit needs only the active team and wear.
  useEffect(() => {
    const clearEditorRecipes = () => {
      editorRecipesRef.current = [];
      editorRecipeScopeRef.current = '';
      editorRecipeVariantRef.current = '';
      editorRecipeCompleteRef.current = false;
      setEditorRecipes([]);
    };
    // Workbench-only: paused while the drawer is closed. A surface change refreshes only its own recipes.
    if (!workbenchMounted || !data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) {
      clearEditorRecipes();
      setEditorLoading(false);
      return;
    }
    if (!workbenchOpen) {
      setEditorLoading(false);
      return;
    }
    const recipeScope = `${selectedKit.id}|${state.weaponKey}|definition:${editorDefinitionGeneration}|package:${packageGeneration}|team:${kitHasTeamTextures}`;
    const recipeVariant = `${state.team}|${state.wearIndex}`;
    if (workbenchTab === 'package' || workbenchTab === 'definitions') {
      if (editorRecipeScopeRef.current !== recipeScope) {
        clearEditorRecipes();
      }
      setEditorLoading(false);
      return;
    }
    let cancelled = false;
    const completeRecipeMatrix = workbenchTab === 'files' || workbenchTab === 'export';
    const cachedRecipesCoverSurface = editorRecipeScopeRef.current === recipeScope
      && editorRecipesRef.current.length > 0
      && (editorRecipeCompleteRef.current || (!completeRecipeMatrix && editorRecipeVariantRef.current === recipeVariant));
    if (cachedRecipesCoverSurface) {
      setEditorLoading(false);
      return;
    }
    setEditorLoading(true);
    const wearIndexes = completeRecipeMatrix && selectedKit.perWear
      ? data.manifest.wearLevels.map((_, index) => index)
      : [state.wearIndex];
    const teams = completeRecipeMatrix && kitHasTeamTextures
      ? (['red', 'blu'] as const)
      : [state.team];
    void Promise.all(
      teams.flatMap((team) =>
        wearIndexes.map((wearIndex) => resolveRecipe(selectedKit, state.weaponKey, team, wearIndex)
          .then((recipe) => ({ wearIndex, recipe }))),
      ),
    ).then((loaded) => {
      if (cancelled) return;
      const recipes = loaded.flatMap(({ wearIndex, recipe }) => recipe ? [{ wearIndex, recipe }] : []);
      editorRecipesRef.current = recipes;
      editorRecipeScopeRef.current = recipeScope;
      editorRecipeVariantRef.current = recipeVariant;
      editorRecipeCompleteRef.current = completeRecipeMatrix;
      setEditorRecipes(recipes);
    }).finally(() => {
      if (!cancelled) setEditorLoading(false);
    });
    return () => { cancelled = true; };
  }, [workbenchMounted, workbenchOpen, workbenchTab, data, resolveRecipe, selectedKit, state.weaponKey, state.team, state.wearIndex, editorDefinitionGeneration, packageGeneration, kitHasTeamTextures]);

  return { editorLoading, editorRecipes };
}

interface UseExportDefinitionsOptions {
  data: DataSource | null;
  selectedKit: PaintkitEntry | null;
  exportImportedKitBundle: ReturnType<typeof useCustomDefinitions>['exportKitBundle'];
  sourceProvider: SourceTextureProvider;
  packageGeneration: number;
  editorRecipes: WearRecipe[];
  manualTextureOverrides: Record<string, string>;
}

export function useExportDefinitions({
  data,
  selectedKit,
  exportImportedKitBundle,
  sourceProvider,
  packageGeneration,
  editorRecipes,
  manualTextureOverrides,
}: UseExportDefinitionsOptions) {
  // Export needs the paint's own definitions and the package textures it reads.
  // Both load only when an export runs, so opening the tab costs nothing.
  return useMemo(() => {
    // Counts this paint's package-supplied textures from the recipe, so the count is right on open.
    const pkg = sourceProvider.package;
    const refs = collectTextureRefs(editorRecipes.map((entry) => entry.recipe));
    const packageSpecularRefs = pkg
      ? collectSlots(editorRecipes).flatMap((slot) => (
          slot.specularRef && sourceProvider.packagePathFor(slot.specularRef) ? [slot.specularRef] : []
        ))
      : [];
    const packageRefs = [...new Set([...refs, ...packageSpecularRefs])];
    const supplied = pkg ? resolvePackageTextures(packageRefs, (ref: string) => sourceProvider.packagePathFor(ref)) : [];
    const unresolvedTextureRefs = refs.filter((ref) => {
      if (!sourceTextureIdentity(ref).startsWith('materials/patterns/')) return false;
      if (manualTextureOverrides[ref]) return false;
      if (sourceProvider.packagePathFor(ref)) return false;
      return !data?.manifest.textures?.[ref];
    });
    return {
      isImported: selectedKit ? isCustomKitId(selectedKit.id) : false,
      builtInKits: (data?.manifest.paintkits ?? []).map((kit) => ({ defindex: kit.id, name: kit.name })),
      loadKitBundle: async () => (
        selectedKit && isCustomKitId(selectedKit.id) ? exportImportedKitBundle(selectedKit.id) : null
      ),
      packageFiles: async () => {
        if (!pkg) return [];
        const { collectPackageFiles } = await import('../export/bundle');
        // Hand-replaced files win over the package copy, as in the viewer.
        const replaced = new Set(
          Object.keys(manualTextureOverrides).map((ref) => `${sourceTextureIdentity(ref)}.vtf`),
        );
        return collectPackageFiles(
          supplied.map(({ ref, path }) => ({ path, writeAs: exportPathFor(ref) })),
          (path) => pkg.read(path),
          replaced,
        );
      },
      materialFiles: async (overrides: readonly string[]) => {
        if (!pkg) return { files: [], missing: [...overrides], repaired: [] };
        const { collectMaterialFiles } = await import('../export/bundle');
        return collectMaterialFiles(
          overrides,
          (path: string) => sourceProvider.packagePathForFile(path),
          (path: string) => pkg.read(path),
        );
      },
      packageFileCount: supplied.length,
      packageMounted: Boolean(pkg),
      unresolvedTextureRefs,
    };
    // packageGeneration marks a mount or removal; the provider keeps its identity across both.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedKit, exportImportedKitBundle, sourceProvider, packageGeneration, editorRecipes, manualTextureOverrides]);
}
