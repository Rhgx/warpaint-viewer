// Port of tools/lib/proto.mjs `parseContainer`, over an in-memory Uint8Array
// instead of a file path. proto_defs.vpd is a flat little-endian container:
// repeated blocks of { int32 defType; int32 numDefs; numDefs * (int32 size; byte[size] payload) }
// until EOF. There is no length prefix for the whole file and no magic number,
// so a corrupt or unrelated file mostly just fails one of the bounds checks below.
//
// This parses bytes a user drags in, so every count and offset is treated as
// hostile: negative or absurd values, and any block whose declared size would
// run past the end of the buffer, are rejected with a specific error rather
// than allowed to read out of bounds or allocate unbounded arrays.

interface ContainerBlock {
  size: number;
  buffer: Uint8Array;
}

export interface ParsedContainer {
  byType: Record<number, ContainerBlock[]>;
  totalBytes: number;
  consumed: number;
}

// Same per-block guard as the Node pipeline (tools/lib/proto.mjs).
const MAX_NUM_DEFS_PER_BLOCK = 1_000_000;
// Additional guard the Node pipeline doesn't need: it only ever reads one
// trusted, known-good file. A hostile file could declare many small blocks
// that each pass the per-block check yet still add up to an absurd total, so
// cap the grand total of definitions across every block in the container too.
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
      list.push({ size, buffer: payload });
    }
  }

  return { byType, totalBytes: bytes.length, consumed: off };
}
