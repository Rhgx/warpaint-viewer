import { useEffect } from 'react';
import type { RefObject } from 'react';
import type { Viewer } from '../viewer/Viewer';
import { matchesMobileLayout } from '../device';
import type { MobilePanel } from '../ui/stage/MobileTabStrip';

interface UseMobileViewInsetOptions {
  viewerRef: RefObject<Viewer | null>;
  inspectorRef: RefObject<HTMLElement | null>;
  engineReady: boolean;
  mobilePanel: MobilePanel;
  firstPersonActive: boolean;
}

export function useMobileViewInset({
  viewerRef,
  inspectorRef,
  engineReady,
  mobilePanel,
  firstPersonActive,
}: UseMobileViewInsetOptions) {
  // Keep the weapon in the canvas area that an open mobile Controls panel leaves
  // uncovered. Measures the layout box, which the slide transform does not change.
  // First Person is a dependency only because it changes the sheet height.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!engineReady || !viewer) return;
    const update = () => {
      const panel = mobilePanel === 'controls' && matchesMobileLayout() ? inspectorRef.current : null;
      if (!panel) viewer.setViewInset(0, 0);
      else if (window.matchMedia('(orientation: portrait)').matches) viewer.setViewInset(0, panel.offsetHeight);
      else viewer.setViewInset(panel.offsetWidth, 0);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [engineReady, mobilePanel, firstPersonActive, viewerRef, inspectorRef]);
}
