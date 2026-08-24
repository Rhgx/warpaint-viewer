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
  const hullMin = [b.readFloatLE(0x68), b.readFloatLE(0x6c), b.readFloatLE(0x70)];
  const hullMax = [b.readFloatLE(0x74), b.readFloatLE(0x78), b.readFloatLE(0x7c)];

  const numbones = b.readInt32LE(0x9c);
  const boneindex = b.readInt32LE(0xa0);
  const numhitboxsets = b.readInt32LE(0xac);
  const hitboxsetindex = b.readInt32LE(0xb0);

  const numtextures = b.readInt32LE(0xcc);
  const textureindex = b.readInt32LE(0xd0);
  const numcdtextures = b.readInt32LE(0xd4);
  const cdtextureindex = b.readInt32LE(0xd8);

  const numskinref = b.readInt32LE(0xdc);
  const numskinfamilies = b.readInt32LE(0xe0);
  const skinindex = b.readInt32LE(0xe4);

  const numbodyparts = b.readInt32LE(0xe8);
  const bodypartindex = b.readInt32LE(0xec);

  const numlocalattachments = b.readInt32LE(0xf0);
  const localattachmentindex = b.readInt32LE(0xf4);

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

  // --- first hitbox set (the active set for TF2 weapon models) ---
  const hitboxes = [];
  if (numhitboxsets > 0) {
    const setBase = hitboxsetindex;
    const numhitboxes = b.readInt32LE(setBase + 4);
    const hitboxindex = b.readInt32LE(setBase + 8);
    for (let i = 0; i < numhitboxes; i++) {
      const base = setBase + hitboxindex + i * 68;
      hitboxes.push({
        bone: b.readInt32LE(base),
        min: [b.readFloatLE(base + 8), b.readFloatLE(base + 12), b.readFloatLE(base + 16)],
        max: [b.readFloatLE(base + 20), b.readFloatLE(base + 24), b.readFloatLE(base + 28)],
      });
    }
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

  // --- attachments (mstudioattachment_t: sznameindex, flags, localbone, local[12], unused[8]) ---
  const attachments = [];
  for (let i = 0; i < numlocalattachments; i++) {
    const base = localattachmentindex + i * 92;
    const sz = b.readInt32LE(base);
    const aname = readCStr(b, base + sz);
    const flags = b.readUInt32LE(base + 4);
    const localbone = b.readInt32LE(base + 8);
    const local = [];
    for (let k = 0; k < 12; k++) local.push(b.readFloatLE(base + 12 + k * 4));
    attachments.push({ index: i, name: aname, flags, localbone, local });
  }

  return {
    path, version, checksum, name,
    textures, cdtextures, skins,
    numskinref, numskinfamilies,
    bones, bodyparts, attachments, hitboxes, hullMin, hullMax,
  };
}

// Invert a 3x4 row-major affine matrix (rotation + translation, no scale/shear),
// i.e. the same layout as mstudiobone_t.poseToBone and mstudioattachment_t.local.
// Given M = [R | t], M^-1 = [R^T | -R^T * t].
export function invertAffine3x4(m) {
  const r00 = m[0], r01 = m[1], r02 = m[2], tx = m[3];
  const r10 = m[4], r11 = m[5], r12 = m[6], ty = m[7];
  const r20 = m[8], r21 = m[9], r22 = m[10], tz = m[11];
  const itx = -(r00 * tx + r10 * ty + r20 * tz);
  const ity = -(r01 * tx + r11 * ty + r21 * tz);
  const itz = -(r02 * tx + r12 * ty + r22 * tz);
  return [r00, r10, r20, itx, r01, r11, r21, ity, r02, r12, r22, itz];
}

// Apply a row-major 3x4 affine matrix to a point.
export function applyMat3x4(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
  ];
}

// Compose two row-major affine 3x4 matrices: a * b.
export function multiplyAffine3x4(a, b) {
  const out = new Array(12);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      out[row * 4 + col] = a[row * 4] * b[col]
        + a[row * 4 + 1] * b[4 + col]
        + a[row * 4 + 2] * b[8 + col];
    }
    out[row * 4 + 3] = a[row * 4] * b[3]
      + a[row * 4 + 1] * b[7]
      + a[row * 4 + 2] * b[11]
      + a[row * 4 + 3];
  }
  return out;
}

// Orientation: TF2 c_model weapons are NOT authored in Source world space
// (Z-up). They are authored in the weapon_bone attachment frame, which is
// bonemerged onto the player's hand in-game. Verified against the MDL bone
// data of all 45 manifest weapons: root "weapon_bone" quat is identity for
// every gun, and the geometry uses +X right, +Y up, +Z forward (muzzle).
// Evidence: flamethrower tank hangs at y=-17.6 (down), sniper scope at
// y=+17.2 (up), every barrel extends along +Z (flamethrower nozzle z=+68.9,
// shotgun z=+35). That frame already matches glTF conventions (Y-up,
// right-handed, front at +Z), so NO axis rotation is applied.
//
// A few models carry a non-identity root bone (c_knife: 180 deg about Y,
// c_demo_sultan_sword: -90 deg about Y, some have translation offsets), so we
// re-express the bind mesh in the root bone frame by applying the root bone's
// poseToBone (world-to-bone) matrix3x4. For identity roots this is a no-op;
// for the rest it normalizes facing/origin to the common attachment frame.
// Melee weapons are genuinely authored head/blade along +Y (up out of the
// gripping fist); that is correct and left as-is.
//
// Shared by mdl2gltf.mjs (mesh vertices) and tools/extract/attachments.mjs
// (unusual/muzzle attachment points), so both land in the identical frame.
export function rootFrameTransforms(mdl) {
  const ptb = mdl.bones[0]?.poseToBone;
  if (!ptb) {
    return { pos: (v) => v, nrm: (v) => v };
  }
  const m = ptb; // row-major 3x4: rows [r0 r1 r2], col 3 = translation
  const pos = (v) => applyMat3x4(m, v);
  const nrm = (v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
  return { pos, nrm };
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
