import type { ProtoDefIndex, ProtoDefKitBundle, ProtoDefSource } from '../protodefs/types';

// Overlays the bundle's operations and items on the stock base, so an edited per-wear operation resolves.
// The caller owns the returned source and must dispose it.
export async function openKitPreviewSource(
  bundle: ProtoDefKitBundle,
  baseBytes: Promise<Uint8Array>,
  weaponsByItemDef: Promise<Record<string, string>>,
  builtInIds: number[],
): Promise<{ source: ProtoDefSource; index: ProtoDefIndex }> {
  // The client and JSON exporter stay out of the main chunk, so they load here alongside the base defs.
  const [{ createProtoDefSource }, { serializeProtoDefKitBundlePreview }, base, weapons] = await Promise.all([
    import('../protodefs/client'),
    import('../editor/export/jsonExport'),
    baseBytes,
    weaponsByItemDef,
  ]);
  const source = createProtoDefSource();
  try {
    const index = await source.openJsonFragments(base, serializeProtoDefKitBundlePreview(bundle).fragments, {
      weaponsByItemDef: weapons,
      builtInIds,
      computeTeamFlags: false,
    });
    return { source, index };
  } catch (cause) {
    source.dispose();
    throw cause;
  }
}
