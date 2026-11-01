import { useCallback, useMemo } from 'react';
import { indexPackageMaterialPaths } from '../source/vmt';
import { collectPackageStickerSpecularOverrides } from '../workbench/assetSlots';
import type { WarpaintAssetOverrides } from '../workbench/types';
import type { useSourcePackage } from '../hooks/useSourcePackage';
import type { useWorkbenchRecipes } from '../hooks/useWorkbenchRecipes';

interface UseTextureOverridesOptions {
  sourceProvider: ReturnType<typeof useSourcePackage>['provider'];
  assetOverrides: WarpaintAssetOverrides;
  editorRecipes: ReturnType<typeof useWorkbenchRecipes>['editorRecipes'];
  packageGeneration: number;
}

export function useTextureOverrides({
  sourceProvider,
  assetOverrides,
  editorRecipes,
  packageGeneration,
}: UseTextureOverridesOptions) {
  const resolvePackageTexture = useCallback((ref: string) => sourceProvider.resolvePreview(ref), [sourceProvider]);
  const manualTextureOverrides = useMemo(
    () => Object.fromEntries(
      Object.entries(assetOverrides.assets).flatMap(([ref, asset]) => asset.output ? [[ref, asset.output]] : []),
    ),
    [assetOverrides],
  );
  const mountedSourcePackage = sourceProvider.package;
  const packageStickerSpecularOverrides = useMemo(
    () => collectPackageStickerSpecularOverrides(
      editorRecipes,
      (ref) => Boolean(sourceProvider.packagePathFor(ref)),
    ),
    // The provider keeps its identity across package mounts, so packageGeneration must invalidate.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [editorRecipes, packageGeneration, sourceProvider],
  );
  const activeTextureOverrides = useMemo(() => ({
    ...packageStickerSpecularOverrides,
    ...manualTextureOverrides,
  }), [manualTextureOverrides, packageStickerSpecularOverrides]);
  const mountedMaterialPaths = useMemo(
    () => mountedSourcePackage ? indexPackageMaterialPaths(mountedSourcePackage) : null,
    [mountedSourcePackage],
  );

  return {
    resolvePackageTexture,
    manualTextureOverrides,
    mountedSourcePackage,
    packageStickerSpecularOverrides,
    activeTextureOverrides,
    mountedMaterialPaths,
  };
}
