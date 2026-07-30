import type { RecipeNode } from '../compositor/types';

export interface WarpaintAssetOverrides {
  revision: number;
  assets: Record<string, WarpaintAssetState>;
}

export type WorkbenchTab = 'files' | 'package' | 'definitions' | 'export';

export interface WearRecipe {
  wearIndex: number;
  recipe: RecipeNode;
}

export interface WarpaintAssetState {
  color?: {
    dataUrl: string;
    fileName: string;
    isTga: boolean;
    hasEmbeddedAlpha?: boolean;
  };
  alpha?: { dataUrl: string; fileName: string };
  output?: string;
  size?: { width: number; height: number };
}
