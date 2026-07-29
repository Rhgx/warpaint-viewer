// DXT1 / DXT5 (BC1 / BC3) block compressors for the VTF export path.
//
// This is deliberately the simplest correct compressor, not a quality-tuned
// one: a bounding-box endpoint fit plus nearest-palette-entry assignment.
// Warpaint textures are mostly flat mask regions and soft gradients, where a
// box fit already lands close to optimal, and the encoder favours being
// readable and easy to audit against tools/lib/vtf-core.mjs's decode math
// over squeezing out another fraction of a dB.
//
// Every formula here (565 expansion, 4-colour interpolation, 8-value alpha
// ramp, index bit packing) is written to mirror decodeDxt in
// tools/lib/vtf-core.mjs exactly, so a block this module writes decodes back
// through the exact value it was fit against.

/** Number of 4x4 blocks needed to cover a dimension, matching the decoder. */
function blockSpan(size: number): number {
  return Math.max(1, Math.ceil(size / 4));
}

// RGB565 only has 5/6/5 bits per channel, so a flat 8-bit value does not
// always survive quantisation unchanged: 96 quantises to 12/31 of the 5-bit
// range and expands back to 99. Callers that need a channel to stay
// byte-exact (e.g. a mask encoded in a colour channel) must not rely on
// DXT1 for it, which is why this project's exporters default masks to a
// lossless format instead.
function quantize565(r: number, g: number, b: number): number {
  const r5 = Math.round((r / 255) * 31);
  const g6 = Math.round((g / 255) * 63);
  const b5 = Math.round((b / 255) * 31);
  return (r5 << 11) | (g6 << 5) | b5;
}

function expand565(value: number): [number, number, number] {
  const r = (value >> 11) & 0x1f;
  const g = (value >> 5) & 0x3f;
  const b = value & 0x1f;
  return [(r * 255) / 31, (g * 255) / 63, (b * 255) / 31];
}

/**
 * Build the 4-entry RGB palette for a colour block, given the two packed
 * RGB565 endpoints. This always uses the 4-colour interpolation (2:1 and 1:2
 * blends), matching what the decoder does unconditionally for DXT5 colour
 * blocks and what it does for DXT1 whenever color0 > color1.
 */
function fourColorPalette(color0: number, color1: number): [number, number, number][] {
  const c0 = expand565(color0);
  const c1 = expand565(color1);
  return [
    c0,
    c1,
    [(2 * c0[0] + c1[0]) / 3, (2 * c0[1] + c1[1]) / 3, (2 * c0[2] + c1[2]) / 3],
    [(c0[0] + 2 * c1[0]) / 3, (c0[1] + 2 * c1[1]) / 3, (c0[2] + 2 * c1[2]) / 3],
  ];
}

interface Texel { r: number; g: number; b: number; a: number }

/** Read a 4x4 block from the source image, replicating the edge pixel for
 * dimensions that are not a multiple of 4 (the decoder skips those texels on
 * read, but the encoder still has to fill a full block with something, and
 * the edge pixel is the only value that keeps the compressed block from
 * pulling in colour that never appeared in the image). */
function readBlock(pixels: Uint8Array, width: number, height: number, blockX: number, blockY: number): Texel[] {
  const texels: Texel[] = new Array(16);
  for (let dy = 0; dy < 4; dy += 1) {
    const y = Math.min(blockY * 4 + dy, height - 1);
    for (let dx = 0; dx < 4; dx += 1) {
      const x = Math.min(blockX * 4 + dx, width - 1);
      const offset = (y * width + x) * 4;
      texels[dy * 4 + dx] = { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2], a: pixels[offset + 3] };
    }
  }
  return texels;
}

/**
 * Fit and write one DXT1 colour block (8 bytes: two RGB565 endpoints, then
 * sixteen 2-bit palette indices) at `out[outOffset..outOffset+7]`.
 */
function writeColorBlock(texels: Texel[], out: Uint8Array, outOffset: number): void {
  let minR = 255; let minG = 255; let minB = 255;
  let maxR = 0; let maxG = 0; let maxB = 0;
  for (const t of texels) {
    if (t.r < minR) minR = t.r; if (t.g < minG) minG = t.g; if (t.b < minB) minB = t.b;
    if (t.r > maxR) maxR = t.r; if (t.g > maxG) maxG = t.g; if (t.b > maxB) maxB = t.b;
  }

  let color0: number;
  let color1: number;
  const indices = new Uint8Array(16);

  if (minR === maxR && minG === maxG && minB === maxB) {
    // A flat region: both endpoints must quantise to the same colour and
    // every index must point at it, or a flat mask boundary would grow a
    // visible seam once decoded.
    color0 = quantize565(maxR, maxG, maxB);
    color1 = color0;
  } else {
    // Pull the bounding box in by a sixteenth of its span before quantising.
    // The two endpoints are palette entries in their own right, so a box drawn
    // through the extreme texels spends both of them on outliers and leaves the
    // two interpolated entries to cover everything in between. The inset is the
    // standard fix (stb_dxt does the same) and is worth around a decibel on
    // artwork with hard edges.
    const insetR = (maxR - minR) >> 4;
    const insetG = (maxG - minG) >> 4;
    const insetB = (maxB - minB) >> 4;
    maxR = Math.max(minR, maxR - insetR); minR = Math.min(maxR, minR + insetR);
    maxG = Math.max(minG, maxG - insetG); minG = Math.min(maxG, minG + insetG);
    maxB = Math.max(minB, maxB - insetB); minB = Math.min(maxB, minB + insetB);

    let hi = quantize565(maxR, maxG, maxB);
    let lo = quantize565(minR, minG, minB);
    if (hi < lo) { const swap = hi; hi = lo; lo = swap; }
    if (hi === lo) {
      // The bounding box is non-degenerate in 8-bit space but both corners
      // quantised to the same RGB565 value. Nudge one endpoint's lowest
      // populated channel down by one step so color0 > color1 holds and the
      // block stays in 4-colour mode instead of silently losing the DXT1
      // one-colour-plus-transparent-black special case (colors[3] would
      // decode as opaque black, which is never what a near-flat block wants).
      if (lo & 0x1f) lo -= 1;
      else if (lo & 0x7e0) lo -= 0x20;
      else if (lo & 0xf800) lo -= 0x800;
      else hi += 1;
    }
    color0 = hi;
    color1 = lo;

    const palette = fourColorPalette(color0, color1);
    for (let i = 0; i < 16; i += 1) {
      const t = texels[i];
      let best = 0;
      let bestDist = Infinity;
      for (let p = 0; p < 4; p += 1) {
        const [pr, pg, pb] = palette[p];
        const dr = t.r - pr; const dg = t.g - pg; const db = t.b - pb;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      indices[i] = best;
    }
  }

  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(outOffset, color0, true);
  view.setUint16(outOffset + 2, color1, true);
  // Pack four 2-bit indices per byte, texel 0 in the low bits, matching the
  // decoder's `(selectors >>> (index * 2)) & 3`.
  out[outOffset + 4] = indices[0] | (indices[1] << 2) | (indices[2] << 4) | (indices[3] << 6);
  out[outOffset + 5] = indices[4] | (indices[5] << 2) | (indices[6] << 4) | (indices[7] << 6);
  out[outOffset + 6] = indices[8] | (indices[9] << 2) | (indices[10] << 4) | (indices[11] << 6);
  out[outOffset + 7] = indices[12] | (indices[13] << 2) | (indices[14] << 4) | (indices[15] << 6);
}

/**
 * Fit and write one DXT5 alpha block (8 bytes: two 8-bit endpoints, then
 * sixteen 3-bit palette indices) at `out[outOffset..outOffset+7]`.
 */
function writeAlphaBlock(texels: Texel[], out: Uint8Array, outOffset: number): void {
  let minA = 255; let maxA = 0;
  for (const t of texels) { if (t.a < minA) minA = t.a; if (t.a > maxA) maxA = t.a; }

  let alpha0: number;
  let alpha1: number;
  const indices = new Uint8Array(16);

  if (minA === maxA) {
    // Uniform alpha (very common: fully opaque, or fully transparent mask
    // padding) must round-trip exactly, so skip interpolation entirely.
    alpha0 = maxA;
    alpha1 = maxA;
  } else {
    // maxA > minA here, so alpha0 > alpha1 always holds, which keeps the
    // decoder in the 8-value ramp rather than the 6-value-plus-0-plus-255 mode.
    alpha0 = maxA;
    alpha1 = minA;
    const ramp = [alpha0, alpha1, 0, 0, 0, 0, 0, 0];
    for (let step = 1; step <= 6; step += 1) ramp[step + 1] = ((7 - step) * alpha0 + step * alpha1) / 7;
    for (let i = 0; i < 16; i += 1) {
      const a = texels[i].a;
      let best = 0;
      let bestDist = Infinity;
      for (let p = 0; p < 8; p += 1) {
        const dist = Math.abs(a - ramp[p]);
        if (dist < bestDist) { bestDist = dist; best = p; }
      }
      indices[i] = best;
    }
  }

  out[outOffset] = alpha0;
  out[outOffset + 1] = alpha1;
  // Sixteen 3-bit indices pack into 6 bytes with no wasted bits: texels 0-7
  // fill the first 3 bytes (24 bits) and texels 8-15 fill the next 3, which
  // is why the split can be done as two 24-bit accumulators without ever
  // needing a bit to straddle that boundary.
  let low = 0;
  for (let i = 0; i < 8; i += 1) low |= indices[i] << (i * 3);
  let high = 0;
  for (let i = 8; i < 16; i += 1) high |= indices[i] << ((i - 8) * 3);
  out[outOffset + 2] = low & 0xff;
  out[outOffset + 3] = (low >>> 8) & 0xff;
  out[outOffset + 4] = (low >>> 16) & 0xff;
  out[outOffset + 5] = high & 0xff;
  out[outOffset + 6] = (high >>> 8) & 0xff;
  out[outOffset + 7] = (high >>> 16) & 0xff;
}

/** Compress an unpremultiplied RGBA image (top-down, 4 bytes/pixel) to DXT1. */
export function compressDxt1(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const blocksWide = blockSpan(width);
  const blocksHigh = blockSpan(height);
  const out = new Uint8Array(blocksWide * blocksHigh * 8);
  for (let by = 0; by < blocksHigh; by += 1) {
    for (let bx = 0; bx < blocksWide; bx += 1) {
      const texels = readBlock(pixels, width, height, bx, by);
      writeColorBlock(texels, out, (by * blocksWide + bx) * 8);
    }
  }
  return out;
}

/** Compress an unpremultiplied RGBA image (top-down, 4 bytes/pixel) to DXT5. */
export function compressDxt5(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const blocksWide = blockSpan(width);
  const blocksHigh = blockSpan(height);
  const out = new Uint8Array(blocksWide * blocksHigh * 16);
  for (let by = 0; by < blocksHigh; by += 1) {
    for (let bx = 0; bx < blocksWide; bx += 1) {
      const texels = readBlock(pixels, width, height, bx, by);
      const blockOffset = (by * blocksWide + bx) * 16;
      writeAlphaBlock(texels, out, blockOffset);
      writeColorBlock(texels, out, blockOffset + 8);
    }
  }
  return out;
}
