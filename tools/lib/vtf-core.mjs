// Browser-safe VTF decoder. This module deliberately only uses Uint8Array and
// DataView, so it is shared by the Node extraction tools and the web client.
// It decodes the largest high-resolution mip by default.

export const VTF_FORMAT = {
  RGBA8888: 0, ABGR8888: 1, RGB888: 2, BGR888: 3, RGB565: 4, I8: 5, IA88: 6, P8: 7, A8: 8,
  RGB888_BLUESCREEN: 9, BGR888_BLUESCREEN: 10, ARGB8888: 11, BGRA8888: 12, DXT1: 13, DXT3: 14,
  DXT5: 15, BGRX8888: 16, BGR565: 17, BGRX5551: 18, BGRA4444: 19, DXT1_ONEBITALPHA: 20,
  BGRA5551: 21, UV88: 22, UVWQ8888: 23, RGBA16161616F: 24, RGBA16161616: 25, UVLX8888: 26,
};

const FLAG_ENVMAP = 0x4000;
const FLAG_POINTSAMPLE = 0x0001;
const FLAG_TRILINEAR = 0x0002;
const FLAG_CLAMPS = 0x0004;
const FLAG_CLAMPT = 0x0008;
const FLAG_ANISOTROPIC = 0x0010;
const FLAG_SRGB = 0x0040;
const FLAG_NOMIP = 0x0100;
const FLAG_NOLOD = 0x0200;
const RESOURCE_HIGH_RES = 0x30;
const RESOURCE_SHEET = 0x10;

function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('VTF data must be a Uint8Array or ArrayBuffer');
}

function viewOf(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function requireRange(bytes, offset, length, label = 'VTF data') {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`${label} is out of range (offset=${offset}, length=${length}, file=${bytes.length})`);
  }
}

function u8(bytes, offset) { requireRange(bytes, offset, 1); return bytes[offset]; }
function u16(bytes, offset) { requireRange(bytes, offset, 2); return viewOf(bytes).getUint16(offset, true); }
function u32(bytes, offset) { requireRange(bytes, offset, 4); return viewOf(bytes).getUint32(offset, true); }
function i32(bytes, offset) { requireRange(bytes, offset, 4); return viewOf(bytes).getInt32(offset, true); }
function f32(bytes, offset) { requireRange(bytes, offset, 4); return viewOf(bytes).getFloat32(offset, true); }

function formatBlockSize(format) {
  switch (format) {
    case VTF_FORMAT.DXT1:
    case VTF_FORMAT.DXT1_ONEBITALPHA: return { block: true, bytes: 8 };
    case VTF_FORMAT.DXT3:
    case VTF_FORMAT.DXT5: return { block: true, bytes: 16 };
    case VTF_FORMAT.RGBA8888:
    case VTF_FORMAT.ABGR8888:
    case VTF_FORMAT.ARGB8888:
    case VTF_FORMAT.BGRA8888:
    case VTF_FORMAT.BGRX8888: return { block: false, bpp: 4 };
    case VTF_FORMAT.RGB888:
    case VTF_FORMAT.BGR888: return { block: false, bpp: 3 };
    case VTF_FORMAT.RGB565:
    case VTF_FORMAT.BGR565:
    case VTF_FORMAT.IA88: return { block: false, bpp: 2 };
    case VTF_FORMAT.I8:
    case VTF_FORMAT.A8: return { block: false, bpp: 1 };
    default: return null;
  }
}

// The low-resolution thumbnail is not necessarily in a format the main image
// decoder supports. This table is deliberately complete for the Source 1 VTF
// IMAGE_FORMAT enum so its byte range can still be skipped safely.
function formatStorageInfo(format) {
  const supported = formatBlockSize(format);
  if (supported) return supported;
  switch (format) {
    case VTF_FORMAT.P8:
      return { block: false, bpp: 1 };
    case VTF_FORMAT.RGB888_BLUESCREEN:
    case VTF_FORMAT.BGR888_BLUESCREEN:
      return { block: false, bpp: 3 };
    case VTF_FORMAT.BGRX5551:
    case VTF_FORMAT.BGRA4444:
    case VTF_FORMAT.BGRA5551:
    case VTF_FORMAT.UV88:
      return { block: false, bpp: 2 };
    case VTF_FORMAT.UVWQ8888:
    case VTF_FORMAT.UVLX8888:
      return { block: false, bpp: 4 };
    case VTF_FORMAT.RGBA16161616F:
    case VTF_FORMAT.RGBA16161616:
      return { block: false, bpp: 8 };
    default:
      return null;
  }
}

function mipByteSize(format, width, height) {
  const info = formatStorageInfo(format);
  if (!info) throw new Error(`Unsupported VTF image format ${format}`);
  if (info.block) return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * info.bytes;
  return width * height * info.bpp;
}

// Sampling flags are independent from pixel decoding. Keep this a small typed
// data contract for the eventual source-file-system texture provider.
export function getVTFSamplingMetadata(flags) {
  return {
    clampS: Boolean(flags & FLAG_CLAMPS),
    clampT: Boolean(flags & FLAG_CLAMPT),
    pointSample: Boolean(flags & FLAG_POINTSAMPLE),
    trilinear: Boolean(flags & FLAG_TRILINEAR),
    anisotropic: Boolean(flags & FLAG_ANISOTROPIC),
    noMip: Boolean(flags & FLAG_NOMIP),
    noLod: Boolean(flags & FLAG_NOLOD),
    sRGB: Boolean(flags & FLAG_SRGB),
  };
}

export function parseVTFHeader(input) {
  const bytes = bytesOf(input);
  requireRange(bytes, 0, 57, 'VTF header');
  if (bytes[0] !== 0x56 || bytes[1] !== 0x54 || bytes[2] !== 0x46 || bytes[3] !== 0) throw new Error('Not a VTF file');
  const verMajor = u32(bytes, 4);
  const verMinor = u32(bytes, 8);
  const headerSize = u32(bytes, 12);
  const width = u16(bytes, 16);
  const height = u16(bytes, 18);
  const flags = u32(bytes, 20);
  const frames = u16(bytes, 24);
  const firstFrame = u16(bytes, 26);
  const highResFormat = u32(bytes, 52);
  const mipCount = u8(bytes, 56);
  const lowResFormat = u32(bytes, 57);
  const lowResWidth = u8(bytes, 61);
  const lowResHeight = u8(bytes, 62);
  if (headerSize < 63 || headerSize > bytes.length) throw new Error(`Invalid VTF header size ${headerSize}`);
  if (mipCount === 0) throw new Error('VTF has no high-resolution mip levels');
  if (frames === 0) throw new Error('VTF has no frames');

  let depth = 1;
  if (verMajor > 7 || (verMajor === 7 && verMinor >= 2)) depth = u16(bytes, 63) || 1;
  let imageDataOffset;
  let lowResImageDataOffset = null;
  let lowResImageDataSize = 0;
  if (verMajor > 7 || (verMajor === 7 && verMinor >= 3)) {
    const numResources = u32(bytes, 68);
    requireRange(bytes, 80, numResources * 8, 'VTF resource directory');
    let highResResourceOffset = null;
    for (let resource = 0, offset = 80; resource < numResources; resource += 1, offset += 8) {
      if (u8(bytes, offset) === RESOURCE_HIGH_RES && u8(bytes, offset + 1) === 0 && u8(bytes, offset + 2) === 0) {
        if (highResResourceOffset !== null) throw new Error('VTF has duplicate high-resolution image resources');
        if (u8(bytes, offset + 3) & 0x02) throw new Error('VTF high-resolution image resource has no data');
        highResResourceOffset = u32(bytes, offset + 4);
      }
    }
    if (highResResourceOffset === null) throw new Error('VTF 7.3+ is missing its high-resolution image resource');
    imageDataOffset = highResResourceOffset;
  } else {
    // VTF <= 7.2 lays out the thumbnail immediately after the header, before
    // high-resolution mips. Ignoring it shifts every high-res level.
    lowResImageDataSize = lowResWidth === 0 || lowResHeight === 0 || lowResFormat === 0xffffffff
      ? 0
      : mipByteSize(lowResFormat, lowResWidth, lowResHeight);
    requireRange(bytes, headerSize, lowResImageDataSize, 'VTF low-resolution thumbnail');
    lowResImageDataOffset = headerSize;
    imageDataOffset = headerSize + lowResImageDataSize;
  }
  if (imageDataOffset < headerSize || imageDataOffset >= bytes.length) throw new Error(`Invalid VTF image-data offset ${imageDataOffset}`);
  const legacySphereFace = Boolean(flags & FLAG_ENVMAP) && (verMajor < 7 || (verMajor === 7 && verMinor < 5)) && firstFrame !== 0xffff;
  const faces = flags & FLAG_ENVMAP ? (legacySphereFace ? 7 : 6) : 1;
  return {
    verMajor, verMinor, headerSize, width, height, flags, frames, firstFrame, highResFormat, mipCount, depth, faces, imageDataOffset,
    lowResFormat, lowResWidth, lowResHeight, lowResImageDataOffset, lowResImageDataSize,
    sampling: getVTFSamplingMetadata(flags),
  };
}

function largestMipOffset(header) {
  let offset = header.imageDataOffset;
  for (let level = header.mipCount - 1; level >= 1; level -= 1) {
    offset += mipByteSize(header.highResFormat, Math.max(1, header.width >> level), Math.max(1, header.height >> level))
      * header.frames * header.faces * Math.max(1, header.depth >> level);
  }
  return offset;
}

function decodeUncompressed(format, source, width, height, output) {
  const info = formatBlockSize(format);
  if (!info || info.block) throw new Error(`Unsupported uncompressed VTF image format ${format}`);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const sourceOffset = pixel * info.bpp;
    const outputOffset = pixel * 4;
    let red = 0; let green = 0; let blue = 0; let alpha = 255;
    switch (format) {
      case VTF_FORMAT.RGBA8888: red = source[sourceOffset]; green = source[sourceOffset + 1]; blue = source[sourceOffset + 2]; alpha = source[sourceOffset + 3]; break;
      case VTF_FORMAT.ABGR8888: alpha = source[sourceOffset]; blue = source[sourceOffset + 1]; green = source[sourceOffset + 2]; red = source[sourceOffset + 3]; break;
      case VTF_FORMAT.ARGB8888: alpha = source[sourceOffset]; red = source[sourceOffset + 1]; green = source[sourceOffset + 2]; blue = source[sourceOffset + 3]; break;
      case VTF_FORMAT.BGRA8888: blue = source[sourceOffset]; green = source[sourceOffset + 1]; red = source[sourceOffset + 2]; alpha = source[sourceOffset + 3]; break;
      case VTF_FORMAT.BGRX8888: blue = source[sourceOffset]; green = source[sourceOffset + 1]; red = source[sourceOffset + 2]; break;
      case VTF_FORMAT.RGB888: red = source[sourceOffset]; green = source[sourceOffset + 1]; blue = source[sourceOffset + 2]; break;
      case VTF_FORMAT.BGR888: blue = source[sourceOffset]; green = source[sourceOffset + 1]; red = source[sourceOffset + 2]; break;
      case VTF_FORMAT.I8: red = green = blue = source[sourceOffset]; break;
      case VTF_FORMAT.A8: red = green = blue = 255; alpha = source[sourceOffset]; break;
      case VTF_FORMAT.IA88: red = green = blue = source[sourceOffset]; alpha = source[sourceOffset + 1]; break;
      case VTF_FORMAT.RGB565: {
        const value = source[sourceOffset] | (source[sourceOffset + 1] << 8);
        red = ((value >> 11) & 31) * 255 / 31; green = ((value >> 5) & 63) * 255 / 63; blue = (value & 31) * 255 / 31;
        break;
      }
      case VTF_FORMAT.BGR565: {
        const value = source[sourceOffset] | (source[sourceOffset + 1] << 8);
        blue = ((value >> 11) & 31) * 255 / 31; green = ((value >> 5) & 63) * 255 / 63; red = (value & 31) * 255 / 31;
        break;
      }
      default: throw new Error(`Unsupported uncompressed VTF image format ${format}`);
    }
    output[outputOffset] = red; output[outputOffset + 1] = green; output[outputOffset + 2] = blue; output[outputOffset + 3] = alpha;
  }
}

function decodeDxtColorBlock(source, offset, colors, dxt1Palette, oneBitAlpha) {
  const color0 = source[offset] | (source[offset + 1] << 8);
  const color1 = source[offset + 2] | (source[offset + 3] << 8);
  const red0 = ((color0 >> 11) & 31) * 255 / 31; const green0 = ((color0 >> 5) & 63) * 255 / 63; const blue0 = (color0 & 31) * 255 / 31;
  const red1 = ((color1 >> 11) & 31) * 255 / 31; const green1 = ((color1 >> 5) & 63) * 255 / 63; const blue1 = (color1 & 31) * 255 / 31;
  colors[0] = [red0, green0, blue0, 255];
  colors[1] = [red1, green1, blue1, 255];
  if (!dxt1Palette || color0 > color1) {
    colors[2] = [(2 * red0 + red1) / 3, (2 * green0 + green1) / 3, (2 * blue0 + blue1) / 3, 255];
    colors[3] = [(red0 + 2 * red1) / 3, (green0 + 2 * green1) / 3, (blue0 + 2 * blue1) / 3, 255];
  } else {
    colors[2] = [(red0 + red1) / 2, (green0 + green1) / 2, (blue0 + blue1) / 2, 255];
    colors[3] = [0, 0, 0, oneBitAlpha ? 0 : 255];
  }
}

function decodeDxt(format, source, width, height, output) {
  const blocksWide = Math.ceil(width / 4);
  const blocksHigh = Math.ceil(height / 4);
  const dxt1 = format === VTF_FORMAT.DXT1 || format === VTF_FORMAT.DXT1_ONEBITALPHA;
  const blockBytes = dxt1 ? 8 : 16;
  const colors = new Array(4);
  for (let blockY = 0; blockY < blocksHigh; blockY += 1) {
    for (let blockX = 0; blockX < blocksWide; blockX += 1) {
      const blockOffset = (blockY * blocksWide + blockX) * blockBytes;
      let colorOffset = blockOffset;
      let alphaFor = null;
      if (format === VTF_FORMAT.DXT5) {
        const alpha0 = source[blockOffset]; const alpha1 = source[blockOffset + 1];
        const alphas = [alpha0, alpha1];
        if (alpha0 > alpha1) for (let index = 1; index <= 6; index += 1) alphas[index + 1] = ((7 - index) * alpha0 + index * alpha1) / 7;
        else { for (let index = 1; index <= 4; index += 1) alphas[index + 1] = ((5 - index) * alpha0 + index * alpha1) / 5; alphas[6] = 0; alphas[7] = 255; }
        alphaFor = (index) => {
          const bit = index * 3; const byteIndex = bit >> 3; const shift = bit & 7;
          let selector = (source[blockOffset + 2 + byteIndex] >> shift) & 7;
          if (shift > 5) selector |= (source[blockOffset + 3 + byteIndex] << (8 - shift)) & 7;
          return alphas[selector];
        };
        colorOffset += 8;
      } else if (format === VTF_FORMAT.DXT3) {
        alphaFor = (index) => ((source[blockOffset + (index >> 1)] >> ((index & 1) * 4)) & 15) * 255 / 15;
        colorOffset += 8;
      }
      decodeDxtColorBlock(source, colorOffset, colors, dxt1, format === VTF_FORMAT.DXT1_ONEBITALPHA);
      const selectors = source[colorOffset + 4] | (source[colorOffset + 5] << 8) | (source[colorOffset + 6] << 16) | (source[colorOffset + 7] << 24);
      for (let pixelY = 0; pixelY < 4; pixelY += 1) for (let pixelX = 0; pixelX < 4; pixelX += 1) {
        const x = blockX * 4 + pixelX; const y = blockY * 4 + pixelY;
        if (x >= width || y >= height) continue;
        const index = pixelY * 4 + pixelX; const color = colors[(selectors >>> (index * 2)) & 3]; const outputOffset = (y * width + x) * 4;
        output[outputOffset] = color[0]; output[outputOffset + 1] = color[1]; output[outputOffset + 2] = color[2]; output[outputOffset + 3] = alphaFor ? alphaFor(index) : color[3];
      }
    }
  }
}

function decodeLargestMipAt(input, header, offset) {
  const bytes = bytesOf(input);
  const size = mipByteSize(header.highResFormat, header.width, header.height);
  requireRange(bytes, offset, size, `VTF high-resolution mip (format ${header.highResFormat})`);
  const rgba = new Uint8Array(header.width * header.height * 4);
  const source = bytes.subarray(offset, offset + size);
  const info = formatBlockSize(header.highResFormat);
  if (!info) throw new Error(`Unsupported VTF image format ${header.highResFormat}`);
  if (info.block) decodeDxt(header.highResFormat, source, header.width, header.height, rgba);
  else decodeUncompressed(header.highResFormat, source, header.width, header.height, rgba);
  return { width: header.width, height: header.height, rgba, format: header.highResFormat };
}

function assertDimensions(header) {
  if (header.width === 0 || header.height === 0) throw new Error('VTF has zero dimension');
}

export function decodeVTF(input) {
  const header = parseVTFHeader(input); assertDimensions(header);
  return decodeLargestMipAt(input, header, largestMipOffset(header));
}

function largestMipFrameOffset(header, frameIndex) {
  return largestMipOffset(header) + frameIndex * mipByteSize(header.highResFormat, header.width, header.height) * header.faces * header.depth;
}

export function decodeVTFFrame(input, frameIndex) {
  const header = parseVTFHeader(input); assertDimensions(header);
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= header.frames) throw new Error(`Frame index ${frameIndex} out of range (frames=${header.frames})`);
  return decodeLargestMipAt(input, header, largestMipFrameOffset(header, frameIndex));
}

export function decodeVTFAllFrames(input) {
  const header = parseVTFHeader(input); assertDimensions(header);
  return Array.from({ length: header.frames }, (_, frame) => decodeLargestMipAt(input, header, largestMipFrameOffset(header, frame)));
}

function findSheetResourceOffset(input) {
  const bytes = bytesOf(input); const header = parseVTFHeader(bytes);
  if (!(header.verMajor > 7 || (header.verMajor === 7 && header.verMinor >= 3))) return null;
  const resources = u32(bytes, 68);
  for (let resource = 0, offset = 80; resource < resources; resource += 1, offset += 8) {
    if (u8(bytes, offset) === RESOURCE_SHEET && u8(bytes, offset + 1) === 0 && u8(bytes, offset + 2) === 0) return u32(bytes, offset + 4);
  }
  return null;
}

function parseSheetBlob(bytes, offset) {
  let position = offset;
  const readI32 = () => { const value = i32(bytes, position); position += 4; return value; };
  const readF32 = () => { const value = f32(bytes, position); position += 4; return value; };
  const version = readI32(); const sequenceCount = readI32();
  if (sequenceCount < 1 || sequenceCount > 64 || (version !== 0 && version !== 1)) return null;
  const sequences = [];
  for (let sequence = 0; sequence < sequenceCount; sequence += 1) {
    const sequenceNumber = readI32(); const clamp = readI32(); const frameCount = readI32(); const totalTime = readF32();
    if (frameCount < 0 || frameCount > 4096 || !Number.isFinite(totalTime)) return null;
    const frames = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      const displayTime = readF32(); const uv = [readF32(), readF32(), readF32(), readF32()];
      if (version === 1) { requireRange(bytes, position, 48, 'VTF sprite-sheet samples'); position += 48; }
      if (!Number.isFinite(displayTime) || uv.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0 || coordinate > 1)) return null;
      frames.push({ displayTime, uv });
    }
    sequences.push({ sequenceNumber, clamp: Boolean(clamp), totalTime, frames });
  }
  return { version, sequences };
}

export function parseVTFSpriteSheet(input) {
  const bytes = bytesOf(input);
  const offset = findSheetResourceOffset(bytes);
  if (offset == null) return null;
  try { requireRange(bytes, offset, 4, 'VTF sprite-sheet resource'); return parseSheetBlob(bytes, offset + 4); } catch { return null; }
}

export function decodeVTFCubemap(input) {
  const header = parseVTFHeader(input); assertDimensions(header);
  if (header.faces < 6) throw new Error('VTF is not a six-face environment map');
  const first = largestMipOffset(header); const faceSize = mipByteSize(header.highResFormat, header.width, header.height);
  return Array.from({ length: 6 }, (_, face) => decodeLargestMipAt(input, header, first + face * faceSize));
}
