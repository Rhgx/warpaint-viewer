// Stock cubemap lookups without three.js, so the startup bundle can resolve the URLs of
// imported materials. env.ts keeps the functions that build textures.
import stockCubemaps from './stockCubemaps.generated.json';

const STOCK_CUBEMAPS: Readonly<Record<string, string>> = stockCubemaps;
export const CUBEMAP_FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'] as const;

export function materialCubemapIdentity(ref: string): string {
  return ref.trim().replace(/\\/g, '/').replace(/^(?:textures|materials)\//i, '')
    .replace(/\.(?:hdr\.)?(?:vtf|png|webp)$/i, '').replace(/^\/+/g, '').toLowerCase();
}

export function isStockMaterialCubemap(ref: string): boolean {
  const identity = materialCubemapIdentity(ref);
  return identity === 'env_cubemap' || identity === 'editor/cubemap' || identity in STOCK_CUBEMAPS;
}

/** URLs for stock TF2 cubemaps that imported weapon VMTs commonly reference. */
export function stockMaterialCubemapUrls(ref: string): string[] | null {
  const identity = materialCubemapIdentity(ref);
  if (identity === 'env_cubemap') return null;
  if (identity === 'editor/cubemap') {
    const root = `${import.meta.env.BASE_URL}data/env/editor-cubemap/`;
    return CUBEMAP_FACES.map((face) => `${root}${face}.png`);
  }
  const directory = STOCK_CUBEMAPS[identity];
  if (!directory) return null;
  const root = `${import.meta.env.BASE_URL}data/effects/material-cubemaps/${directory}/`;
  return CUBEMAP_FACES.map((face) => `${root}${face}.png`);
}
