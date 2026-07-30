export async function screenshotPixelsToBlob(
  raw: Uint8Array,
  width: number,
  height: number,
  scale: number,
): Promise<Blob> {
  const image = new ImageData(width, height);
  const out = image.data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = y * width * 4;
    for (let x = 0; x < width * 4; x += 4) {
      const r = raw[src + x];
      const g = raw[src + x + 1];
      const b = raw[src + x + 2];
      const a = raw[src + x + 3];
      const cover = Math.max(a, r, g, b);
      if (cover === 0) continue;
      out[dst + x] = Math.min(255, Math.round((r * 255) / cover));
      out[dst + x + 1] = Math.min(255, Math.round((g * 255) / cover));
      out[dst + x + 2] = Math.min(255, Math.round((b * 255) / cover));
      out[dst + x + 3] = cover;
      const pixelX = x / 4;
      minX = Math.min(minX, pixelX);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, pixelX);
      maxY = Math.max(maxY, y);
    }
  }

  const hasContent = maxX >= minX && maxY >= minY;
  const padding = Math.max(8, Math.round(24 * scale));
  const cropLeft = hasContent ? Math.max(0, minX - padding) : 0;
  const cropTop = hasContent ? Math.max(0, minY - padding) : 0;
  const cropRight = hasContent ? Math.min(width, maxX + 1 + padding) : width;
  const cropBottom = hasContent ? Math.min(height, maxY + 1 + padding) : height;
  const scratch = document.createElement('canvas');
  scratch.width = cropRight - cropLeft;
  scratch.height = cropBottom - cropTop;
  const ctx = scratch.getContext('2d');
  if (!ctx) throw new Error('[warpaint-viewer] screenshot canvas 2d context unavailable');
  ctx.putImageData(image, -cropLeft, -cropTop);
  const blob = await new Promise<Blob | null>((resolve) => scratch.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('[warpaint-viewer] screenshot capture failed');
  return blob;
}
