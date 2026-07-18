// Parser for Source 1 VVD (vertexFileHeader_t v4). Reads the LOD0 vertex array
// after applying the fixup table.
//
// Each mstudiovertex_t (48 bytes):
//   0  : float weight[3]         (12)
//   12 : byte  bone[3]           (3)
//   15 : byte  numbones          (1)
//   16 : Vector m_vecPosition    (12)  -- model space, bind pose
//   28 : Vector m_vecNormal      (12)
//   40 : Vector2D m_vecTexCoord  (8)
import fs from 'node:fs';

const VERT_SIZE = 48;

export function parseVVD(path) {
  const b = fs.readFileSync(path);
  const id = b.toString('ascii', 0, 4);
  if (id !== 'IDSV') throw new Error(`${path}: not a VVD (id=${id})`);
  const version = b.readInt32LE(4);
  const checksum = b.readInt32LE(8);
  const numLODs = b.readInt32LE(12);
  const numLODVertexes = [];
  for (let i = 0; i < 8; i++) numLODVertexes.push(b.readInt32LE(16 + i * 4));
  const numFixups = b.readInt32LE(48);
  const fixupTableStart = b.readInt32LE(52);
  const vertexDataStart = b.readInt32LE(56);
  // Offset 60 holds tangentDataStart; tangents are not needed here.

  function readVert(globalIndex) {
    const p = vertexDataStart + globalIndex * VERT_SIZE;
    return {
      weights: [b.readFloatLE(p), b.readFloatLE(p + 4), b.readFloatLE(p + 8)],
      bones: [b.readUInt8(p + 12), b.readUInt8(p + 13), b.readUInt8(p + 14)],
      numbones: b.readUInt8(p + 15),
      pos: [b.readFloatLE(p + 16), b.readFloatLE(p + 20), b.readFloatLE(p + 24)],
      normal: [b.readFloatLE(p + 28), b.readFloatLE(p + 32), b.readFloatLE(p + 36)],
      uv: [b.readFloatLE(p + 40), b.readFloatLE(p + 44)],
    };
  }

  // Build the LOD0 vertex array applying the fixup table.
  // For target rootLod=0, copy every fixup whose lod >= 0 in table order.
  const rootLod = 0;
  const verts = [];
  if (numFixups > 0) {
    for (let i = 0; i < numFixups; i++) {
      const fb = fixupTableStart + i * 12;
      const lod = b.readInt32LE(fb);
      const sourceVertexID = b.readInt32LE(fb + 4);
      const numVertexes = b.readInt32LE(fb + 8);
      if (lod >= rootLod) {
        for (let v = 0; v < numVertexes; v++) verts.push(readVert(sourceVertexID + v));
      }
    }
  } else {
    const n = numLODVertexes[0];
    for (let i = 0; i < n; i++) verts.push(readVert(i));
  }

  return {
    path, version, checksum, numLODs, numLODVertexes,
    numFixups, verts,
  };
}
