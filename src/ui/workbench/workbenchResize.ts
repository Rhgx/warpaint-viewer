import type { PointerEvent as ReactPointerEvent } from 'react';
import { MIN_PANEL_HEIGHT } from './workbenchLabels';

// Drag the drawer's top edge to trade stage height for a taller asset grid.
export function startWorkbenchResize(
  event: ReactPointerEvent<HTMLDivElement>,
  {
    sectionRef,
    onResize,
    setResizing,
  }: {
    sectionRef: { current: HTMLElement | null };
    onResize: (height: number) => void;
    setResizing: (resizing: boolean) => void;
  },
) {
  const startY = event.clientY;
  const startHeight = sectionRef.current?.offsetHeight ?? 0;
  const maxHeight = Math.round(window.innerHeight * 0.75);
  event.currentTarget.setPointerCapture(event.pointerId);
  setResizing(true);
  const move = (moveEvent: PointerEvent) => {
    const height = startHeight + (startY - moveEvent.clientY);
    onResize(Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, height)));
  };
  const stop = () => {
    setResizing(false);
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', stop);
    window.removeEventListener('pointercancel', stop);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}
