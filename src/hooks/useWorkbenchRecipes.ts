import { useEffect, useEffectEvent, useMemo, useState } from 'react';

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

interface LoadedRecipes {
  recipes: WearRecipe[];
  scope: string;
  variant: string;
  complete: boolean;
}

const NO_RECIPES: LoadedRecipes = { recipes: [], scope: '', variant: '', complete: false };

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
  const [loaded, setLoaded] = useState(NO_RECIPES);
  const [settledKey, setSettledKey] = useState('');

  const kitReady = Boolean(workbenchMounted && data && selectedKit && state.weaponKey && selectedKit.weapons.includes(state.weaponKey));
  const recipeScope = `${selectedKit?.id}|${state.weaponKey}|definition:${editorDefinitionGeneration}|package:${packageGeneration}|team:${kitHasTeamTextures}`;
  const recipeVariant = `${state.team}|${state.wearIndex}`;
  const surfaceLoadsNothing = workbenchTab === 'package' || workbenchTab === 'definitions';
  const completeRecipeMatrix = workbenchTab === 'files' || workbenchTab === 'export';
  const requestKey = `${recipeScope}|${recipeVariant}|${completeRecipeMatrix}`;
  const cachedRecipesCoverSurface = loaded.scope === recipeScope
    && loaded.recipes.length > 0
    && (loaded.complete || (!completeRecipeMatrix && loaded.variant === recipeVariant));

  const coversSurface = useEffectEvent(() => cachedRecipesCoverSurface);

  // Recipes drop when there is nothing to show, or when a surface that loads none moves to another scope.
  // A closed drawer keeps what it has.
  if (loaded !== NO_RECIPES && (!kitReady || (workbenchOpen && surfaceLoadsNothing && loaded.scope !== recipeScope))) {
    setLoaded(NO_RECIPES);
    setSettledKey('');
  }
  const editorLoading = kitReady && workbenchOpen && !surfaceLoadsNothing && !cachedRecipesCoverSurface && settledKey !== requestKey;

  // Files and Export need every input the paint can use, across wears and teams.
  // Team-aware stages resolve texture_red and texture_blue to different refs, so
  // one team alone drops artwork. Edit needs only the active team and wear.
  useEffect(() => {
    // Workbench-only: paused while the drawer is closed. A surface change refreshes only its own recipes.
    if (!workbenchMounted || !data || !selectedKit || !state.weaponKey || !selectedKit.weapons.includes(state.weaponKey)) return;
    if (!workbenchOpen || surfaceLoadsNothing) return;
    if (coversSurface()) return;
    let cancelled = false;
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
    ).then((resolved) => {
      if (cancelled) return;
      const recipes = resolved.flatMap(({ wearIndex, recipe }) => recipe ? [{ wearIndex, recipe }] : []);
      setLoaded({ recipes, scope: recipeScope, variant: recipeVariant, complete: completeRecipeMatrix });
    }).finally(() => {
      if (!cancelled) setSettledKey(requestKey);
    });
    return () => { cancelled = true; };
  }, [workbenchMounted, workbenchOpen, workbenchTab, data, resolveRecipe, selectedKit, state.weaponKey, state.team, state.wearIndex, editorDefinitionGeneration, packageGeneration, kitHasTeamTextures, recipeScope, recipeVariant, completeRecipeMatrix, requestKey, surfaceLoadsNothing]);

  return { editorLoading, editorRecipes: loaded.recipes };
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
