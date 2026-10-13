import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// User preferences from the Settings modal. Workshopper tools default to off
// so the viewer stays uncluttered for people who only browse paints.
interface SettingsState {
  /** Paint kit IDs plus Pyxell's texture directory entries. */
  showPaintkitDetails: boolean;
  setShowPaintkitDetails(show: boolean): void;
}

// persist falls back to in-memory state when localStorage is unavailable, so
// toggles still work for the session in private browsing.
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      showPaintkitDetails: false,
      setShowPaintkitDetails: (showPaintkitDetails) => set({ showPaintkitDetails }),
    }),
    { name: 'warpaint-viewer:settings', version: 1 },
  ),
);
