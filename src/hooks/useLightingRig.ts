import { useCallback, useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { useStore } from 'zustand';
import { createLightingStore } from '../editor/lightingStore';
import { bindLightingStore } from '../viewer/bindLightingStore';
import { loadCustomLighting, saveCustomLighting } from '../viewer/controls';
import { CUSTOM_LIGHTING_ID, MAX_CUSTOM_LIGHTS } from '../viewer/customLighting';
import { LEGACY_PAINTKIT_ICON_LIGHTING_ID, PAINTKIT_ICON_LIGHTING_ID } from '../viewer/lighting';
import type { Viewer } from '../viewer/Viewer';
import { shortcutTargetsEditableContent } from '../ui/common/shortcuts';

interface UseLightingRigOptions {
  presetId: string;
  weaponKey: string;
  engineReady: boolean;
  viewerRef: RefObject<Viewer | null>;
  setMobilePanel: (panel: 'none') => void;
}

/** The custom lighting rig store, its persistence, keyboard shortcuts and viewer binding. */
export function useLightingRig({
  presetId,
  weaponKey,
  engineReady,
  viewerRef,
  setMobilePanel,
}: UseLightingRigOptions) {
  const [lightingStore] = useState(() => createLightingStore(loadCustomLighting()));
  const lightingPanelOpen = useStore(lightingStore, (lighting) => lighting.open);

  useEffect(() => {
    if (!lightingPanelOpen || presetId !== CUSTOM_LIGHTING_ID) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (shortcutTargetsEditableContent(event.target)) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const lighting = lightingStore.getState();
      const key = event.key.toLowerCase();
      const command = event.ctrlKey || event.metaKey;
      if ((key === 'delete' || key === 'backspace') && !command && !event.altKey && !event.shiftKey) {
        if (!lighting.selectedLightId) return;
        event.preventDefault();
        lighting.deleteSelected();
      } else if (key === 'd' && command && !event.altKey && !event.shiftKey) {
        if (!lighting.selectedLightId || lighting.rig.lights.length >= MAX_CUSTOM_LIGHTS) return;
        event.preventDefault();
        lighting.duplicateSelected();
      } else if (key === 'h' && !command && !event.altKey && !event.shiftKey) {
        if (!lighting.selectedLightId) return;
        event.preventDefault();
        lighting.toggleSelected();
      } else if (key === 'z' && command && !event.shiftKey && lighting.canUndo) {
        event.preventDefault();
        lighting.undo();
      } else if (command && (key === 'y' || (key === 'z' && event.shiftKey)) && lighting.canRedo) {
        event.preventDefault();
        lighting.redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [lightingStore, lightingPanelOpen, presetId]);

  // Subscribe outside React so rig previews do not render MainApp.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!engineReady || !viewer) return;
    const preset = weaponKey === 'paintkit_tool'
      ? presetId === 'inspect' ? PAINTKIT_ICON_LIGHTING_ID
        : presetId === 'inspect-legacy' ? LEGACY_PAINTKIT_ICON_LIGHTING_ID : presetId
      : presetId;
    return bindLightingStore(lightingStore, viewer, preset);
  }, [engineReady, lightingStore, presetId, weaponKey, viewerRef]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = lightingStore.subscribe((current, previous) => {
      if (current.rig === previous.rig) return;
      clearTimeout(timeout);
      timeout = setTimeout(() => saveCustomLighting(lightingStore.getState().rig), 150);
    });
    return () => {
      unsubscribe();
      clearTimeout(timeout);
      saveCustomLighting(lightingStore.getState().rig);
    };
  }, [lightingStore]);

  // Opening the panel enables viewport helpers; changing presets resets it.
  useEffect(() => {
    lightingStore.getState().setOpen(presetId === CUSTOM_LIGHTING_ID);
  }, [lightingStore, presetId]);

  const selectLight = useCallback((id: string) => {
    const lighting = lightingStore.getState();
    lighting.select(id);
    lighting.setOpen(true);
    setMobilePanel('none');
  }, [lightingStore, setMobilePanel]);

  const toggleLightingPanel = useCallback(() => {
    const lighting = lightingStore.getState();
    if (!lighting.open) setMobilePanel('none');
    lighting.setOpen(!lighting.open);
  }, [lightingStore, setMobilePanel]);

  return { lightingStore, lightingPanelOpen, selectLight, toggleLightingPanel };
}
