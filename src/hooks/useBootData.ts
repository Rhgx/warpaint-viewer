import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDataSource } from '../data/loader';
import type { DataSource } from '../data/loader';
import type { ControlsState } from '../ui/Inspector';
import type { BootState } from '../ui/BootLoader';
import { parseUrlState, serializeUrlState } from '../urlState';

const DEFAULT_WEAPON_KEY = 'c_rocketlauncher';
const URL_SYNC_DEBOUNCE_MS = 300;

export function randomSeed(): string {
  if (globalThis.crypto?.getRandomValues) {
    const words = globalThis.crypto.getRandomValues(new Uint32Array(2));
    return ((BigInt(words[0]) << 32n) | BigInt(words[1])).toString();
  }
  const hi = BigInt(Math.floor(Math.random() * 0x100000000));
  const lo = BigInt(Math.floor(Math.random() * 0x100000000));
  return ((hi << 32n) | lo).toString();
}

interface UseBootDataOptions {
  state: ControlsState;
  setState: React.Dispatch<React.SetStateAction<ControlsState>>;
  selectedKitId: number | null;
  setSelectedKitId: React.Dispatch<React.SetStateAction<number | null>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

export function useBootData({ state, setState, selectedKitId, setSelectedKitId, setError }: UseBootDataOptions) {
  // Guards the URL-sync effect: it must not fire until the boot effect below
  // has applied any URL-provided selection to state, or it would immediately
  // clobber the incoming URL with the pre-boot placeholder defaults.
  const bootSelectionAppliedRef = useRef(false);

  const [data, setData] = useState<DataSource | null>(null);
  const [boot, setBoot] = useState<BootState>({ progress: 4, label: 'Loading catalog…' });

  const advanceBoot = useCallback((progress: number, label: string) => {
    setBoot((current) => progress > current.progress ? { progress, label } : current);
  }, []);

  // Load data source once (manifest only; recipes/textures load on demand).
  useEffect(() => {
    let cancelled = false;
    loadDataSource()
      .then((ds) => {
        if (cancelled) return;
        setData(ds);
        advanceBoot(16, 'Catalog ready');

        // The URL is parsed exactly once, right here, and only ever applied
        // on top of the catalog's own defaults below; every param is
        // optional and independently falls back if missing or invalid.
        const url = parseUrlState(window.location.search, window.location.hash);

        // Start empty unless a valid shared-link selection was requested.
        // Unknown kit ids also remain empty instead of silently selecting a
        // different item from the catalog.
        const urlKit = url.kitId != null ? ds.manifest.paintkits.find((p) => p.id === url.kitId) ?? null : null;
        const kit = urlKit;

        let weaponKey = kit?.weapons.includes(DEFAULT_WEAPON_KEY)
          ? DEFAULT_WEAPON_KEY
          : kit?.weapons[0] ?? '';
        if (url.weaponKey && kit?.weapons.includes(url.weaponKey)) weaponKey = url.weaponKey;

        setSelectedKitId(kit?.id ?? null);
        setState((s) => ({
          ...s,
          weaponKey,
          seed: url.seed ?? s.seed,
          wearIndex: url.wearIndex ?? s.wearIndex,
          team: url.team ?? s.team,
          sheen: url.sheen ?? s.sheen,
          unusual: url.unusual ?? s.unusual,
          preset: url.preset ?? s.preset,
          projection: url.projection ?? s.projection,
          fov: url.fov ?? s.fov,
        }));
        // From here on the URL-sync effect is free to start writing back.
        bootSelectionAppliedRef.current = true;
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [advanceBoot, setError, setSelectedKitId, setState]);

  // Mirror the shareable bits of state into the URL (debounced, no
  // navigation) so the current view can be copied and reopened. Skipped
  // entirely until the boot effect above has applied any incoming URL
  // params, or this would immediately overwrite them with pre-boot defaults.
  useEffect(() => {
    if (!bootSelectionAppliedRef.current) return;
    const handle = window.setTimeout(() => {
      const urlState = serializeUrlState(window.location.search, {
        kitId: selectedKitId,
        weaponKey: state.weaponKey,
        seed: state.seed,
        wearIndex: state.wearIndex,
        team: state.team,
        sheen: state.sheen,
        unusual: state.unusual,
        preset: state.preset,
        projection: state.projection,
        fov: state.fov,
      });
      const url = `${window.location.pathname}${urlState.search}${urlState.hash}`;
      window.history.replaceState(null, '', url);
    }, URL_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    selectedKitId, state.weaponKey, state.seed, state.wearIndex, state.team,
    state.sheen, state.unusual, state.preset, state.projection, state.fov,
  ]);

  return { data, boot, advanceBoot };
}
