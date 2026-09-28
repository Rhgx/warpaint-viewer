// Animated exports besides GIF, all fed the same streamed RGBA frames:
// APNG (lossless, full alpha), animated WebP (lossy colour, full alpha, small)
// and MP4 (H.264, no alpha, smallest; what chat apps embed). Each leans on a
// platform encoder (CompressionStream, the canvas WebP encoder, WebCodecs) and
// writes the APNG and WebP containers here; MP4 goes through Mediabunny.
import {
  BufferTarget,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  Quality,
  VideoSample,
  VideoSampleSource,
} from 'mediabunny';
import { pngChunk, zlibCompress } from '../source/png';
import type { TurntableQuality } from '../viewer/controls';

/** Frame encoder contract shared with GifEncoder. */
export interface AnimationEncoder {
  addFrame(rgba: Uint8Array): void | Promise<void>;
  finish(): Uint8Array | Promise<Uint8Array>;
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

/**
 * Frames a platform encoder may work on at once. Both CompressionStream and
 * the canvas WebP encoder run off the calling thread, so overlapping frames
 * uses more cores; results are still kept in frame order.
 */
const FRAMES_IN_FLIGHT = 4;

/** Ordered results of asynchronous per-frame work with at most FRAMES_IN_FLIGHT running. */
class FramePipeline<T> {
  private readonly results: Promise<T>[] = [];
  private settled = 0;

  async add(work: Promise<T>) {
    // Rejections surface when awaited below, not as unhandled rejections.
    work.catch(() => {});
    this.results.push(work);
    while (this.results.length - this.settled > FRAMES_IN_FLIGHT) await this.results[this.settled++];
  }

  get size() {
    return this.results.length;
  }

  all(): Promise<T[]> {
    return Promise.all(this.results);
  }
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------- APNG

/** Paeth-filtered scanlines, which deflate far better than raw rows. */
function paethScanlines(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const to = y * (stride + 1);
    out[to] = 4;
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[row + i - 4] : 0;
      const b = y > 0 ? rgba[row - stride + i] : 0;
      const c = i >= 4 && y > 0 ? rgba[row - stride + i - 4] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      out[to + 1 + i] = (rgba[row + i] - predicted) & 0xff;
    }
  }
  return out;
}

export class ApngEncoder implements AnimationEncoder {
  private readonly frames = new FramePipeline<Uint8Array>();
  private readonly width: number;
  private readonly height: number;
  private readonly fps: number;

  constructor(width: number, height: number, fps: number) {
    this.width = width;
    this.height = height;
    this.fps = fps;
  }

  addFrame(rgba: Uint8Array) {
    return this.frames.add(zlibCompress(paethScanlines(rgba, this.width, this.height)));
  }

  async finish(): Promise<Uint8Array> {
    const { width, height, fps } = this;
    const frames = await this.frames.all();
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
    const actl = new Uint8Array(8);
    new DataView(actl.buffer).setUint32(0, frames.length); // plays: 0 = forever
    const chunks = [pngChunk('IHDR', header), pngChunk('acTL', actl)];
    let sequence = 0;
    frames.forEach((data, index) => {
      const fctl = new Uint8Array(26);
      const control = new DataView(fctl.buffer);
      control.setUint32(0, sequence++);
      control.setUint32(4, width);
      control.setUint32(8, height);
      // Delay as a fraction of seconds: 1000 / (fps * 1000) keeps 60 fps exact.
      control.setUint16(20, 1000);
      control.setUint16(22, Math.round(fps * 1000));
      // dispose NONE, blend SOURCE: every frame replaces the whole canvas.
      chunks.push(pngChunk('fcTL', fctl));
      if (index === 0) {
        chunks.push(pngChunk('IDAT', data));
      } else {
        const fdat = new Uint8Array(data.length + 4);
        new DataView(fdat.buffer).setUint32(0, sequence++);
        fdat.set(data, 4);
        chunks.push(pngChunk('fdAT', fdat));
      }
    });
    chunks.push(pngChunk('IEND', new Uint8Array()));
    return concat([Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), ...chunks]);
  }
}

// ---------------------------------------------------------------- WebP

/** Canvas WebP encoder quality per level; alpha is always kept losslessly. */
const WEBP_QUALITY: Record<TurntableQuality, number> = { standard: 0.8, high: 0.92, maximum: 0.98 };

const le24 = (value: number) => Uint8Array.of(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff);

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(8);
  header.set(ascii(fourcc));
  new DataView(header.buffer).setUint32(4, data.length, true);
  return concat([header, data, new Uint8Array(data.length & 1)]);
}

/** Can this context's canvas encode WebP? (Safari cannot.) */
export async function canEncodeWebp(): Promise<boolean> {
  if (typeof OffscreenCanvas === 'undefined') return false;
  const canvas = new OffscreenCanvas(1, 1);
  canvas.getContext('2d'); // convertToBlob refuses a canvas without a context
  const blob = await canvas.convertToBlob({ type: 'image/webp' });
  return blob.type === 'image/webp';
}

export class WebpEncoder implements AnimationEncoder {
  private readonly frames = new FramePipeline<Uint8Array>();
  private readonly canvas: OffscreenCanvas;
  private readonly context: OffscreenCanvasRenderingContext2D;
  private hasAlpha = false;
  private readonly width: number;
  private readonly height: number;
  private readonly fps: number;
  private readonly quality: number;

  constructor(width: number, height: number, fps: number, quality: TurntableQuality) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.quality = WEBP_QUALITY[quality];
    this.canvas = new OffscreenCanvas(width, height);
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('WebP export needs a 2D canvas');
    this.context = context;
  }

  /**
   * Encodes a still WebP and keeps its image chunks (ALPH plus VP8, or VP8L)
   * as an ANMF frame. convertToBlob snapshots the canvas when called, so the
   * next frame can be drawn while this one encodes.
   */
  addFrame(rgba: Uint8Array) {
    const pixels = new Uint8ClampedArray(rgba.buffer as ArrayBuffer, rgba.byteOffset, rgba.length);
    this.context.putImageData(new ImageData(pixels, this.width, this.height), 0, 0);
    const index = this.frames.size;
    return this.frames.add(this.canvas.convertToBlob({ type: 'image/webp', quality: this.quality }).then((blob) => this.toFrame(blob, index)));
  }

  private async toFrame(blob: Blob, index: number): Promise<Uint8Array> {
    if (blob.type !== 'image/webp') throw new Error('This browser cannot encode WebP');
    const still = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(still.buffer);
    const image: Uint8Array[] = [];
    for (let offset = 12; offset + 8 <= still.length;) {
      const fourcc = String.fromCharCode(...still.subarray(offset, offset + 4));
      const size = view.getUint32(offset + 4, true);
      const end = offset + 8 + size + (size & 1);
      if (fourcc === 'ALPH' || fourcc === 'VP8 ' || fourcc === 'VP8L') image.push(still.subarray(offset, end));
      if (fourcc === 'ALPH' || fourcc === 'VP8L') this.hasAlpha = true;
      offset = end;
    }
    if (!image.length) throw new Error('The WebP encoder returned no image data');
    // Whole-millisecond durations that sum exactly: 30 fps alternates 33/34 ms.
    const duration = Math.round(((index + 1) * 1000) / this.fps) - Math.round((index * 1000) / this.fps);
    const header = concat([le24(0), le24(0), le24(this.width - 1), le24(this.height - 1), le24(duration), Uint8Array.of(0b10)]);
    return riffChunk('ANMF', concat([header, ...image]));
  }

  async finish(): Promise<Uint8Array> {
    const frames = await this.frames.all();
    // VP8X: animation (and alpha) flags plus canvas size; ANIM: transparent
    // background, loop forever.
    const vp8x = concat([Uint8Array.of(0x02 | (this.hasAlpha ? 0x10 : 0), 0, 0, 0), le24(this.width - 1), le24(this.height - 1)]);
    const body = concat([ascii('WEBP'), riffChunk('VP8X', vp8x), riffChunk('ANIM', new Uint8Array(6)), ...frames]);
    const header = new Uint8Array(8);
    header.set(ascii('RIFF'));
    new DataView(header.buffer).setUint32(4, body.length, true);
    return concat([header, body]);
  }
}

// ---------------------------------------------------------------- MP4

// Mediabunny drives WebCodecs (codec strings, per-browser encoder quirks) and
// writes the MP4, index first so playback can start before the file loads.
// Frames go in as BT.709 limited-range I420 converted here, the tagging every
// player and hardware decoder expects; handing the encoder RGBA instead yields
// full-range, sRGB-tagged video that stricter players mishandle or refuse.
// Measured on Windows: the hardware encoder also mangles range (darks crushed,
// colours oversaturated), so encoding prefers software.
/** Mediabunny quality level per setting; it scales bitrate with size and frame rate. */
const MP4_QUALITY: Record<TurntableQuality, Quality> = {
  standard: new Quality('medium'),
  high: new Quality('high'),
  maximum: new Quality('very-high'),
};

const MP4_ENCODING = {
  codec: 'avc',
  keyFrameInterval: 2,
  hardwareAcceleration: 'prefer-software',
  // Firefox on Windows (Microsoft H.264 Encoder) reports a decoder record
  // whose SPS and PPS repeat their first byte, so players reject the file.
  // Annex B output carries the parameter sets in-band instead; Mediabunny then
  // builds the record from the first key frame and repackages the samples.
  onEncoderConfig: (config: VideoEncoderConfig) => {
    config.avc = { format: 'annexb' };
  },
} as const;

const BT709_LIMITED: VideoColorSpaceInit = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };

/**
 * Opaque RGBA to BT.709 limited-range I420 (luma 16-235, chroma 16-240), with
 * chroma averaged over each 2x2 block. Odd dimensions round up to the even
 * size H.264 needs by repeating the last row and column.
 */
export function rgbaToI420(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const w = width + (width & 1);
  const h = height + (height & 1);
  const out = new Uint8Array(w * h * 1.5);
  const lumaScale = 219 / 255;
  for (let y = 0; y < h; y++) {
    const row = Math.min(y, height - 1) * width;
    for (let x = 0; x < w; x++) {
      const p = (row + Math.min(x, width - 1)) * 4;
      out[y * w + x] = Math.round(16 + (0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]) * lumaScale);
    }
  }
  const cb = w * h;
  const cr = cb + cb / 4;
  const chromaScale = 224 / 255 / 4;
  for (let y = 0; y < h; y += 2) {
    const top = y * width;
    const bottom = Math.min(y + 1, height - 1) * width;
    for (let x = 0; x < w; x += 2) {
      const right = Math.min(x + 1, width - 1);
      const p0 = (top + x) * 4;
      const p1 = (top + right) * 4;
      const p2 = (bottom + x) * 4;
      const p3 = (bottom + right) * 4;
      const r = rgba[p0] + rgba[p1] + rgba[p2] + rgba[p3];
      const g = rgba[p0 + 1] + rgba[p1 + 1] + rgba[p2 + 1] + rgba[p3 + 1];
      const b = rgba[p0 + 2] + rgba[p1 + 2] + rgba[p2 + 2] + rgba[p3 + 2];
      const i = (y >> 1) * (w >> 1) + (x >> 1);
      out[cb + i] = Math.round(128 + (-0.1146 * r - 0.3854 * g + 0.5 * b) * chromaScale);
      out[cr + i] = Math.round(128 + (0.5 * r - 0.4542 * g - 0.0458 * b) * chromaScale);
    }
  }
  return out;
}

/** Can this context encode H.264? */
export async function canEncodeMp4(): Promise<boolean> {
  return canEncodeVideo('avc', { width: 640, height: 480, quality: MP4_QUALITY.high, ...MP4_ENCODING });
}

export class Mp4Encoder implements AnimationEncoder {
  private readonly output: Output<Mp4OutputFormat, BufferTarget>;
  private readonly source: VideoSampleSource;
  private readonly width: number;
  private readonly height: number;
  private readonly frameSeconds: number;
  private frameIndex = 0;

  /** H.264 needs even dimensions; rgbaToI420 extends odd edges. */
  static async create(width: number, height: number, fps: number, quality: TurntableQuality): Promise<Mp4Encoder> {
    const encoding = { ...MP4_ENCODING, quality: MP4_QUALITY[quality] };
    const supported = await canEncodeVideo('avc', { width: width + (width & 1), height: height + (height & 1), frameRate: fps, ...encoding });
    if (!supported) throw new Error('This browser cannot encode MP4 (H.264) video');
    const encoder = new Mp4Encoder(width, height, fps, encoding);
    encoder.output.addVideoTrack(encoder.source, { frameRate: fps });
    await encoder.output.start();
    return encoder;
  }

  private constructor(
    width: number,
    height: number,
    fps: number,
    encoding: ConstructorParameters<typeof VideoSampleSource>[0],
  ) {
    this.width = width;
    this.height = height;
    this.frameSeconds = 1 / fps;
    this.output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    this.source = new VideoSampleSource(encoding);
  }

  async addFrame(rgba: Uint8Array) {
    const { width, height } = this;
    const sample = new VideoSample(rgbaToI420(rgba, width, height), {
      format: 'I420',
      codedWidth: width + (width & 1),
      codedHeight: height + (height & 1),
      colorSpace: BT709_LIMITED,
      timestamp: this.frameIndex++ * this.frameSeconds,
      duration: this.frameSeconds,
    });
    try {
      await this.source.add(sample);
    } finally {
      sample.close();
    }
  }

  async finish(): Promise<Uint8Array> {
    await this.output.finalize();
    const buffer = this.output.target.buffer;
    if (!buffer) throw new Error('The MP4 writer produced no file');
    return new Uint8Array(buffer);
  }
}
