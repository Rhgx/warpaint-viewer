/** A CPU-readable decoded group texture, compatible with browser ImageData. */
export interface RgbaImageDataLike {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

export interface GroupTexel {
  readonly x: number;
  readonly y: number;
}

export interface GroupSample extends GroupTexel {
  /** The unmodified red-channel byte stored in the group texture. */
  readonly red: number;
  /** The fxc/compositor comparison value: `round(red / 16)`. */
  readonly bucket: number;
}

/**
 * Maps normalized UV coordinates to a source-image texel.
 *
 * Group textures are loaded with `flipY = false`, so their V axis follows
 * ImageData rows: `v = 0` is the top row and V increases downward. Exact
 * right/bottom edge coordinates are clamped to the last texel, matching a
 * clamp-to-edge texture sample.
 */
export function groupTexelAtUv(image: RgbaImageDataLike, u: number, v: number): GroupTexel | null {
  if (!isValidImage(image) || !Number.isFinite(u) || !Number.isFinite(v)
    || u < 0 || u > 1 || v < 0 || v > 1) return null;
  return {
    x: Math.min(image.width - 1, Math.floor(u * image.width)),
    y: Math.min(image.height - 1, Math.floor(v * image.height)),
  };
}

/** Converts a raw 0..255 group byte to the compositor's 1/16 comparison bucket. */
export function groupByteToCompositorBucket(red: number): number | null {
  if (!Number.isFinite(red) || red < 0 || red > 255) return null;
  return Math.floor(red / 16 + 0.5);
}

/** Convert a visible 1..16 bucket to a canonical raw selector ID. */
export function rawGroupIdForBucket(bucket: number): number | null {
  if (!Number.isInteger(bucket) || bucket < 1 || bucket > 16) return null;
  return bucket === 16 ? 255 : bucket * 16;
}

/** Samples the raw red-channel group byte at an unflipped, V-down UV point. */
export function sampleGroupRedAtUv(image: RgbaImageDataLike, u: number, v: number): number | null {
  const texel = groupTexelAtUv(image, u, v);
  if (!texel) return null;
  const red = image.data[(texel.y * image.width + texel.x) * 4];
  return typeof red === 'number' && Number.isFinite(red) && red >= 0 && red <= 255 ? red : null;
}

/** Samples both the raw red byte and its compositor comparison bucket. */
export function sampleGroupAtUv(image: RgbaImageDataLike, u: number, v: number): GroupSample | null {
  const texel = groupTexelAtUv(image, u, v);
  if (!texel) return null;
  const red = sampleGroupRedAtUv(image, u, v);
  const bucket = red === null ? null : groupByteToCompositorBucket(red);
  return red === null || bucket === null ? null : { ...texel, red, bucket };
}

function isValidImage(image: RgbaImageDataLike): boolean {
  return Number.isSafeInteger(image.width) && image.width > 0
    && Number.isSafeInteger(image.height) && image.height > 0
    && image.data.length >= image.width * image.height * 4;
}
