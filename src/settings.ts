import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export const THEMES = [
  { id: 'default', label: 'Default' },
  { id: 'midnight', label: 'Midnight' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'ember', label: 'Ember' },
  { id: 'gold', label: 'Gold' },
] as const;
export type ThemeId = (typeof THEMES)[number]['id'];

/** Whatever storage held, anything but a known theme is Default. The script in index.html applies the same rule before first paint. */
export function parseTheme(value: unknown): ThemeId {
  return THEMES.find((theme) => theme.id === value)?.id ?? 'default';
}

/** The current value of a token in tokens.css, which is the one place the palettes live. */
function readToken(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export const readStageColor = () => readToken('--stage-bg');

const FAVICON_ACCENT = '#4c8dff';
let faviconSvg: Promise<string> | null = null;

/** Repaints the favicon's outline in the current theme's accent. If the fetch fails, the tab simply keeps the default icon. */
export async function syncFavicon(): Promise<void> {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  const source = link.dataset.source ?? link.href;
  link.dataset.source = source;
  faviconSvg ??= fetch(source).then((response) => response.text());
  const svg = await faviconSvg.catch(() => null);
  if (!svg) return;
  // Read after the wait, so that the last theme picked wins.
  link.href = `data:image/svg+xml,${encodeURIComponent(svg.replaceAll(FAVICON_ACCENT, readToken('--accent')))}`;
}

function applyTheme(theme: ThemeId): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', readToken('--accent'));
  void syncFavicon();
}

// User preferences from the Settings modal. Workshopper tools default to off.
interface SettingsState {
  theme: ThemeId;
  setTheme(theme: ThemeId): void;
  /** Paint kit IDs plus Pyxell's texture directory entries. */
  showPaintkitDetails: boolean;
  setShowPaintkitDetails(show: boolean): void;
  /** Exact paint kit ID and op:<operation> matches in the warpaint filter. */
  advancedCatalogSearch: boolean;
  setAdvancedCatalogSearch(enabled: boolean): void;
  /** The showcase board button in the stage toolbar (desktop only). */
  showcaseBoard: boolean;
  setShowcaseBoard(enabled: boolean): void;
}

// persist falls back to in-memory state when localStorage is unavailable; toggles still work this session.
export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      theme: 'default',
      setTheme: (theme) => {
        // Before the store notifies anyone, so that a subscriber reads the new theme's tokens.
        applyTheme(theme);
        set({ theme });
      },
      showPaintkitDetails: false,
      setShowPaintkitDetails: (showPaintkitDetails) => set({ showPaintkitDetails }),
      advancedCatalogSearch: false,
      setAdvancedCatalogSearch: (advancedCatalogSearch) => set({ advancedCatalogSearch }),
      showcaseBoard: false,
      setShowcaseBoard: (showcaseBoard) => set({ showcaseBoard }),
    }),
    {
      name: 'warpaint-viewer:settings',
      version: 1,
      merge: (persisted, current) => {
        const stored = (typeof persisted === 'object' ? persisted : null) ?? {};
        return { ...current, ...stored, theme: 'theme' in stored ? parseTheme(stored.theme) : current.theme };
      },
    },
  ),
);
