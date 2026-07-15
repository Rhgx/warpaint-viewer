// Parser for Source 1 VTX (optimized mesh, .dx90.vtx, file version 7).
// All structs are byte-packed (#pragma pack(1)). Produces LOD0 triangle lists
// of origMeshVertID per (bodypart, model, mesh), matching the MDL hierarchy order.
import fs from 'node:fs';

const STRIP_IS_TRILIST = 0x01;
const STRIP_IS_TRISTRIP = 0x02;

// Strip group vertex (Vertex_t), 9 bytes:
//   0: byte boneWeightIndex[3]; 3: byte numBones; 4: uint16 origMeshVertID; 6: byte boneID[3]
const SG_VERT_SIZE = 9;

export function parseVTX(path) {
  const b = fs.readFileSync(path);
  const version = b.readInt32LE(0);
  const checksum = b.readInt32LE(16);
  const numLODs = b.readInt32LE(20);
  const numBodyParts = b.readInt32LE(28);
  const bodyPartOffset = b.readInt32LE(32);

  // Detect whether Strip/StripGroup carry the extra topology fields (8 bytes each).
  // We validate strip parsing under both assumptions on the first non-empty mesh.
  const extra = detectExtra(b, numBodyParts, bodyPartOffset);
  const SG_SIZE = extra ? 33 : 25;
  const STRIP_SIZE = extra ? 35 : 27;

  const bodyparts = [];
  for (let bp = 0; bp < numBodyParts; bp++) {
    const bpBase = bodyPartOffset + bp * 8;
    const numModels = b.readInt32LE(bpBase);
    const modelOffset = b.readInt32LE(bpBase + 4);
    const models = [];
    for (let m = 0; m < numModels; m++) {
      const mBase = bpBase + modelOffset + m * 8;
      const nLods = b.readInt32LE(mBase);
      const lodOffset = b.readInt32LE(mBase + 4);
      // LOD0 only
      const lodBase = mBase + lodOffset; // lod index 0
      const numMeshes = b.readInt32LE(lodBase);
      const meshOffset = b.readInt32LE(lodBase + 4);
      const meshes = [];
      for (let me = 0; me < numMeshes; me++) {
        const meshBase = lodBase + meshOffset + me * 9;
        const numStripGroups = b.readInt32LE(meshBase);
        const sgOffset = b.readInt32LE(meshBase + 4);
        const triangles = []; // flat array of origMeshVertID triples
        for (let sg = 0; sg < numStripGroups; sg++) {
          const sgBase = meshBase + sgOffset + sg * SG_SIZE;
          const numVerts = b.readInt32LE(sgBase);
          const vertOffset = b.readInt32LE(sgBase + 4);
          const numIndices = b.readInt32LE(sgBase + 8);
          const indexOffset = b.readInt32LE(sgBase + 12);
          const numStrips = b.readInt32LE(sgBase + 16);
          const stripOffset = b.readInt32LE(sgBase + 20);

          const idxBase = sgBase + indexOffset;
          const vBase = sgBase + vertOffset;
          const origOf = (sgVertIdx) =>
            b.readUInt16LE(vBase + sgVertIdx * SG_VERT_SIZE + 4);

          for (let s = 0; s < numStrips; s++) {
            const stripBase = sgBase + stripOffset + s * STRIP_SIZE;
            const sNumIndices = b.readInt32LE(stripBase);
            const sIndexOffset = b.readInt32LE(stripBase + 4);
            const sFlags = b.readUInt8(stripBase + 18);

            if (sFlags & STRIP_IS_TRISTRIP) {
              // triangle strip
              for (let i = 0; i < sNumIndices - 2; i++) {
                const a = b.readUInt16LE(idxBase + (sIndexOffset + i) * 2);
                const b1 = b.readUInt16LE(idxBase + (sIndexOffset + i + 1) * 2);
                const c = b.readUInt16LE(idxBase + (sIndexOffset + i + 2) * 2);
                if (a === b1 || b1 === c || a === c) continue;
                if (i & 1) {
                  triangles.push(origOf(a), origOf(c), origOf(b1));
                } else {
                  triangles.push(origOf(a), origOf(b1), origOf(c));
                }
              }
            } else {
              // trilist (default)
              for (let i = 0; i + 2 < sNumIndices; i += 3) {
                const a = b.readUInt16LE(idxBase + (sIndexOffset + i) * 2);
                const b1 = b.readUInt16LE(idxBase + (sIndexOffset + i + 1) * 2);
                const c = b.readUInt16LE(idxBase + (sIndexOffset + i + 2) * 2);
                triangles.push(origOf(a), origOf(b1), origOf(c));
              }
            }
          }
        }
        meshes.push({ index: me, triangles });
      }
      models.push({ index: m, numLODs: nLods, meshes });
    }
    bodyparts.push({ index: bp, models });
  }

  return { version, checksum, numLODs, extra, bodyparts };
}

// Validate strip parsing under a given `extra` assumption; returns true if consistent.
function validateExtra(b, numBodyParts, bodyPartOffset, extra) {
  const SG_SIZE = extra ? 33 : 25;
  const STRIP_SIZE = extra ? 35 : 27;
  let checked = 0;
  for (let bp = 0; bp < numBodyParts; bp++) {
    const bpBase = bodyPartOffset + bp * 8;
    const numModels = b.readInt32LE(bpBase);
    const modelOffset = b.readInt32LE(bpBase + 4);
    for (let m = 0; m < numModels; m++) {
      const mBase = bpBase + modelOffset + m * 8;
      const lodOffset = b.readInt32LE(mBase + 4);
      const lodBase = mBase + lodOffset;
      const numMeshes = b.readInt32LE(lodBase);
      const meshOffset = b.readInt32LE(lodBase + 4);
      for (let me = 0; me < numMeshes; me++) {
        const meshBase = lodBase + meshOffset + me * 9;
        const numStripGroups = b.readInt32LE(meshBase);
        const sgOffset = b.readInt32LE(meshBase + 4);
        for (let sg = 0; sg < numStripGroups; sg++) {
          const sgBase = meshBase + sgOffset + sg * SG_SIZE;
          const numIndices = b.readInt32LE(sgBase + 8);
          const numStrips = b.readInt32LE(sgBase + 16);
          const stripOffset = b.readInt32LE(sgBase + 20);
          if (numStrips <= 0 || numStrips > 100000) return false;
          let sumIdx = 0;
          for (let s = 0; s < numStrips; s++) {
            const stripBase = sgBase + stripOffset + s * STRIP_SIZE;
            if (stripBase + STRIP_SIZE > b.length) return false;
            const sNumIndices = b.readInt32LE(stripBase);
            const sIndexOffset = b.readInt32LE(stripBase + 4);
            const sFlags = b.readUInt8(stripBase + 18);
            if (sNumIndices < 0 || sIndexOffset < 0) return false;
            if (sIndexOffset + sNumIndices > numIndices) return false;
            if ((sFlags & (STRIP_IS_TRILIST | STRIP_IS_TRISTRIP)) === 0) return false;
            sumIdx += sNumIndices;
            checked++;
          }
          if (sumIdx !== numIndices) return false;
        }
      }
    }
  }
  return checked > 0;
}

function detectExtra(b, numBodyParts, bodyPartOffset) {
  const noExtra = validateExtra(b, numBodyParts, bodyPartOffset, false);
  if (noExtra) return false;
  const withExtra = validateExtra(b, numBodyParts, bodyPartOffset, true);
  if (withExtra) return true;
  // Fall back to no-extra (TF2 default) if neither validated cleanly.
  return false;
}
