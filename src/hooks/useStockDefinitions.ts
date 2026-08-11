import { useCallback, useEffect, useRef, useState } from 'react';
import type { Manifest, Team } from '../data/types';
import type { RecipeNode } from '../compositor/types';
import type {
  ProtoDefKitMessages,
  ProtoDefRecipeWithProvenance,
  ProtoDefSource,
} from '../protodefs/types';
import { serializeProtoDefKitMessages } from '../editor/jsonExport';
import { loadSnapshotContainer } from '../export/snapshot';

interface EditedKit {
  kitId: number;
  source: ProtoDefSource;
  messages: ProtoDefKitMessages;
}

/**
 * Lazily exposes the shipped stock proto_defs container to the editor. Normal
 * viewing keeps using the small recipe bundles and never pays this decode cost.
 */
export function useStockDefinitions(manifest: Manifest | null, getAssetUrl: (rel: string) => string | null) {
  const sourceRef = useRef<ProtoDefSource | null>(null);
  const sourcePromiseRef = useRef<Promise<ProtoDefSource> | null>(null);
  const editedRef = useRef<EditedKit | null>(null);
  const editOperationRef = useRef(0);
  const baseBytesRef = useRef<Promise<Uint8Array> | null>(null);
  const weaponsRef = useRef<Promise<Record<string, string>> | null>(null);
  const [editGeneration, setEditGeneration] = useState(0);

  const loadBytes = useCallback((rel: string, label: string, cache: typeof baseBytesRef) => {
    if (cache.current) return cache.current;
    const url = getAssetUrl(rel);
    const pending = (async () => {
      if (!url) throw new Error(`This data source has no ${label}.`);
      const response = await fetch(url);
      if (!response.ok) throw new Error(`The ${label} could not be loaded (${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    })();
    cache.current = pending;
    pending.catch(() => { cache.current = null; });
    return pending;
  }, [getAssetUrl]);

  const loadBaseBytes = useCallback(
    () => loadBytes('protodefs-base.bin', 'base war paint definitions', baseBytesRef),
    [loadBytes],
  );

  const loadWeapons = useCallback(() => {
    if (weaponsRef.current) return weaponsRef.current;
    const url = getAssetUrl('item-defs.json');
    const pending = (async () => {
      if (!url) throw new Error('This data source has no item definition map.');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`The item definition map could not be loaded (${response.status}).`);
      return (await response.json()) as Record<string, string>;
    })();
    weaponsRef.current = pending;
    pending.catch(() => { weaponsRef.current = null; });
    return pending;
  }, [getAssetUrl]);

  const openSource = useCallback(async () => {
    if (sourceRef.current) return sourceRef.current;
    if (sourcePromiseRef.current) return sourcePromiseRef.current;
    const pending = (async () => {
      const [{ createProtoDefSource }, bytes, weaponsByItemDef] = await Promise.all([
        import('../protodefs/client'),
        loadSnapshotContainer(),
        loadWeapons(),
      ]);
      const source = createProtoDefSource();
      try {
        await source.open(bytes, {
          weaponsByItemDef,
          builtInIds: manifest?.paintkits.map((kit) => kit.id) ?? [],
        });
        sourceRef.current = source;
        return source;
      } catch (cause) {
        source.dispose();
        throw cause;
      }
    })();
    sourcePromiseRef.current = pending;
    pending.catch(() => { sourcePromiseRef.current = null; });
    return pending;
  }, [loadWeapons, manifest]);

  const exportKit = useCallback(async (kitId: number): Promise<ProtoDefKitMessages | null> => {
    if (editedRef.current?.kitId === kitId) return structuredClone(editedRef.current.messages);
    return (await openSource()).exportKit(kitId);
  }, [openSource]);

  const getRecipe = useCallback(async (
    kitId: number,
    weaponKey: string,
    team: Team,
    wearIndex: number,
  ): Promise<RecipeNode | null> => {
    const source = editedRef.current?.kitId === kitId ? editedRef.current.source : await openSource();
    return (await source.resolveRecipe(kitId, weaponKey, team, wearIndex))?.tree ?? null;
  }, [openSource]);

  const getRecipeWithProvenance = useCallback(async (
    kitId: number,
    weaponKey: string,
    team: Team,
    wearIndex: number,
  ): Promise<ProtoDefRecipeWithProvenance | null> => {
    const source = editedRef.current?.kitId === kitId ? editedRef.current.source : await openSource();
    return source.resolveRecipeWithProvenance(kitId, weaponKey, team, wearIndex);
  }, [openSource]);

  const clearPreviewKit = useCallback(() => {
    editOperationRef.current += 1;
    if (!editedRef.current) return;
    editedRef.current.source.dispose();
    editedRef.current = null;
    setEditGeneration((value) => value + 1);
  }, []);

  const previewKitMessages = useCallback(async (kitId: number, messages: ProtoDefKitMessages) => {
    const operation = ++editOperationRef.current;
    const [{ createProtoDefSource }, baseBytes, weaponsByItemDef] = await Promise.all([
      import('../protodefs/client'),
      loadBaseBytes(),
      loadWeapons(),
    ]);
    const source = createProtoDefSource();
    try {
      await source.openJsonFragments(baseBytes, [...serializeProtoDefKitMessages(messages).fragments], {
        weaponsByItemDef,
        builtInIds: manifest?.paintkits.map((kit) => kit.id) ?? [],
      });
      if (operation !== editOperationRef.current) {
        source.dispose();
        return;
      }
      editedRef.current?.source.dispose();
      editedRef.current = { kitId, source, messages: structuredClone(messages) };
      setEditGeneration((value) => value + 1);
    } catch (cause) {
      source.dispose();
      throw cause;
    }
  }, [loadBaseBytes, loadWeapons, manifest]);

  useEffect(() => () => {
    editOperationRef.current += 1;
    editedRef.current?.source.dispose();
    sourceRef.current?.dispose();
  }, []);

  return {
    editGeneration,
    exportKit,
    getRecipe,
    getRecipeWithProvenance,
    previewKitMessages,
    clearPreviewKit,
  };
}
