export interface ScreenshotSize {
  readonly maxEdge: number;
}

export interface ScreenshotCapture {
  readonly width: number;
  readonly height: number;
  readonly paddingScale: number;
  readonly outputMaxEdge: number | null;
}

export function resolveScreenshotCapture(
  size: number | ScreenshotSize,
  viewportWidth: number,
  viewportHeight: number,
): ScreenshotCapture {
  if (typeof size === 'number') {
    return {
      width: viewportWidth * size,
      height: viewportHeight * size,
      paddingScale: size,
      outputMaxEdge: null,
    };
  }
  const scale = size.maxEdge / Math.max(viewportWidth, viewportHeight);
  return {
    width: Math.max(1, Math.round(viewportWidth * scale)),
    height: Math.max(1, Math.round(viewportHeight * scale)),
    paddingScale: scale,
    outputMaxEdge: size.maxEdge,
  };
}

export function fitScreenshotCapture(
  capture: ScreenshotCapture,
  maxDimension: number,
  maxPixels: number,
): ScreenshotCapture {
  const scale = Math.min(
    1,
    maxDimension / Math.max(capture.width, capture.height),
    Math.sqrt(maxPixels / (capture.width * capture.height)),
  );
  if (scale === 1) return capture;
  return {
    ...capture,
    width: Math.max(1, Math.floor(capture.width * scale)),
    height: Math.max(1, Math.floor(capture.height * scale)),
    paddingScale: capture.paddingScale * scale,
  };
}

export function screenshotOutputSize(
  croppedWidth: number,
  croppedHeight: number,
  outputMaxEdge: number | null,
): { readonly width: number; readonly height: number } {
  if (outputMaxEdge === null) return { width: croppedWidth, height: croppedHeight };
  if (croppedWidth >= croppedHeight) {
    return {
      width: outputMaxEdge,
      height: Math.max(1, Math.round(croppedHeight * outputMaxEdge / croppedWidth)),
    };
  }
  return {
    width: Math.max(1, Math.round(croppedWidth * outputMaxEdge / croppedHeight)),
    height: outputMaxEdge,
  };
}

export function screenshotWatermarkScale(width: number, height: number): number {
  // Fit the same watermark proportions in landscape and portrait exports.
  return Math.min(Math.max(width, height) / 1280, Math.min(width, height) / 720);
}

export async function screenshotPixelsToBlob(
  raw: Uint8Array,
  width: number,
  height: number,
  paddingScale: number,
  outputMaxEdge: number | null,
  firstPersonWatermark = false,
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
  const padding = Math.max(8, Math.round(24 * paddingScale));
  const cropLeft = hasContent ? Math.max(0, minX - padding) : 0;
  const cropTop = hasContent ? Math.max(0, minY - padding) : 0;
  const cropRight = hasContent ? Math.min(width, maxX + 1 + padding) : width;
  const cropBottom = hasContent ? Math.min(height, maxY + 1 + padding) : height;
  const cropped = document.createElement('canvas');
  cropped.width = cropRight - cropLeft;
  cropped.height = cropBottom - cropTop;
  const croppedContext = cropped.getContext('2d');
  if (!croppedContext) throw new Error('[warpaint-viewer] screenshot canvas 2d context unavailable');
  croppedContext.putImageData(image, -cropLeft, -cropTop);

  const outputSize = screenshotOutputSize(cropped.width, cropped.height, outputMaxEdge);
  let output = cropped;
  if (outputSize.width !== cropped.width || outputSize.height !== cropped.height) {
    output = document.createElement('canvas');
    output.width = outputSize.width;
    output.height = outputSize.height;
    const outputContext = output.getContext('2d');
    if (!outputContext) throw new Error('[warpaint-viewer] screenshot resize canvas 2d context unavailable');
    outputContext.imageSmoothingQuality = 'high';
    outputContext.drawImage(cropped, 0, 0, output.width, output.height);
  }

  if (firstPersonWatermark) {
    const logo = new Image();
    logo.src = `${import.meta.env.BASE_URL}watermark-logo.svg`;
    await Promise.all([
      logo.decode(),
      document.fonts.load('600 18px "Barlow Semi Condensed"'),
      document.fonts.load('400 14px "Barlow Semi Condensed"'),
    ]);
    const context = output.getContext('2d');
    if (!context) throw new Error('[warpaint-viewer] watermark canvas 2d context unavailable');
    // Draw after cropping and resizing so the label stays inside every export.
    const scale = screenshotWatermarkScale(output.width, output.height);
    context.save();
    context.scale(scale, scale);
    context.translate(28, output.height / scale - 70);
    context.globalAlpha = 0.62;
    context.drawImage(logo, 0, 0, 38, 41);
    context.fillStyle = '#fff';
    context.textBaseline = 'top';
    context.font = '600 18px "Barlow Semi Condensed", sans-serif';
    context.letterSpacing = '1.5px';
    context.fillText('WAR PAINT VIEWER', 52, 3);
    context.globalAlpha = 0.48;
    context.font = '400 14px "Barlow Semi Condensed", sans-serif';
    context.letterSpacing = '0px';
    context.fillText('Not an in-game screenshot', 52, 26);
    context.restore();
  }

  const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('[warpaint-viewer] screenshot capture failed');
  return blob;
}
