import { useCallback } from 'react';
import type { RefObject } from 'react';
import type { Viewer } from '../viewer/Viewer';

export function useScreenshotActions({
  viewerRef,
  paintName,
  weaponKey,
  seed,
  scale,
}: {
  viewerRef: RefObject<Viewer | null>;
  paintName?: string;
  weaponKey: string;
  seed: string;
  scale: number;
}) {
  const saveImage = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Viewer not ready');
    const blob = await viewer.captureScreenshot(scale);
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
  }, [viewerRef, paintName, weaponKey, seed, scale]);

  const copyImage = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer) throw new Error('Viewer not ready');
    const blob = await viewer.captureScreenshot(scale);
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob }),
    ]);
  }, [viewerRef, scale]);

  const copyLink = useCallback(async () => {
    await navigator.clipboard.writeText(location.href);
  }, []);

  return { saveImage, copyImage, copyLink };
}
