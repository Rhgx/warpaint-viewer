// Streaming animated GIF encoder for turntable captures. Quality comes from the
// palette, never from dithering: one shared palette is fitted to representative
// frames (weighted variance median cut in Oklab, refined with k-means) and
// pixels map to their perceptually nearest entry. Sharing one palette keeps
// flat areas from shimmering between frames; a frame the shared palette fits
// badly (glow falloff, mostly) gets a local palette in which only the entries
// it never uses are refitted, so its stable colours stay exact.
// Size comes from inter-frame diffing: every frame after the first only covers
// the rectangle that changed, with unchanged pixels left transparent when that
// compresses smaller. Index 255 is transparent both for "unchanged" and for
// empty pixels; a frame whose successor needs pixels cleared back to empty is
// widened over them and disposed to background afterwards. Frames are encoded
// as they arrive, so memory stays near the size of the output.

export interface GifAnimation {
  readonly width: number;
  readonly height: number;
  /**
   * sRGB pixels, 4 bytes per pixel, row-major from the top left. Alpha is
   * 1-bit: below 128 is transparent, anything else opaque.
   */
  readonly frames: readonly Uint8Array[];
  /** Per-frame delay in hundredths of a second (browsers clamp below 2). */
  readonly delayCs: number;
}

const TRANSPARENT = 255;
const MAX_COLORS = 255; // index 255 is reserved for "unchanged since last frame"
const KMEANS_ITERATIONS = 6;
const HIST_BITS = 6;
/** Canvas colour of a transparent pixel (real colours are 0xRRGGBB). */
const EMPTY = -1;
/**
 * Oklab distance past which a pixel counts as badly matched, a little over
 * one just-noticeable difference. Tuned on a glow-heavy capture: it removes
 * the banding tail (99.9th-percentile error 0.078 down to 0.028) for about 7%
 * more bytes; 0.02 buys nothing further at twice the cost.
 */
const POOR_FIT = 0.03;
/** A frame earns a local palette once this share of its pixels fits poorly. */
const POOR_FIT_SHARE = 0.002;
const POOR_FIT_MIN_PIXELS = 32;
/** Refitting fewer spare entries than this is not worth a local palette. */
const MIN_SPARE_ENTRIES = 16;

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(c * 255)));
}

function toOklab(r: number, g: number, b: number, out: Float64Array, i: number) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[i] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[i + 1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[i + 2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}

function fromOklab(L: number, a: number, b: number, out: Uint8Array, i: number) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  out[i] = linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  out[i + 1] = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  out[i + 2] = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}

/** Squared distance of the last `nearest` result. */
let nearestDist = 0;

function nearest(lab: Float64Array, i: number, palette: Float64Array, count: number): number {
  const L = lab[i];
  const a = lab[i + 1];
  const b = lab[i + 2];
  let best = 0;
  let bestDist = Infinity;
  for (let p = 0; p < count; p++) {
    const dL = palette[p * 3] - L;
    const da = palette[p * 3 + 1] - a;
    const db = palette[p * 3 + 2] - b;
    const dist = dL * dL + da * da + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = p;
    }
  }
  nearestDist = bestDist;
  return best;
}

/** Fits up to `maxColors` sRGB colours to the frames; returns packed RGB triples. */
// Histogram in 6-bit bins that keep exact colour sums, so bin means are true
// averages rather than bin centres. Reused between calls (local palettes build
// one per refitted frame); `histKeys` lists the bins in use so reading and
// clearing them never scans the whole table.
const HIST_BINS = 1 << (HIST_BITS * 3);
const histCount = new Float64Array(HIST_BINS);
const histSums = new Float64Array(HIST_BINS * 3);
const histKeys = new Int32Array(HIST_BINS);

export function buildPalette(frames: readonly Uint8Array[], maxColors = MAX_COLORS): Uint8Array {
  const shift = 8 - HIST_BITS;
  let n = 0;
  for (const frame of frames) {
    for (let p = 0; p < frame.length; p += 4) {
      if (frame[p + 3] < 128) continue;
      const r = frame[p];
      const g = frame[p + 1];
      const b = frame[p + 2];
      const key = ((r >> shift) << (HIST_BITS * 2)) | ((g >> shift) << HIST_BITS) | (b >> shift);
      if (histCount[key] === 0) histKeys[n++] = key;
      histCount[key]++;
      histSums[key * 3] += r;
      histSums[key * 3 + 1] += g;
      histSums[key * 3 + 2] += b;
    }
  }

  const lab = new Float64Array(n * 3);
  // Square-root weights stop the (flat, huge) background and body colours from
  // starving small but visible gradients such as specular highlights.
  const weight = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const key = histKeys[i];
    const c = histCount[key];
    toOklab(histSums[key * 3] / c, histSums[key * 3 + 1] / c, histSums[key * 3 + 2] / c, lab, i * 3);
    weight[i] = Math.sqrt(c);
    histCount[key] = 0;
    histSums[key * 3] = histSums[key * 3 + 1] = histSums[key * 3 + 2] = 0;
  }

  const centroids = medianCut(lab, weight, n, maxColors);
  refineKMeans(lab, weight, n, centroids);

  const k = centroids.length / 3;
  const rgb = new Uint8Array(k * 3);
  for (let p = 0; p < k; p++) fromOklab(centroids[p * 3], centroids[p * 3 + 1], centroids[p * 3 + 2], rgb, p * 3);
  return rgb;
}

interface Box {
  start: number;
  end: number;
  sse: number;
  axis: number;
  split: number;
}

// Repeatedly splits the box with the largest weighted squared error at its
// mean along its widest axis.
function medianCut(lab: Float64Array, weight: Float64Array, n: number, maxColors: number): Float64Array {
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;

  const measure = (start: number, end: number): Box => {
    let w = 0;
    const sum = [0, 0, 0];
    const sq = [0, 0, 0];
    for (let o = start; o < end; o++) {
      const i = order[o];
      const wi = weight[i];
      w += wi;
      for (let c = 0; c < 3; c++) {
        const v = lab[i * 3 + c];
        sum[c] += wi * v;
        sq[c] += wi * v * v;
      }
    }
    let sse = 0;
    let axis = 0;
    let axisErr = -1;
    for (let c = 0; c < 3; c++) {
      const err = Math.max(0, sq[c] - (sum[c] * sum[c]) / w);
      sse += err;
      if (err > axisErr) {
        axisErr = err;
        axis = c;
      }
    }
    return { start, end, sse, axis, split: sum[axis] / w };
  };

  const boxes = [measure(0, n)];
  while (boxes.length < maxColors) {
    let pick = -1;
    for (let b = 0; b < boxes.length; b++) {
      if (boxes[b].end - boxes[b].start > 1 && boxes[b].sse > 1e-12 && (pick < 0 || boxes[b].sse > boxes[pick].sse)) pick = b;
    }
    if (pick < 0) break;
    const { start, end, axis, split } = boxes[pick];
    let mid = start;
    for (let o = start; o < end; o++) {
      const i = order[o];
      if (lab[i * 3 + axis] < split) {
        order[o] = order[mid];
        order[mid++] = i;
      }
    }
    if (mid === start || mid === end) {
      boxes[pick].sse = 0; // float noise on a degenerate axis; never split it
      continue;
    }
    boxes.splice(pick, 1, measure(start, mid), measure(mid, end));
  }

  const centroids = new Float64Array(boxes.length * 3);
  boxes.forEach((box, b) => {
    let w = 0;
    for (let o = box.start; o < box.end; o++) {
      const i = order[o];
      w += weight[i];
      for (let c = 0; c < 3; c++) centroids[b * 3 + c] += weight[i] * lab[i * 3 + c];
    }
    for (let c = 0; c < 3; c++) centroids[b * 3 + c] /= w;
  });
  return centroids;
}

function refineKMeans(lab: Float64Array, weight: Float64Array, n: number, centroids: Float64Array) {
  const k = centroids.length / 3;
  const acc = new Float64Array(k * 4);
  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration++) {
    acc.fill(0);
    for (let i = 0; i < n; i++) {
      const p = nearest(lab, i * 3, centroids, k);
      const w = weight[i];
      acc[p * 4] += w;
      acc[p * 4 + 1] += w * lab[i * 3];
      acc[p * 4 + 2] += w * lab[i * 3 + 1];
      acc[p * 4 + 3] += w * lab[i * 3 + 2];
    }
    // Empty clusters keep their previous position.
    for (let p = 0; p < k; p++) {
      const w = acc[p * 4];
      if (w === 0) continue;
      centroids[p * 3] = acc[p * 4 + 1] / w;
      centroids[p * 3 + 1] = acc[p * 4 + 2] / w;
      centroids[p * 3 + 2] = acc[p * 4 + 3] / w;
    }
  }
}

interface Mapped {
  /** Palette index per pixel, TRANSPARENT when empty. */
  readonly indices: Uint8Array;
  /** 0xRRGGBB per pixel as displayed, EMPTY when transparent. */
  readonly colors: Int32Array;
  /** Oklab distance from each pixel to its palette entry. */
  readonly errors: Float32Array;
}

/** Maps RGBA frames to palette indices, nearest in Oklab. */
class Mapper {
  // 7-bit-per-channel caches: at most half a level of error before the search,
  // far below anything a 255-colour palette can resolve.
  private readonly cachedIndex = new Int16Array(1 << 21);
  private readonly cachedError = new Float32Array(1 << 21);
  private readonly lab = new Float64Array(3);
  private paletteLab = new Float64Array(0);
  private packed = new Int32Array(0);

  setPalette(palette: Uint8Array) {
    const k = palette.length / 3;
    this.paletteLab = new Float64Array(k * 3);
    this.packed = new Int32Array(k);
    for (let p = 0; p < k; p++) {
      toOklab(palette[p * 3], palette[p * 3 + 1], palette[p * 3 + 2], this.paletteLab, p * 3);
      this.packed[p] = (palette[p * 3] << 16) | (palette[p * 3 + 1] << 8) | palette[p * 3 + 2];
    }
    this.cachedIndex.fill(-1);
  }

  map(frame: Uint8Array): Mapped {
    const pixels = frame.length / 4;
    const indices = new Uint8Array(pixels);
    const colors = new Int32Array(pixels);
    const errors = new Float32Array(pixels);
    const k = this.packed.length;
    for (let p = 0, i = 0; p < frame.length; p += 4, i++) {
      if (frame[p + 3] < 128) {
        indices[i] = TRANSPARENT;
        colors[i] = EMPTY;
        continue;
      }
      const r = frame[p] >> 1;
      const g = frame[p + 1] >> 1;
      const b = frame[p + 2] >> 1;
      const key = (r << 14) | (g << 7) | b;
      let index = this.cachedIndex[key];
      if (index < 0) {
        toOklab(r * 2 + 0.5, g * 2 + 0.5, b * 2 + 0.5, this.lab, 0);
        index = this.cachedIndex[key] = nearest(this.lab, 0, this.paletteLab, k);
        this.cachedError[key] = Math.sqrt(nearestDist);
      }
      indices[i] = index;
      colors[i] = this.packed[index];
      errors[i] = this.cachedError[key];
    }
    return { indices, colors, errors };
  }
}

/**
 * Local palette for a frame the shared one fits badly: entries the frame
 * never uses are refitted to its poorly matched pixels, while every used entry
 * keeps its exact colour. Null when the shared palette is good enough.
 */
function refitPalette(shared: Uint8Array, frame: Uint8Array, mapped: Mapped): Uint8Array | null {
  const used = new Uint8Array(MAX_COLORS);
  let opaque = 0;
  let poor = 0;
  for (let i = 0; i < mapped.indices.length; i++) {
    if (mapped.indices[i] === TRANSPARENT) continue;
    opaque++;
    used[mapped.indices[i]] = 1;
    if (mapped.errors[i] > POOR_FIT) poor++;
  }
  const spare: number[] = [];
  for (let p = 0; p < MAX_COLORS; p++) if (!used[p]) spare.push(p);
  if (poor < Math.max(POOR_FIT_MIN_PIXELS, opaque * POOR_FIT_SHARE) || spare.length < MIN_SPARE_ENTRIES) return null;

  const poorPixels = new Uint8Array(frame.length);
  for (let i = 0; i < mapped.indices.length; i++) {
    if (mapped.indices[i] === TRANSPARENT || mapped.errors[i] <= POOR_FIT) continue;
    poorPixels.set(frame.subarray(i * 4, i * 4 + 3), i * 4);
    poorPixels[i * 4 + 3] = 255;
  }
  const fresh = buildPalette([poorPixels], spare.length);
  const local = shared.slice();
  for (let j = 0; j < fresh.length / 3; j++) local.set(fresh.subarray(j * 3, j * 3 + 3), spare[j] * 3);
  return local;
}

// (prefix << 8 | byte) -> code, 0 = absent. Shared between calls; every
// entry set is recorded in `used` and cleared again.
const dict = new Int16Array(4096 << 8);
const used: number[] = [];

// GIF LZW (variable 9..12-bit codes, LSB first) for 8-bit indices.
function lzw(indices: Uint8Array): Uint8Array {
  const minCodeSize = 8;
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = new Uint8Array(indices.length * 2 + 16);
  let length = 0;
  let bitBuffer = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let next = endCode + 1;

  const write = (code: number) => {
    bitBuffer |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out[length++] = bitBuffer & 0xff;
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };
  // Decoders add their table entry one code later than we do, so the code
  // width grows only after the first code written past the boundary.
  const emit = (code: number) => {
    write(code);
    if (next > (1 << codeSize) - 1 && codeSize < 12) codeSize++;
  };

  write(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const byte = indices[i];
    const key = (prefix << 8) | byte;
    const code = dict[key];
    if (code) {
      prefix = code;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict[key] = next++;
      used.push(key);
    } else {
      write(clearCode);
      for (const entry of used) dict[entry] = 0;
      used.length = 0;
      codeSize = minCodeSize + 1;
      next = endCode + 1;
    }
    prefix = byte;
  }
  emit(prefix);
  write(endCode);
  if (bitCount > 0) out[length++] = bitBuffer & 0xff;
  for (const entry of used) dict[entry] = 0;
  used.length = 0;
  return out.subarray(0, length);
}

class ByteWriter {
  private chunks: Uint8Array[] = [];
  private bytes: number[] = [];

  u8(...values: number[]) {
    this.bytes.push(...values);
  }

  u16(value: number) {
    this.bytes.push(value & 0xff, value >> 8);
  }

  block(data: Uint8Array) {
    this.flush();
    this.chunks.push(data);
  }

  private flush() {
    if (this.bytes.length) this.chunks.push(Uint8Array.from(this.bytes));
    this.bytes = [];
  }

  concat(): Uint8Array {
    this.flush();
    const out = new Uint8Array(this.chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Bounding rect of pixels whose colour differs between `from` and `to`, or
 * with `clearing`, of pixels that go from visible to empty.
 */
function changedRect(from: Int32Array, to: Int32Array, width: number, height: number, clearing: boolean): Rect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0, i = 0; y < height; y++) {
    for (let x = 0; x < width; x++, i++) {
      if (clearing ? from[i] === EMPTY || to[i] !== EMPTY : from[i] === to[i]) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

function union(a: Rect | null, b: Rect | null): Rect | null {
  if (!a || !b) return a ?? b;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/**
 * Writes one frame covering `rect` of the full-canvas `frame`, drawn over
 * `base` (the canvas colours before it), optionally with its own palette.
 * `dispose` restores the rect to empty after the frame's delay.
 */
function writeFrame(
  writer: ByteWriter,
  width: number,
  delayCs: number,
  frame: Mapped,
  base: Int32Array,
  rect: Rect | null,
  dispose: boolean,
  palette: Uint8Array | null,
) {
  // Graphic control: disposal 1 (keep) or 2 (restore to background), with
  // index 255 transparent.
  writer.u8(0x21, 0xf9, 4, ((dispose ? 2 : 1) << 2) | 1);
  writer.u16(delayCs);
  writer.u8(TRANSPARENT, 0);
  const { x, y, w, h } = rect ?? { x: 0, y: 0, w: 1, h: 1 };
  // Inside the rect, a frame is only ever empty where its base already is, so
  // drawing it as-is is exact; holes additionally skip unchanged pixels.
  const solid = new Uint8Array(w * h);
  const holes = new Uint8Array(w * h);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const i = (y + row) * width + x + col;
      solid[row * w + col] = rect ? frame.indices[i] : TRANSPARENT;
      holes[row * w + col] = !rect || frame.colors[i] === base[i] ? TRANSPARENT : frame.indices[i];
    }
  }
  // Holes usually shrink the LZW stream, but can fragment noisy regions; keep
  // whichever is smaller.
  const withHoles = lzw(holes);
  const withoutHoles = lzw(solid);
  const data = withHoles.length < withoutHoles.length ? withHoles : withoutHoles;
  writer.u8(0x2c);
  writer.u16(x);
  writer.u16(y);
  writer.u16(w);
  writer.u16(h);
  if (palette) {
    writer.u8(0x87); // 256-entry local palette
    writer.block(colorTable(palette));
  } else {
    writer.u8(0);
  }
  writer.u8(8); // LZW minimum code size
  for (let offset = 0; offset < data.length; offset += 255) {
    const size = Math.min(255, data.length - offset);
    writer.u8(size);
    writer.block(data.subarray(offset, offset + size));
  }
  writer.u8(0);
}

function colorTable(palette: Uint8Array): Uint8Array {
  const table = new Uint8Array(768);
  table.set(palette);
  return table;
}

/**
 * Encodes frames one at a time against a shared palette fitted up front.
 * Each frame is written once the next is known, since that decides whether it
 * must clear pixels behind itself.
 */
export class GifEncoder {
  private readonly writer = new ByteWriter();
  private readonly shared: Uint8Array;
  private readonly sharedMapper = new Mapper();
  private readonly localMapper = new Mapper();
  /** Canvas colours before the pending frame is drawn. */
  private base: Int32Array;
  private pending: { frame: Mapped; palette: Uint8Array | null; rect: Rect | null } | null = null;
  private readonly width: number;
  private readonly height: number;
  private readonly delayCs: number;

  constructor(width: number, height: number, delayCs: number, palette: Uint8Array) {
    this.width = width;
    this.height = height;
    this.delayCs = delayCs;
    // Pad to all 255 entries with repeats of the last colour: repeats are never
    // chosen (the first match wins), so they are spare slots for refitting.
    this.shared = new Uint8Array(MAX_COLORS * 3);
    this.shared.set(palette);
    for (let p = palette.length / 3; p < MAX_COLORS; p++) this.shared.copyWithin(p * 3, palette.length - 3, palette.length);
    this.sharedMapper.setPalette(this.shared);
    this.base = new Int32Array(width * height).fill(EMPTY);

    const writer = this.writer;
    writer.u8(...Array.from('GIF89a', (c) => c.charCodeAt(0)));
    writer.u16(width);
    writer.u16(height);
    writer.u8(0xf7, TRANSPARENT, 0); // 256-entry global palette, 8-bit colour resolution
    writer.block(colorTable(this.shared));
    // NETSCAPE2.0: loop forever.
    writer.u8(0x21, 0xff, 11, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  }

  /** RGBA, 4 bytes per pixel, row-major from the top left; alpha is 1-bit (>= 128 opaque). */
  addFrame(rgba: Uint8Array) {
    let frame = this.sharedMapper.map(rgba);
    const local = refitPalette(this.shared, rgba, frame);
    if (local) {
      this.localMapper.setPalette(local);
      frame = this.localMapper.map(rgba);
    }
    this.push(frame, local);
  }

  finish(): Uint8Array {
    if (!this.pending) throw new Error('[warpaint-viewer] GIF needs at least one frame');
    // An empty frame flushes the last real one, which therefore leaves an empty
    // canvas for the loop restart.
    const pixels = this.width * this.height;
    this.push({
      indices: new Uint8Array(pixels).fill(TRANSPARENT),
      colors: new Int32Array(pixels).fill(EMPTY),
      errors: new Float32Array(0),
    }, null);
    this.writer.u8(0x3b);
    return this.writer.concat();
  }

  private push(next: Mapped, palette: Uint8Array | null) {
    const { width, height } = this;
    const previous = this.pending;
    if (previous) {
      const shown = previous.frame.colors;
      const clear = changedRect(shown, next.colors, width, height, true);
      const rect = union(previous.rect, clear);
      writeFrame(this.writer, width, this.delayCs, previous.frame, this.base, rect, !!clear, previous.palette);
      this.base = shown;
      if (clear && rect) {
        this.base = shown.slice();
        for (let row = rect.y; row < rect.y + rect.h; row++) this.base.fill(EMPTY, row * width + rect.x, row * width + rect.x + rect.w);
      }
    }
    this.pending = { frame: next, palette, rect: changedRect(this.base, next.colors, width, height, false) };
  }
}

/** Encodes a whole animation, fitting the shared palette to every frame. */
export function encodeGif({ width, height, frames, delayCs }: GifAnimation): Uint8Array {
  const encoder = new GifEncoder(width, height, delayCs, buildPalette(frames));
  for (const frame of frames) encoder.addFrame(frame);
  return encoder.finish();
}
