// Port of parseContainer in tools/lib/proto.mjs, over an in-memory buffer. proto_defs.vpd
// is a flat little-endian sequence of blocks, { int32 defType; int32 numDefs;
// numDefs * (int32 size; byte[size]) }, read to EOF with no magic number, so a corrupt
// file usually fails a bounds check.
//
// Every count and offset is treated as hostile: bad sizes are rejected rather than read
// out of bounds or allocated.

interface ContainerBlock {
  buffer: Uint8Array;
}

export interface ParsedContainer {
  byType: Record<number, ContainerBlock[]>;
}

// Same per-block guard as the Node pipeline (tools/lib/proto.mjs).
const MAX_NUM_DEFS_PER_BLOCK = 1_000_000;
// Unlike the Node pipeline, this reads untrusted files: many small blocks could each pass
// the per-block check and still add up to an absurd total.
const MAX_TOTAL_DEFS = 2_000_000;

export function parseContainer(bytes: Uint8Array): ParsedContainer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byType: Record<number, ContainerBlock[]> = {};
  let off = 0;
  let totalDefs = 0;

  while (off + 8 <= bytes.length) {
    const defType = view.getInt32(off, true); off += 4;
    const numDefs = view.getInt32(off, true); off += 4;
    if (numDefs < 0 || numDefs > MAX_NUM_DEFS_PER_BLOCK) {
      throw new Error(`Suspicious numDefs=${numDefs} at offset ${off - 4} (defType=${defType}). This does not look like a valid proto_defs container.`);
    }
    totalDefs += numDefs;
    if (totalDefs > MAX_TOTAL_DEFS) {
      throw new Error(`Container declares ${totalDefs} definitions total, over the ${MAX_TOTAL_DEFS} cap. Refusing to parse further.`);
    }

    const list = byType[defType] ?? (byType[defType] = []);
    for (let i = 0; i < numDefs; i++) {
      if (off + 4 > bytes.length) {
        throw new Error(`Truncated container: expected a size field at offset ${off} for defType=${defType} idx=${i}, but the buffer ends at ${bytes.length}.`);
      }
      const size = view.getInt32(off, true); off += 4;
      if (size < 0 || off + size > bytes.length) {
        throw new Error(`Bad size=${size} at offset ${off - 4} for defType=${defType} idx=${i}: runs past the end of the buffer (length=${bytes.length}).`);
      }
      const payload = bytes.subarray(off, off + size);
      off += size;
      list.push({ buffer: payload });
    }
  }

  return { byType };
}
