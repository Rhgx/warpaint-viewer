import { useEffect, useState } from 'react';
import type { RefObject } from 'react';

export function useContextRestores(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  engineReady: boolean,
  disposeCache: () => void,
): number {
  // A restored WebGL context leaves every render target blank: drop the cached
  // composites so the bump recomposes.
  // ponytail: a compose still in flight across the restore can cache one blank
  // variant; gate compositor work on isContextLost() if that ever shows up.
  const [contextRestores, setContextRestores] = useState(0);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!engineReady || !canvas) return;
    const onRestored = () => {
      disposeCache();
      setContextRestores((count) => count + 1);
    };
    canvas.addEventListener('webglcontextrestored', onRestored);
    return () => canvas.removeEventListener('webglcontextrestored', onRestored);
  }, [engineReady, disposeCache, canvasRef]);
  return contextRestores;
}
