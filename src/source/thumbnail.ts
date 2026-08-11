export const SOURCE_THUMBNAIL_SIDE = 32;

/** Downsample authored RGB independently from Source's material-data alpha. */
export function opaqueRgbaThumbnail(
  rgba: Uint8Array,
  width: number,
  height: number,
  side = SOURCE_THUMBNAIL_SIDE,
): Uint8Array {
  if (rgba.length !== width * height * 4 || width <= 0 || height <= 0 || side <= 0) {
    throw new Error('Cannot make a thumbnail from invalid RGBA dimensions.');
  }
  const output = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    const sourceY0 = Math.floor(y * height / side);
    const sourceY1 = Math.max(sourceY0 + 1, Math.floor((y + 1) * height / side));
    for (let x = 0; x < side; x += 1) {
      const sourceX0 = Math.floor(x * width / side);
      const sourceX1 = Math.max(sourceX0 + 1, Math.floor((x + 1) * width / side));
      let red = 0;
      let green = 0;
      let blue = 0;
      let samples = 0;
      for (let sourceY = sourceY0; sourceY < Math.min(sourceY1, height); sourceY += 1) {
        for (let sourceX = sourceX0; sourceX < Math.min(sourceX1, width); sourceX += 1) {
          const source = (sourceY * width + sourceX) * 4;
          red += rgba[source];
          green += rgba[source + 1];
          blue += rgba[source + 2];
          samples += 1;
        }
      }
      const target = (y * side + x) * 4;
      output[target] = Math.round(red / samples);
      output[target + 1] = Math.round(green / samples);
      output[target + 2] = Math.round(blue / samples);
      output[target + 3] = 255;
    }
  }
  return output;
}
