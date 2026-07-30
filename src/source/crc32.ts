const CRC32_TABLE = buildCrc32Table();

export function crc32(bytes: Uint8Array): number {
  return crc32Chunks(bytes);
}

export function crc32Chunks(...chunks: readonly Uint8Array[]): number {
  let value = 0xffffffff;
  for (const bytes of chunks) {
    for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
