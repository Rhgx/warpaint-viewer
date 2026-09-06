import type { LightingStore } from '../editor/lightingStore';
import { CUSTOM_LIGHTING_ID } from './customLighting';
import type { Viewer } from './Viewer';

type LightingViewer = Pick<Viewer,
  'setCustomLighting' | 'setLighting' | 'setLightingEditorState'
  | 'onCustomLightingChange' | 'onLightSelectionChange'>;

/** Owns the two-way binding for one viewer/preset lifetime. */
export function bindLightingStore(store: LightingStore, viewer: LightingViewer, preset: string) {
  let syncing = false;
  const sync = (state: ReturnType<LightingStore['getState']>, previous?: ReturnType<LightingStore['getState']>) => {
    // setRig can emit a temporary null selection while rebuilding light helpers.
    syncing = true;
    try {
      if (!previous || (preset === CUSTOM_LIGHTING_ID && state.rig !== previous.rig)) {
        viewer.setCustomLighting(state.rig);
        if (preset !== CUSTOM_LIGHTING_ID) viewer.setLighting(preset);
      }
      if (!previous || state.rig !== previous.rig || state.open !== previous.open || state.selectedLightId !== previous.selectedLightId) {
        viewer.setLightingEditorState({
          enabled: state.open && preset === CUSTOM_LIGHTING_ID,
          selectedLightId: state.selectedLightId,
        });
      }
    } finally {
      syncing = false;
    }
  };
  sync(store.getState());
  const unsubscribeStore = store.subscribe(sync);
  // Both Viewer listeners immediately replay the state we just seeded. A
  // replay must not commit an in-progress slider preview when rebinding.
  syncing = true;
  const unsubscribeRig = viewer.onCustomLightingChange((rig) => {
    if (!syncing) store.getState().apply(rig);
  });
  const unsubscribeSelection = viewer.onLightSelectionChange((id) => {
    if (!syncing) store.getState().select(id);
  });
  syncing = false;
  return () => {
    unsubscribeStore();
    unsubscribeRig();
    unsubscribeSelection();
  };
}
