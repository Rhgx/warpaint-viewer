import { useCallback, useEffect, useRef, useState } from 'react';
import { loadDataSource } from '../data/loader';
import { supportsStatClock } from '../data/statClock';
import type { DataSource } from '../data/loader';
import type { ControlsState } from '../viewer/controls';
import { parseUrlState, serializeUrlState } from '../urlState';
import { isCustomKitId } from '../protodefs/types';

export interface BootState {
  progress: number;
  label: string;
}

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
  // The URL-sync effect must wait for the boot effect to apply the URL selection,
  // or it would overwrite the incoming URL with placeholder defaults.
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

        // The URL applies only on top of catalog defaults; each param is optional and falls back if invalid.
        const url = parseUrlState(window.location.search, window.location.hash);

        // Empty unless a valid shared link asked for a kit; unknown ids stay empty too.
        const kit = url.kitId != null ? ds.manifest.paintkits.find((p) => p.id === url.kitId) ?? null : null;

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
          statClocks: url.statClock === null ? s.statClocks : { ...s.statClocks, [weaponKey]: { on: true, kills: url.statClock } },
        }));
        bootSelectionAppliedRef.current = true;
      })
      .catch((e) => setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [advanceBoot, setError, setSelectedKitId, setState]);

  const statClock = state.statClocks[state.weaponKey];
  // Mirror shareable state into the URL (debounced, no navigation) so views can be copied.
  // Waits for boot, or it would overwrite incoming params with defaults.
  useEffect(() => {
    if (!bootSelectionAppliedRef.current) return;
    const handle = window.setTimeout(() => {
      const urlState = serializeUrlState(window.location.search, {
        // Imported definitions live only in memory, so their ids would not resolve in a shared link.
        kitId: selectedKitId != null && isCustomKitId(selectedKitId) ? null : selectedKitId,
        weaponKey: state.weaponKey,
        seed: state.seed,
        wearIndex: state.wearIndex,
        team: state.team,
        sheen: state.sheen,
        unusual: state.unusual,
        preset: state.preset,
        projection: state.projection,
        fov: state.fov,
        statClock: statClock?.on && supportsStatClock(state.weaponKey) ? statClock.kills : null,
      });
      const url = `${window.location.pathname}${urlState.search}${urlState.hash}`;
      window.history.replaceState(null, '', url);
    }, URL_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [
    selectedKitId, state.weaponKey, state.seed, state.wearIndex, state.team,
    state.sheen, state.unusual, state.preset, state.projection, state.fov, statClock,
  ]);

  return { data, boot, advanceBoot };
}
