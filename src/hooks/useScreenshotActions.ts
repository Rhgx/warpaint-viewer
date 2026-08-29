import { useCallback } from 'react';
import type { RefObject } from 'react';
import type { Viewer } from '../viewer/Viewer';

export function useScreenshotActions({
  viewerRef,
  paintName,
  weaponKey,
  seed,
  maxEdge,
}: {
  viewerRef: RefObject<Viewer | null>;
  paintName?: string;
  weaponKey: string;
  seed: string;
  maxEdge: number;
}) {
  const saveImage = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Viewer not ready');
    const blob = await viewer.captureScreenshot({ maxEdge });
    const slug = paintName
      ? paintName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
      : '';
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${slug || 'warpaint'}_${weaponKey}_seed${seed}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }, [viewerRef, paintName, weaponKey, seed, maxEdge]);

  const copyImage = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Viewer not ready');
    const blob = await viewer.captureScreenshot({ maxEdge });
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
  }, [viewerRef, maxEdge]);

  return { saveImage, copyImage };
}
