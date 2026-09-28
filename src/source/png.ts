import { crc32 } from './crc32';

/**
 * PNG encoder for decoded Source textures. Canvas serialisation premultiplies
 * RGB by alpha, which is incorrect for texture data where the two channels
 * are intentionally independent.
 */
export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(data.length + 8, crc32(chunk.subarray(4, data.length + 8)));
  return chunk;
}

function zlibStore(data: Uint8Array): Uint8Array {
  const blocks = Math.ceil(data.length / 0xffff);
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4);
  out.set([0x78, 0x01]);
  let from = 0;
  let to = 2;
  while (from < data.length) {
    const size = Math.min(0xffff, data.length - from);
    out[to] = from + size === data.length ? 1 : 0;
    out[to + 1] = size & 255;
    out[to + 2] = size >>> 8;
    out[to + 3] = (~size) & 255;
    out[to + 4] = (~size) >>> 8;
    out.set(data.subarray(from, from + size), to + 5);
    from += size;
    to += size + 5;
  }
  let a = 1;
  let b = 0;
  for (const value of data) { a = (a + value) % 65521; b = (b + a) % 65521; }
  new DataView(out.buffer).setUint32(to, ((b << 16) | a) >>> 0);
  return out;
}

/** zlib-wrapped deflate, stored blocks where CompressionStream is missing. */
export async function zlibCompress(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') return zlibStore(data);
  return new Uint8Array(await new Response(
    new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate')),
  ).arrayBuffer());
}

export async function encodeRgbaPng(data: Uint8Array, width: number, height: number): Promise<ArrayBuffer> {
  const scanlines = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    scanlines.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const compressed = await zlibCompress(scanlines);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const chunks = [pngChunk('IHDR', header), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array())];
  const png = new Uint8Array(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  for (const chunk of chunks) { png.set(chunk, offset); offset += chunk.length; }
  return png.buffer;
}
