import { useCallback, useEffect, useRef, useState } from 'react';
import type { Manifest, Team } from '../data/types';
import type { RecipeNode } from '../compositor/types';
import type {
  EditedKit,
  ProtoDefKitBundle,
  ProtoDefKitMessages,
  ProtoDefKitWeaponSlot,
  ProtoDefRecipeWithProvenance,
  ProtoDefSource,
} from '../protodefs/types';
import { topLevelMessages } from '../editor/kitBundle';
import { loadSnapshotContainer } from '../export/snapshot';
import { loadBaseProtoDefs, loadItemDefinitionMap } from '../data/loader';
import { openKitPreviewSource } from './kitPreview';

/** Lazily exposes the shipped stock proto_defs container to the editor; normal viewing never decodes it. */
export function useStockDefinitions(manifest: Manifest | null, getAssetUrl: (rel: string) => string | null) {
  const sourceRef = useRef<ProtoDefSource | null>(null);
  const sourcePromiseRef = useRef<Promise<ProtoDefSource> | null>(null);
  const editedRef = useRef<EditedKit | null>(null);
  const editOperationRef = useRef(0);
  const [editGeneration, setEditGeneration] = useState(0);

  const loadBaseBytes = useCallback(
    () => loadBaseProtoDefs(getAssetUrl('protodefs-base.bin')),
    [getAssetUrl],
  );

  const loadWeapons = useCallback(
    () => loadItemDefinitionMap(getAssetUrl('item-defs.json')),
    [getAssetUrl],
  );

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
    if (editedRef.current?.kitId === kitId) return structuredClone(topLevelMessages(editedRef.current.bundle));
    return (await openSource()).exportKit(kitId);
  }, [openSource]);

  const exportKitBundle = useCallback(async (kitId: number): Promise<ProtoDefKitBundle | null> => {
    if (editedRef.current?.kitId === kitId) return structuredClone(editedRef.current.bundle);
    return (await openSource()).exportKitBundle(kitId);
  }, [openSource]);

  const exportKitWeaponSlots = useCallback(async (kitId: number): Promise<ProtoDefKitWeaponSlot[] | null> => {
    const source = editedRef.current?.kitId === kitId ? editedRef.current.source : await openSource();
    return source.exportKitWeaponSlots(kitId);
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

  const previewKitBundle = useCallback(async (kitId: number, bundle: ProtoDefKitBundle) => {
    const operation = ++editOperationRef.current;
    const { source } = await openKitPreviewSource(
      bundle,
      loadBaseBytes(),
      loadWeapons(),
      manifest?.paintkits.map((kit) => kit.id) ?? [],
    );
    try {
      if (operation !== editOperationRef.current) {
        source.dispose();
        return;
      }
      editedRef.current?.source.dispose();
      // The bundle is the editor's frozen snapshot, so it is kept by reference.
      editedRef.current = { kitId, source, bundle };
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
    exportKitBundle,
    exportKitWeaponSlots,
    getRecipe,
    getRecipeWithProvenance,
    previewKitBundle,
    clearPreviewKit,
  };
}
