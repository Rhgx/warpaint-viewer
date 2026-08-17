import type { WarpaintAssetOverrides, WarpaintAssetState } from './types';

function assetUrls(asset: WarpaintAssetState | undefined): Set<string> {
  return new Set([
    asset?.color?.dataUrl,
    asset?.alpha?.dataUrl,
    asset?.output,
  ].filter((value): value is string => Boolean(value)));
}

export function revokeTextureUrl(source: string | undefined): void {
  if (source?.startsWith('blob:') && typeof URL !== 'undefined') URL.revokeObjectURL(source);
}

export function revokeReleasedAssetUrls(
  previous: Record<string, WarpaintAssetState>,
  next: Record<string, WarpaintAssetState>,
): void {
  const retained = new Set(Object.values(next).flatMap((asset) => [...assetUrls(asset)]));
  const released = new Set(Object.values(previous).flatMap((asset) => [...assetUrls(asset)]));
  for (const source of released) {
    if (!retained.has(source)) revokeTextureUrl(source);
  }
}

export function revokeAssetOverrideCache(cache: Record<string, WarpaintAssetOverrides>): void {
  const released = new Set(
    Object.values(cache).flatMap((entry) =>
      Object.values(entry.assets).flatMap((asset) => [...assetUrls(asset)]),
    ),
  );
  for (const source of released) revokeTextureUrl(source);
}
