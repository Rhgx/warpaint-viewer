import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import { deleteLightFromRig, duplicateLightInRig } from '../ui/stage/lightingRig';
import { validateCustomLightingRig } from '../viewer/customLighting';
import type { CustomLightingRig } from '../viewer/customLighting';
import { SnapshotHistory } from './history';

interface LightingState {
  rig: CustomLightingRig;
  selectedLightId: string | null;
  open: boolean;
  canUndo: boolean;
  canRedo: boolean;
  setOpen(open: boolean): void;
  select(id: string | null): void;
  apply(rig: CustomLightingRig): void;
  preview(rig: CustomLightingRig): void;
  undo(): void;
  redo(): void;
  deleteSelected(): void;
  duplicateSelected(): void;
  toggleSelected(): void;
}

function selectedLight(rig: CustomLightingRig, id: string | null): string | null {
  return id !== null && rig.lights.some((light) => light.id === id) ? id : rig.lights[0]?.id ?? null;
}

export function createLightingStore(initialRig: CustomLightingRig) {
  // Match the Viewer's normalization before callbacks can treat it as an edit.
  const rig = validateCustomLightingRig(initialRig);
  const history = new SnapshotHistory<CustomLightingRig>();
  let previewBaseline: CustomLightingRig | null = null;
  const equal = (left: CustomLightingRig, right: CustomLightingRig) => (
    left === right || JSON.stringify(left) === JSON.stringify(right)
  );

  return createStore<LightingState>()(subscribeWithSelector((set, get) => {
    // Publish the rig, valid selection, and history availability together.
    function publish(rig: CustomLightingRig, id = get().selectedLightId) {
      const current = get();
      const selectedLightId = selectedLight(rig, id);
      const canUndo = history.canUndo;
      const canRedo = history.canRedo;
      if (current.rig === rig && current.selectedLightId === selectedLightId
        && current.canUndo === canUndo && current.canRedo === canRedo) return;
      set({ rig, selectedLightId, canUndo, canRedo });
    }

    function apply(rig: CustomLightingRig, id = get().selectedLightId) {
      const current = get().rig;
      const baseline = previewBaseline;
      previewBaseline = null;
      if (equal(current, rig)) {
        if (baseline && !equal(baseline, current)) history.record(baseline);
        publish(current, id);
        return;
      }
      history.record(baseline ?? current);
      publish(rig, id);
    }

    return {
      rig,
      selectedLightId: selectedLight(rig, null),
      open: false,
      canUndo: false,
      canRedo: false,
      setOpen(open) {
        if (get().open !== open) set({ open });
      },
      select(id) {
        publish(get().rig, id);
      },
      apply,
      preview(rig) {
        const current = get().rig;
        if (equal(current, rig)) return;
        previewBaseline ??= current;
        publish(rig);
      },
      undo() {
        previewBaseline = null;
        const rig = history.undo(get().rig);
        if (rig) publish(rig);
      },
      redo() {
        previewBaseline = null;
        const rig = history.redo(get().rig);
        if (rig) publish(rig);
      },
      deleteSelected() {
        const { rig, selectedLightId } = get();
        if (selectedLightId === null) return;
        const result = deleteLightFromRig(rig, selectedLightId);
        if (result) apply(result.rig, result.selectedLightId);
      },
      duplicateSelected() {
        const { rig, selectedLightId } = get();
        if (selectedLightId === null) return;
        const result = duplicateLightInRig(rig, selectedLightId);
        if (result) apply(result.rig, result.selectedLightId);
      },
      toggleSelected() {
        const { rig, selectedLightId } = get();
        if (selectedLightId === null) return;
        apply({ ...rig, lights: rig.lights.map((light) => (
          light.id === selectedLightId ? { ...light, enabled: !light.enabled } : light
        )) });
      },
    };
  }));
}

export type LightingStore = ReturnType<typeof createLightingStore>;
