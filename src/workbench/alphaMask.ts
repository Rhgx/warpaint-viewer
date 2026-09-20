export function applyAlphaMask(color: Uint8ClampedArray, mask: Uint8ClampedArray): void {
  let hasTransparency = false;
  for (let index = 3; index < mask.length; index += 4) {
    if (mask[index] < 255) {
      hasTransparency = true;
      break;
    }
  }
  for (let index = 0; index < color.length; index += 4) {
    color[index + 3] = hasTransparency
      ? mask[index + 3]
      : Math.round(
          mask[index] * 0.299
            + mask[index + 1] * 0.587
            + mask[index + 2] * 0.114,
        );
  }
}
