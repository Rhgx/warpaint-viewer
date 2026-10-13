import { useEffect, useState } from 'react';
import { loadTextureDirectory } from '../data/loader';
import type { TextureDirectory } from '../data/types';
import { useSettings } from '../settings';

/** Pyxell's texture directory while its Settings toggle is on, otherwise null. */
export function useTextureDirectory(): TextureDirectory | null {
  const enabled = useSettings((s) => s.showPaintkitDetails);
  const [directory, setDirectory] = useState<TextureDirectory | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadTextureDirectory().then(
      (loaded) => { if (live) setDirectory(loaded); },
      (err: unknown) => console.error('[warpaint-viewer] texture directory failed to load:', err),
    );
    return () => { live = false; };
  }, [enabled]);

  return enabled ? directory : null;
}
