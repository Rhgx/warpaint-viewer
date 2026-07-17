// Minimal VTF decoder: parses the header (incl. 7.3+ resource directory), locates the largest
// mip of the high-res image, and decodes it to RGBA. Supports the formats TF2 warpaint content
// uses: DXT1, DXT5, DXT3, BGRA8888, BGR888, RGBA8888, ABGR8888, ARGB8888, BGRX8888, I8, IA88,
// A8, RGB565, BGR565. Errors loudly on anything else.

// VTF IMAGE_FORMAT enum values.
export const VTF_FORMAT = {
  RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, RGB565: 4, I8: 5, IA88: 6, P8: 7, A8: 8,
  RGB888_BLUESCREEN: 9, BGR888_BLUESCREEN: 10, ARGB8888: 11, BGRA8888: 12, DXT1: 13, DXT3: 14,
  DXT5: 15, BGRX8888: 16, BGR565: 17, BGRX5551: 18, BGRA4444: 19, DXT1_ONEBITALPHA: 20,
  BGRA5551: 21, UV88: 22, UVWQ8888: 23, RGBA16161616F: 24, RGBA16161616: 25, UVLX8888: 26,
};

const FLAG_ENVMAP = 0x4000;

function formatBlockSize(fmt) {
  switch (fmt) {
    case VTF_FORMAT.DXT1:
    case VTF_FORMAT.DXT1_ONEBITALPHA:
      return { block: true, bytes: 8 };
    case VTF_FORMAT.DXT3:
    case VTF_FORMAT.DXT5:
      return { block: true, bytes: 16 };
    case VTF_FORMAT.RGBA8888:
    case VTF_FORMAT.ABGR8888:
    case VTF_FORMAT.ARGB8888:
    case VTF_FORMAT.BGRA8888:
    case VTF_FORMAT.BGRX8888:
      return { block: false, bpp: 4 };
    case VTF_FORMAT.RGB888:
    case VTF_FORMAT.BGR888:
      return { block: false, bpp: 3 };
    case VTF_FORMAT.RGB565:
    case VTF_FORMAT.BGR565:
    case VTF_FORMAT.IA88:
      return { block: false, bpp: 2 };
    case VTF_FORMAT.I8:
    case VTF_FORMAT.A8:
      return { block: false, bpp: 1 };
    default:
      return null;
  }
}

function mipByteSize(fmt, w, h) {
  const info = formatBlockSize(fmt);
  if (!info) throw new Error(`Unsupported VTF format ${fmt}`);
  if (info.block) {
    const bw = Math.max(1, Math.ceil(w / 4));
    const bh = Math.max(1, Math.ceil(h / 4));
    return bw * bh * info.bytes;
  }
  return w * h * info.bpp;
}

export function parseVTFHeader(buf) {
  if (buf.toString('ascii', 0, 4) !== 'VTF\0') throw new Error('Not a VTF file');
  const verMajor = buf.readUInt32LE(4);
  const verMinor = buf.readUInt32LE(8);
  const headerSize = buf.readUInt32LE(12);
  const width = buf.readUInt16LE(16);
  const height = buf.readUInt16LE(18);
  const flags = buf.readUInt32LE(20);
  const frames = buf.readUInt16LE(24);
  const firstFrame = buf.readUInt16LE(26);
  const highResFormat = buf.readUInt32LE(52);
  const mipCount = buf.readUInt8(56);
  let depth = 1;
  if (verMajor > 7 || (verMajor === 7 && verMinor >= 2)) {
    depth = buf.readUInt16LE(63) || 1;
  }

  let imageDataOffset = headerSize;
  // 7.3+ has a resource directory; find the high-res image data resource (tag 0x30,0,0).
  if (verMajor > 7 || (verMajor === 7 && verMinor >= 3)) {
    const numResources = buf.readUInt32LE(68);
    let ro = 80; // resource entries start at offset 80
    for (let r = 0; r < numResources; r++) {
      const tag0 = buf[ro];
      const tag1 = buf[ro + 1];
      const tag2 = buf[ro + 2];
      const resOffset = buf.readUInt32LE(ro + 4);
      if (tag0 === 0x30 && tag1 === 0x00 && tag2 === 0x00) imageDataOffset = resOffset;
      ro += 8;
    }
  }

  // Pre-7.5 environment maps with a non-0xffff first frame contain a seventh
  // legacy spheremap face after the six cubemap faces. It participates in the
  // byte layout even though modern renderers never sample it.
  const legacySphereFace = (flags & FLAG_ENVMAP) && (verMajor < 7 || (verMajor === 7 && verMinor < 5)) && firstFrame !== 0xffff;
  const faces = flags & FLAG_ENVMAP ? (legacySphereFace ? 7 : 6) : 1;
  return { verMajor, verMinor, headerSize, width, height, flags, frames, firstFrame, highResFormat, mipCount, depth, faces, imageDataOffset };
}

// Locate the offset of the largest mip (mip 0, frame 0, face 0, slice 0).
function largestMipOffset(hdr) {
  const { highResFormat: fmt, width, height, mipCount, frames, faces, depth, imageDataOffset } = hdr;
  // Mips are stored smallest -> largest. Sum sizes of all mips finer index > 0 (i.e. levels 1..n-1).
  let offset = imageDataOffset;
  for (let level = mipCount - 1; level >= 1; level--) {
    const w = Math.max(1, width >> level);
    const h = Math.max(1, height >> level);
    const d = Math.max(1, depth >> level);
    offset += mipByteSize(fmt, w, h) * frames * faces * d;
  }
  return offset;
}

function decodeLargestMipAt(buf, hdr, off) {
  const { highResFormat: fmt, width, height } = hdr;
  const size = mipByteSize(fmt, width, height);
  if (off + size > buf.length) throw new Error(`VTF mip data out of range (off=${off} size=${size} len=${buf.length}, fmt=${fmt})`);
  const src = buf.subarray(off, off + size);
  const rgba = Buffer.alloc(width * height * 4);
  const info = formatBlockSize(fmt);
  if (!info) throw new Error(`Unsupported VTF format ${fmt}`);
  if (info.block) decodeDXT(fmt, src, width, height, rgba);
  else decodeUncompressed(fmt, src, width, height, rgba);
  return { width, height, rgba, format: fmt };
}

// ---- pixel decoders -> write RGBA into out ----

function decodeUncompressed(fmt, src, w, h, out) {
  const info = formatBlockSize(fmt);
  const bpp = info.bpp;
  for (let p = 0; p < w * h; p++) {
    const si = p * bpp;
    const di = p * 4;
    let r = 0, g = 0, b = 0, a = 255;
    switch (fmt) {
      case VTF_FORMAT.RGBA8888: r = src[si]; g = src[si + 1]; b = src[si + 2]; a = src[si + 3]; break;
      case VTF_FORMAT.ABGR8888: a = src[si]; b = src[si + 1]; g = src[si + 2]; r = src[si + 3]; break;
      case VTF_FORMAT.ARGB8888: a = src[si]; r = src[si + 1]; g = src[si + 2]; b = src[si + 3]; break;
      case VTF_FORMAT.BGRA8888: b = src[si]; g = src[si + 1]; r = src[si + 2]; a = src[si + 3]; break;
      case VTF_FORMAT.BGRX8888: b = src[si]; g = src[si + 1]; r = src[si + 2]; a = 255; break;
      case VTF_FORMAT.RGB888: r = src[si]; g = src[si + 1]; b = src[si + 2]; break;
      case VTF_FORMAT.BGR888: b = src[si]; g = src[si + 1]; r = src[si + 2]; break;
      case VTF_FORMAT.I8: r = g = b = src[si]; a = 255; break;
      case VTF_FORMAT.A8: r = g = b = 255; a = src[si]; break;
      case VTF_FORMAT.IA88: r = g = b = src[si]; a = src[si + 1]; break;
      case VTF_FORMAT.RGB565: {
        const v = src[si] | (src[si + 1] << 8);
        r = ((v >> 11) & 0x1f) * 255 / 31; g = ((v >> 5) & 0x3f) * 255 / 63; b = (v & 0x1f) * 255 / 31;
        break;
      }
      case VTF_FORMAT.BGR565: {
        const v = src[si] | (src[si + 1] << 8);
        b = ((v >> 11) & 0x1f) * 255 / 31; g = ((v >> 5) & 0x3f) * 255 / 63; r = (v & 0x1f) * 255 / 31;
        break;
      }
      default: throw new Error(`Unsupported uncompressed VTF format ${fmt}`);
    }
    out[di] = r; out[di + 1] = g; out[di + 2] = b; out[di + 3] = a;
  }
}

function decodeDXTColorBlock(src, o, colors, useDxt1Palette, exposeOneBitAlpha) {
  const c0 = src[o] | (src[o + 1] << 8);
  const c1 = src[o + 2] | (src[o + 3] << 8);
  const r0 = ((c0 >> 11) & 0x1f) * 255 / 31, g0 = ((c0 >> 5) & 0x3f) * 255 / 63, b0 = (c0 & 0x1f) * 255 / 31;
  const r1 = ((c1 >> 11) & 0x1f) * 255 / 31, g1 = ((c1 >> 5) & 0x3f) * 255 / 63, b1 = (c1 & 0x1f) * 255 / 31;
  colors[0] = [r0, g0, b0, 255];
  colors[1] = [r1, g1, b1, 255];
  // BC1/DXT1 changes to its three-color palette whenever c0 <= c1, regardless
  // of whether the VTF exposes one-bit alpha. Opaque TF2 wear masks deliberately
  // use that midpoint palette but avoid selector 3. DXT3/5, whose alpha lives in
  // a separate block, always retain the four-color palette.
  if (!useDxt1Palette || c0 > c1) {
    colors[2] = [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255];
    colors[3] = [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255];
  } else {
    colors[2] = [(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255];
    colors[3] = [0, 0, 0, exposeOneBitAlpha ? 0 : 255];
  }
  return c0 <= c1;
}

function decodeDXT(fmt, src, w, h, out) {
  const bw = Math.ceil(w / 4);
  const bh = Math.ceil(h / 4);
  const isDXT1 = fmt === VTF_FORMAT.DXT1 || fmt === VTF_FORMAT.DXT1_ONEBITALPHA;
  const blockBytes = isDXT1 ? 8 : 16;
  const colors = [null, null, null, null];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const blockOff = (by * bw + bx) * blockBytes;
      let colorOff = blockOff;
      let alphaFn = null;
      if (fmt === VTF_FORMAT.DXT5) {
        const a0 = src[blockOff];
        const a1 = src[blockOff + 1];
        const alphaBits = [];
        // 6 bytes of 3-bit indices, little endian.
        let bitPos = 0;
        const abytes = src.subarray(blockOff + 2, blockOff + 8);
        for (let i = 0; i < 16; i++) {
          const bit = i * 3;
          const byteIdx = bit >> 3;
          const shift = bit & 7;
          let val = (abytes[byteIdx] >> shift) & 0x7;
          if (shift > 5) val |= (abytes[byteIdx + 1] << (8 - shift)) & 0x7;
          alphaBits.push(val);
        }
        const alphas = new Array(8);
        alphas[0] = a0; alphas[1] = a1;
        if (a0 > a1) {
          for (let i = 1; i <= 6; i++) alphas[i + 1] = ((7 - i) * a0 + i * a1) / 7;
        } else {
          for (let i = 1; i <= 4; i++) alphas[i + 1] = ((5 - i) * a0 + i * a1) / 5;
          alphas[6] = 0; alphas[7] = 255;
        }
        alphaFn = (idx) => alphas[alphaBits[idx]];
        colorOff = blockOff + 8;
        void bitPos; void alphaBits;
      } else if (fmt === VTF_FORMAT.DXT3) {
        const abytes = src.subarray(blockOff, blockOff + 8);
        alphaFn = (idx) => {
          const nib = (abytes[idx >> 1] >> ((idx & 1) * 4)) & 0xf;
          return nib * 255 / 15;
        };
        colorOff = blockOff + 8;
      }
      decodeDXTColorBlock(
        src,
        colorOff,
        colors,
        isDXT1,
        fmt === VTF_FORMAT.DXT1_ONEBITALPHA,
      );
      const lookup = src[colorOff + 4] | (src[colorOff + 5] << 8) | (src[colorOff + 6] << 16) | (src[colorOff + 7] << 24);
      for (let py = 0; py < 4; py++) {
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px;
          const y = by * 4 + py;
          if (x >= w || y >= h) continue;
          const idx = py * 4 + px;
          const sel = (lookup >>> (idx * 2)) & 0x3;
          const c = colors[sel];
          const di = (y * w + x) * 4;
          out[di] = c[0]; out[di + 1] = c[1]; out[di + 2] = c[2];
          out[di + 3] = alphaFn ? alphaFn(idx) : c[3];
        }
      }
    }
  }
}

// Decode a VTF buffer to { width, height, rgba (Buffer length w*h*4) } using the largest mip.
export function decodeVTF(buf) {
  const hdr = parseVTFHeader(buf);
  const { width, height } = hdr;
  if (width === 0 || height === 0) throw new Error('VTF has zero dimension');
  return decodeLargestMipAt(buf, hdr, largestMipOffset(hdr));
}

// Offset of a specific frame (0-based) within the largest mip (mip 0, face 0, slice 0).
// Frames are stored consecutively within a mip level (mip -> frame -> face -> slice).
function largestMipFrameOffset(hdr, frameIndex) {
  const { highResFormat: fmt, width, height, faces, depth } = hdr;
  const frameSize = mipByteSize(fmt, width, height) * faces * depth;
  return largestMipOffset(hdr) + frameIndex * frameSize;
}

// Decode a single frame (0-based) of the largest mip. decodeVTF always returns frame 0; this is
// for animated textures (e.g. materials/effects/animatedsheen/animatedsheen0.vtf) that need a
// specific frame or every frame.
export function decodeVTFFrame(buf, frameIndex) {
  const hdr = parseVTFHeader(buf);
  const { width, height, frames } = hdr;
  if (width === 0 || height === 0) throw new Error('VTF has zero dimension');
  if (frameIndex < 0 || frameIndex >= frames) throw new Error(`Frame index ${frameIndex} out of range (frames=${frames})`);
  return decodeLargestMipAt(buf, hdr, largestMipFrameOffset(hdr, frameIndex));
}

// Decode every frame of the largest mip, in order (frame 0 first).
export function decodeVTFAllFrames(buf) {
  const hdr = parseVTFHeader(buf);
  const { width, height, frames } = hdr;
  if (width === 0 || height === 0) throw new Error('VTF has zero dimension');
  return Array.from({ length: frames }, (_, i) => decodeLargestMipAt(buf, hdr, largestMipFrameOffset(hdr, i)));
}

// ---------------------------------------------------------------------------
// Sprite sheet resource (VTF 7.3+ resource dictionary, resource tag 0x10 0x00 0x00).
// Describes named sequences of UV cells within the texture; without it a renderer must
// treat the whole (often multi-cell) sheet as a single sprite.
// ---------------------------------------------------------------------------

const RSRC_SHEET = 0x10;

// Locate the sprite-sheet resource's byte offset in a VTF, or null if absent/pre-7.3.
function findSheetResourceOffset(buf) {
  const verMajor = buf.readUInt32LE(4);
  const verMinor = buf.readUInt32LE(8);
  if (!(verMajor > 7 || (verMajor === 7 && verMinor >= 3))) return null;
  const numResources = buf.readUInt32LE(68);
  let ro = 80;
  for (let r = 0; r < numResources; r++) {
    const tag0 = buf[ro], tag1 = buf[ro + 1], tag2 = buf[ro + 2];
    const offset = buf.readUInt32LE(ro + 4);
    if (tag0 === RSRC_SHEET && tag1 === 0x00 && tag2 === 0x00) return offset;
    ro += 8;
  }
  return null;
}

// Parse the sheet blob at `off`. Binary layout: int32 version; int32 sequenceCount; then per
// sequence: int32 sequenceNumber, int32 clamp, int32 frameCount, float32 totalTime; then per
// frame: float32 displayTime, then UV coords (version 0: 1 sample of 4 float32 x0,y0,x1,y1;
// version 1: 4 samples of 4 float32 each, sample 0 used). Returns null on any structural or
// range problem (out-of-bounds read, non-finite float) so the caller can treat it as "no sheet".
function parseSheetBlob(buf, off) {
  let p = off;
  const readI32 = () => { const v = buf.readInt32LE(p); p += 4; return v; };
  const readF32 = () => { const v = buf.readFloatLE(p); p += 4; return v; };

  const version = readI32();
  const sequenceCount = readI32();
  if (!Number.isFinite(sequenceCount) || sequenceCount < 1 || sequenceCount > 64) return null;
  if (version !== 0 && version !== 1) return null;

  const sequences = [];
  for (let s = 0; s < sequenceCount; s++) {
    const sequenceNumber = readI32();
    const clamp = readI32();
    const frameCount = readI32();
    const totalTime = readF32();
    if (!Number.isFinite(frameCount) || frameCount < 0 || frameCount > 4096) return null;
    const frames = [];
    for (let f = 0; f < frameCount; f++) {
      const displayTime = readF32();
      const uv = [readF32(), readF32(), readF32(), readF32()];
      if (version === 1) p += 16 * 3; // skip samples 1..3, keep sample 0
      for (const c of uv) if (!Number.isFinite(c) || c < 0 || c > 1) return null;
      frames.push({ displayTime, uv });
    }
    sequences.push({ sequenceNumber, clamp: !!clamp, totalTime, frames });
  }
  return { version, sequences };
}

// Parse a VTF's embedded sprite-sheet resource, if present and well-formed. Returns
// { version, sequences: [{ sequenceNumber, clamp, totalTime, frames: [{displayTime, uv:[x0,y0,x1,y1]}] }] }
// or null if the VTF has no sheet resource, or the blob fails validation (out-of-range uv,
// sequenceCount, etc.) - callers should log and treat that as "no sheet" per spec.
export function parseVTFSpriteSheet(buf) {
  if (buf.toString('ascii', 0, 4) !== 'VTF\0') throw new Error('Not a VTF file');
  const off = findSheetResourceOffset(buf);
  if (off == null) return null;
  try {
    return parseSheetBlob(buf, off);
  } catch {
    return null;
  }
}

// Decode the six largest cubemap faces in Valve/DirectX order:
// +X, -X, +Y, -Y, +Z, -Z. This is also the order expected by THREE.CubeTexture.
export function decodeVTFCubemap(buf) {
  const hdr = parseVTFHeader(buf);
  if (hdr.faces < 6) throw new Error('VTF is not a six-face environment map');
  const first = largestMipOffset(hdr);
  const faceSize = mipByteSize(hdr.highResFormat, hdr.width, hdr.height);
  return Array.from({ length: 6 }, (_, face) => decodeLargestMipAt(buf, hdr, first + face * faceSize));
}
