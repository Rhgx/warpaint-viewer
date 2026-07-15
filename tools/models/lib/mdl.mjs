// Parser for Source 1 MDL (studiohdr_t), targeting version 48/49 (TF2).
// Extracts textures, skin table, bones (bind pose), and bodyparts -> models -> meshes.
import fs from 'node:fs';

function readCStr(buf, off) {
  if (off <= 0 || off >= buf.length) return '';
  let e = off;
  while (e < buf.length && buf[e] !== 0) e++;
  return buf.toString('ascii', off, e);
}

export function parseMDL(path) {
  const b = fs.readFileSync(path);
  const id = b.toString('ascii', 0, 4);
  if (id !== 'IDST') throw new Error(`${path}: not an MDL (id=${id})`);
  const version = b.readInt32LE(4);
  const checksum = b.readInt32LE(8);
  const name = readCStr(b, 12);

  const numbones = b.readInt32LE(0x9c);
  const boneindex = b.readInt32LE(0xa0);

  const numtextures = b.readInt32LE(0xcc);
  const textureindex = b.readInt32LE(0xd0);
  const numcdtextures = b.readInt32LE(0xd4);
  const cdtextureindex = b.readInt32LE(0xd8);

  const numskinref = b.readInt32LE(0xdc);
  const numskinfamilies = b.readInt32LE(0xe0);
  const skinindex = b.readInt32LE(0xe4);

  const numbodyparts = b.readInt32LE(0xe8);
  const bodypartindex = b.readInt32LE(0xec);

  // --- textures ---
  const textures = [];
  for (let i = 0; i < numtextures; i++) {
    const base = textureindex + i * 64;
    const sz = b.readInt32LE(base);
    textures.push(readCStr(b, base + sz));
  }

  // --- cdtextures (search paths) ---
  const cdtextures = [];
  for (let i = 0; i < numcdtextures; i++) {
    const p = b.readInt32LE(cdtextureindex + i * 4);
    cdtextures.push(readCStr(b, p));
  }

  // --- skin families table [family][ref] -> texture index ---
  const skins = [];
  for (let f = 0; f < numskinfamilies; f++) {
    const row = [];
    for (let r = 0; r < numskinref; r++) {
      row.push(b.readInt16LE(skinindex + (f * numskinref + r) * 2));
    }
    skins.push(row);
  }

  // --- bones (bind pose local pos + quat, parent, poseToBone matrix) ---
  const bones = [];
  for (let i = 0; i < numbones; i++) {
    const base = boneindex + i * 216;
    const sz = b.readInt32LE(base);
    const bname = readCStr(b, base + sz);
    const parent = b.readInt32LE(base + 4);
    const pos = [
      b.readFloatLE(base + 32),
      b.readFloatLE(base + 36),
      b.readFloatLE(base + 40),
    ];
    const quat = [
      b.readFloatLE(base + 44),
      b.readFloatLE(base + 48),
      b.readFloatLE(base + 52),
      b.readFloatLE(base + 56),
    ];
    // poseToBone matrix3x4 at offset 96 (world->bone, i.e. inverse bind)
    const poseToBone = [];
    for (let k = 0; k < 12; k++) poseToBone.push(b.readFloatLE(base + 96 + k * 4));
    bones.push({ index: i, name: bname, parent, pos, quat, poseToBone });
  }

  // --- bodyparts -> models -> meshes ---
  const bodyparts = [];
  for (let i = 0; i < numbodyparts; i++) {
    const base = bodypartindex + i * 16;
    const sz = b.readInt32LE(base);
    const bpName = readCStr(b, base + sz);
    const nummodels = b.readInt32LE(base + 4);
    const bpBaseVal = b.readInt32LE(base + 8);
    const modelindex = b.readInt32LE(base + 12);
    const models = [];
    for (let m = 0; m < nummodels; m++) {
      const mbase = base + modelindex + m * 148;
      const mname = readCStr(b, mbase);
      const nummeshes = b.readInt32LE(mbase + 72);
      const meshindex = b.readInt32LE(mbase + 76);
      const numvertices = b.readInt32LE(mbase + 80);
      const vertexindex = b.readInt32LE(mbase + 84); // byte offset into VVD vertices
      const meshes = [];
      for (let e = 0; e < nummeshes; e++) {
        const mesh = mbase + meshindex + e * 116;
        const material = b.readInt32LE(mesh);
        const meshNumVerts = b.readInt32LE(mesh + 8);
        const vertexoffset = b.readInt32LE(mesh + 12); // vertex offset within model
        const lod0verts = b.readInt32LE(mesh + 52); // numLODVertexes[0]
        meshes.push({ index: e, material, numvertices: meshNumVerts, vertexoffset, lod0verts });
      }
      models.push({
        index: m,
        name: mname,
        nummeshes,
        numvertices,
        vertexindex,
        vertexStart: vertexindex / 48,
        meshes,
      });
    }
    bodyparts.push({ index: i, name: bpName, base: bpBaseVal, nummodels, models });
  }

  return {
    path, version, checksum, name,
    textures, cdtextures, skins,
    numskinref, numskinfamilies,
    bones, bodyparts,
  };
}

// Resolve the material name for a mesh at skin family `skinFamily`.
// mesh.material indexes the skin ref column; skins[family][col] -> texture index.
export function resolveMaterialName(mdl, meshMaterial, skinFamily = 0) {
  let texIndex = meshMaterial;
  if (mdl.skins.length > skinFamily && meshMaterial < mdl.numskinref) {
    texIndex = mdl.skins[skinFamily][meshMaterial];
  }
  const tex = mdl.textures[texIndex] ?? mdl.textures[meshMaterial] ?? `material_${meshMaterial}`;
  return tex.replace(/\\/g, '/');
}
