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

  const faces = flags & FLAG_ENVMAP ? 6 : 1;
  return { verMajor, verMinor, headerSize, width, height, flags, frames, highResFormat, mipCount, depth, faces, imageDataOffset };
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

function decodeDXTColorBlock(src, o, colors) {
  const c0 = src[o] | (src[o + 1] << 8);
  const c1 = src[o + 2] | (src[o + 3] << 8);
  const r0 = ((c0 >> 11) & 0x1f) * 255 / 31, g0 = ((c0 >> 5) & 0x3f) * 255 / 63, b0 = (c0 & 0x1f) * 255 / 31;
  const r1 = ((c1 >> 11) & 0x1f) * 255 / 31, g1 = ((c1 >> 5) & 0x3f) * 255 / 63, b1 = (c1 & 0x1f) * 255 / 31;
  colors[0] = [r0, g0, b0, 255];
  colors[1] = [r1, g1, b1, 255];
  if (c0 > c1) {
    colors[2] = [(2 * r0 + r1) / 3, (2 * g0 + g1) / 3, (2 * b0 + b1) / 3, 255];
    colors[3] = [(r0 + 2 * r1) / 3, (g0 + 2 * g1) / 3, (b0 + 2 * b1) / 3, 255];
  } else {
    colors[2] = [(r0 + r1) / 2, (g0 + g1) / 2, (b0 + b1) / 2, 255];
    colors[3] = [0, 0, 0, 0]; // transparent for DXT1 1-bit alpha
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
      decodeDXTColorBlock(src, colorOff, colors);
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
  const { highResFormat: fmt, width, height } = hdr;
  if (width === 0 || height === 0) throw new Error('VTF has zero dimension');
  const off = largestMipOffset(hdr);
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
