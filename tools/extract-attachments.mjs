#!/usr/bin/env node
// Extracts MDL attachment points ("unusual_0".."unusual_5", "muzzle") for every weapon in
// staging/weapon_models.json, expressed in the same coordinate frame as the published GLB
// geometry (see rootFrameTransforms() in tools/models/lib/mdl.mjs).
//
// Produces: public/data/effects/attachments.json (format v2)
//   {
//     "<weaponKey>": {
//       "unusual_0": { "pos": [x, y, z], "quat": [qx, qy, qz, qw] },
//       ...
//       "muzzle": { "pos": [x, y, z], "quat": [qx, qy, qz, qw] }
//     }, ...
//   }
//
// `pos` is the attachment origin in glb/geometry space (unchanged from format v1). `quat` is the
// attachment's local orientation frame (mstudioattachment_t.local's 3x3 rotation part), carried
// through the same bone-world and root-frame transforms as pos, then re-orthonormalized and
// converted to a unit quaternion.
//
// Usage: node tools/extract-attachments.mjs  (also invoked from tools/extract-effects.mjs)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { extractBatch, MISC_VPK } from './lib/vpk.mjs';
import { parseMDL, invertAffine3x4, applyMat3x4, rootFrameTransforms } from './models/lib/mdl.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const STAGING = path.join(REPO, 'staging', 'models'); // shared with mdl2gltf.mjs's cache
const MANIFEST = path.join(REPO, 'staging', 'weapon_models.json');
const OUT = path.join(REPO, 'public', 'data', 'effects');

function log(...a) { console.log('[attachments]', ...a); }

// Ensure a weapon's .mdl is present in staging, extracting it from the misc VPK if needed.
// Mirrors mdl2gltf.mjs's ensureExtracted but only needs the .mdl (no VVD/VTX geometry).
function ensureMdl(vpkRel) {
  vpkRel = vpkRel.replace(/\\/g, '/').replace(/^\/+/, '');
  const dest = path.join(STAGING, vpkRel);
  if (!fs.existsSync(dest)) {
    extractBatch(MISC_VPK, [vpkRel], STAGING);
  }
  if (!fs.existsSync(dest)) throw new Error(`could not extract ${vpkRel} from ${MISC_VPK}`);
  return dest;
}

// ---------------------------------------------------------------------------
// Small vector / 3x3 matrix / quaternion helpers for attachment orientation.
// ---------------------------------------------------------------------------

function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
function scale3(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
function sub3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function normalize3(v) {
  const len = Math.sqrt(dot3(v, v));
  if (!(len > 1e-12)) throw new Error('cannot normalize a zero-length vector');
  return scale3(v, 1 / len);
}

// Extract the 3x3 rotation part (row-major, 9 elements) from a row-major 3x4 affine matrix
// (indices 0,1,2 / 4,5,6 / 8,9,10 - same layout as poseToBone and mstudioattachment_t.local).
function rot3x3(m) {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
}

// Multiply two row-major 3x3 matrices: a * b.
function mulMat3(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3 + 0] * b[0 * 3 + j] + a[i * 3 + 1] * b[1 * 3 + j] + a[i * 3 + 2] * b[2 * 3 + j];
    }
  }
  return r;
}

// Column j (a length-3 basis vector) of a row-major 3x3 matrix.
function col3(m, j) { return [m[j], m[3 + j], m[6 + j]]; }

// Gram-Schmidt orthonormalize three (already roughly-orthogonal) basis vectors, re-deriving Z
// as X-cross-Y so the result is guaranteed a right-handed orthonormal frame even after passing
// through a linear transform that isn't perfectly rotation-only (floating point drift).
function orthonormalizeBasis(x, y) {
  const nx = normalize3(x);
  const yOrtho = sub3(y, scale3(nx, dot3(nx, y)));
  const ny = normalize3(yOrtho);
  const nz = cross3(nx, ny);
  return { x: nx, y: ny, z: nz };
}

// Convert a row-major 3x3 rotation matrix to a unit quaternion [qx, qy, qz, qw] (Shepperd's
// method, numerically stable across all rotation angles).
function mat3ToQuat(m) {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let qx, qy, qz, qw;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    qw = 0.25 * s;
    qx = (m21 - m12) / s;
    qy = (m02 - m20) / s;
    qz = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    qw = (m21 - m12) / s;
    qx = 0.25 * s;
    qy = (m01 + m10) / s;
    qz = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    qw = (m02 - m20) / s;
    qx = (m01 + m10) / s;
    qy = 0.25 * s;
    qz = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    qw = (m10 - m01) / s;
    qx = (m02 + m20) / s;
    qy = (m12 + m21) / s;
    qz = 0.25 * s;
  }
  return [qx, qy, qz, qw];
}

// Rotate a vector by a unit quaternion [qx, qy, qz, qw]: v' = v + 2w(q_v x v) + 2 q_v x (q_v x v).
function rotateVecByQuat(q, v) {
  const qv = [q[0], q[1], q[2]];
  const w = q[3];
  const uv = cross3(qv, v);
  const uuv = cross3(qv, uv);
  return [
    v[0] + 2 * (w * uv[0] + uuv[0]),
    v[1] + 2 * (w * uv[1] + uuv[1]),
    v[2] + 2 * (w * uv[2] + uuv[2]),
  ];
}

// Compute the world-space (object-space) origin AND orientation of an attachment, then re-express
// both in the weapon's root-bone frame with the exact same transform mdl2gltf.mjs applies to
// vertices (xform.pos for the origin, xform.nrm - the transform's linear/rotation part, with no
// translation - for the orientation basis vectors, per the effects-extraction spec).
function attachmentFrame(mdl, xform, attachment) {
  const bone = mdl.bones[attachment.localbone];
  if (!bone) {
    throw new Error(`attachment "${attachment.name}" references unknown bone ${attachment.localbone}`);
  }
  const boneWorld = invertAffine3x4(bone.poseToBone); // bone-local -> object space

  const localOrigin = [attachment.local[3], attachment.local[7], attachment.local[11]];
  const worldPos = applyMat3x4(boneWorld, localOrigin);
  const pos = xform.pos(worldPos);

  // Object-space rotation = boneWorld(3x3) * attachmentLocal(3x3).
  const objectRot = mulMat3(rot3x3(boneWorld), rot3x3(attachment.local));
  // Only X and Y need to be transformed; orthonormalizeBasis re-derives Z as X-cross-Y, which
  // guarantees a right-handed orthonormal frame even after floating-point drift through xform.nrm.
  const mappedX = xform.nrm(col3(objectRot, 0));
  const mappedY = xform.nrm(col3(objectRot, 1));
  const { x, y, z } = orthonormalizeBasis(mappedX, mappedY);
  const quatMat = [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  const quat = mat3ToQuat(quatMat);
  const qlen = Math.sqrt(quat[0] * quat[0] + quat[1] * quat[1] + quat[2] * quat[2] + quat[3] * quat[3]);
  const unitQuat = qlen > 1e-12 ? quat.map((n) => n / qlen) : quat;

  return { pos, quat: unitQuat };
}

function round(v) {
  return v.map((n) => Math.round(n * 1e5) / 1e5);
}

export function extractAttachments() {
  if (!fs.existsSync(MANIFEST)) throw new Error(`Manifest not found: ${MANIFEST}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));

  const result = {};
  for (const [key, paths] of Object.entries(manifest)) {
    const vpkRel = Array.isArray(paths) ? paths[0] : paths;
    if (!vpkRel) { log(`skip ${key}: no mdl path`); result[key] = {}; continue; }
    const mdlPath = ensureMdl(vpkRel);
    const mdl = parseMDL(mdlPath);
    const xform = rootFrameTransforms(mdl);

    const entry = {};
    for (const attachment of mdl.attachments) {
      if (!(attachment.name.startsWith('unusual') || attachment.name === 'muzzle')) continue;
      const { pos, quat } = attachmentFrame(mdl, xform, attachment);
      entry[attachment.name] = { pos: round(pos), quat: round(quat) };
    }
    result[key] = entry;
    const unusualCount = Object.keys(entry).filter((n) => n.startsWith('unusual')).length;
    log(`${key}: ${unusualCount} unusual attachment(s)${entry.muzzle ? ', muzzle' : ''}`);
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'attachments.json'), JSON.stringify(result, null, 1));
  return result;
}

// ---------------------------------------------------------------------------
// Validation: parse a published GLB's accessors to get its combined bounding box, and assert
// each extracted unusual_* attachment lies within that box expanded by 25%.
// ---------------------------------------------------------------------------

function parseGLBBoundingBox(glbPath) {
  const buf = fs.readFileSync(glbPath);
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${glbPath}: bad GLB magic`);
  let off = 12;
  let json = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'JSON') json = JSON.parse(data.toString('utf8'));
    off += 8 + len;
  }
  if (!json) throw new Error(`${glbPath}: no JSON chunk`);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const acc of json.accessors) {
    if (acc.type !== 'VEC3' || !acc.min || !acc.max) continue;
    for (let i = 0; i < 3; i++) {
      if (acc.min[i] < min[i]) min[i] = acc.min[i];
      if (acc.max[i] > max[i]) max[i] = acc.max[i];
    }
  }
  return { min, max };
}

// Convention check (spec deliverable 1): for c_rocketlauncher's unusual_1, the attachment local
// +X axis (Source "forward") mapped through quat must point roughly along glb +Z or -Z (the
// weapon's long axis) - abs(dot(mappedX, (0,0,1))) > 0.7. Also logs the same for muzzle
// (informational only; not hard-enforced since the spec's MUST-hold formula only names unusual_1).
function checkBasisConvention(attachments) {
  const entry = attachments.c_rocketlauncher;
  if (!entry) { log('  BASIS CHECK SKIP: no c_rocketlauncher in attachments'); return true; }
  let ok = true;
  for (const name of ['unusual_1', 'muzzle']) {
    const a = entry[name];
    if (!a) { log(`  BASIS CHECK SKIP: c_rocketlauncher.${name} missing`); continue; }
    const mappedX = rotateVecByQuat(a.quat, [1, 0, 0]);
    const alongZ = mappedX[2]; // dot(mappedX, (0,0,1))
    const pass = Math.abs(alongZ) > 0.7;
    log(`  BASIS c_rocketlauncher.${name}: local +X -> glb [${mappedX.map((n) => n.toFixed(3)).join(', ')}], dot(+Z)=${alongZ.toFixed(3)} ${pass ? 'OK' : 'FAIL'}`);
    if (name === 'unusual_1' && !pass) ok = false;
  }
  return ok;
}

// Validate a set of weapon keys' unusual_* attachments against their GLB bounding boxes,
// expanded by `marginFrac` (0.25 = 25%) on every axis, and run the c_rocketlauncher basis
// convention check. Returns false (does not throw) on any failure; callers decide whether to throw.
export function validateAgainstGLB(attachments, weaponKeys, modelsDir, marginFrac = 0.25) {
  let allOk = true;
  for (const key of weaponKeys) {
    const glbPath = path.join(modelsDir, `${key}.glb`);
    if (!fs.existsSync(glbPath)) {
      log(`  VALIDATION SKIP ${key}: no glb at ${path.relative(REPO, glbPath)}`);
      continue;
    }
    const { min, max } = parseGLBBoundingBox(glbPath);
    const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    const emin = min.map((v, i) => v - size[i] * marginFrac);
    const emax = max.map((v, i) => v + size[i] * marginFrac);

    const entry = attachments[key] || {};
    const pts = Object.entries(entry).filter(([n]) => n.startsWith('unusual'));
    log(`  ${key}: bbox=[${min.map((n) => n.toFixed(1))}]..[${max.map((n) => n.toFixed(1))}]`);
    for (const [name, a] of pts) {
      const p = a.pos;
      const inside = p.every((c, i) => c >= emin[i] && c <= emax[i]);
      log(`    ${name}=[${p.map((n) => n.toFixed(2))}] ${inside ? 'OK' : 'OUT OF BOUNDS'}`);
      if (!inside) allOk = false;
    }
  }

  log('  -- basis convention check --');
  if (!checkBasisConvention(attachments)) allOk = false;

  return allOk;
}

function main() {
  const attachments = extractAttachments();

  log('\n===== VALIDATION (bbox +/-25%, basis convention) =====');
  const modelsDir = path.join(REPO, 'public', 'data', 'models');
  const ok = validateAgainstGLB(attachments, ['c_rocketlauncher', 'c_flamethrower', 'c_scattergun'], modelsDir, 0.25);
  log(`validation ${ok ? 'PASSED' : 'FAILED'}`);
  log('========================================================\n');
  if (!ok) throw new Error('attachment validation failed (bbox or basis convention) - transform is likely wrong');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
