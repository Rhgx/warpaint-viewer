#!/usr/bin/env node
// Validate converted GLB files: reparse, check accessor counts, bbox, normals,
// UVs and triangle counts. Also loads each via three.js GLTFLoader to confirm
// the file is consumable by the app's loader.
//
// Usage: node tools/models/check.mjs [glbPath...]
//        (defaults to every .glb in public/data/models)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

// Weapons genuinely authored with the long axis along +Y (verified against
// MDL bone/vertex data): melee held in the fist with head/blade extending up
// out of the hand. Everything else elongated must lie horizontal (long axis
// X or Z, barrels along +Z).
const VERTICAL_OK = new Set([
  'c_knife', 'c_wrench', 'c_back_scratcher', 'c_battleaxe',
  'c_claidheamohmor', 'c_demo_sultan_sword', 'c_holymackerel',
  'c_jag', 'c_powerjack', 'c_riding_crop',
]);

function parseGLB(buf) {
  if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('bad magic');
  const total = buf.readUInt32LE(8);
  if (total !== buf.length) throw new Error(`length mismatch ${total} != ${buf.length}`);
  let off = 12;
  let json = null, bin = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'JSON') json = JSON.parse(data.toString('utf8'));
    else if (type.startsWith('BIN')) bin = data;
    off += 8 + len;
  }
  return { json, bin };
}

const COMP_SIZE = { 5126: 4, 5125: 4, 5123: 2 };
const TYPE_N = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

function readAccessor(json, bin, idx) {
  const acc = json.accessors[idx];
  const bv = json.bufferViews[acc.bufferView];
  const compSize = COMP_SIZE[acc.componentType];
  const n = TYPE_N[acc.type];
  const start = (bv.byteOffset || 0) + (acc.byteOffset || 0);
  const arr = [];
  for (let i = 0; i < acc.count * n; i++) {
    const p = start + i * compSize;
    let v;
    if (acc.componentType === 5126) v = bin.readFloatLE(p);
    else if (acc.componentType === 5125) v = bin.readUInt32LE(p);
    else v = bin.readUInt16LE(p);
    arr.push(v);
  }
  return { acc, arr, n };
}

async function tryThree(buf) {
  try {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return await new Promise((resolve) => {
      loader.parse(ab, '', (gltf) => {
        let meshes = 0, tris = 0;
        const mats = new Set();
        gltf.scene.traverse((o) => {
          if (o.isMesh) {
            meshes++;
            const g = o.geometry;
            if (g.index) tris += g.index.count / 3;
            if (o.material?.name) mats.add(o.material.name);
          }
        });
        resolve({ ok: true, meshes, tris, mats: [...mats] });
      }, (err) => resolve({ ok: false, err: String(err?.message || err) }));
    });
  } catch (e) {
    return { ok: false, err: 'three load skipped: ' + e.message };
  }
}

async function check(glbPath) {
  const buf = fs.readFileSync(glbPath);
  const { json, bin } = parseGLB(buf);
  const problems = [];
  const notes = [];

  const mesh = json.meshes[0];
  let totalTris = 0, totalVerts = 0;
  let bbMin = [Infinity, Infinity, Infinity], bbMax = [-Infinity, -Infinity, -Infinity];
  let badNormals = 0, normalCount = 0;
  let uvIn = 0, uvOut = 0;

  for (const prim of mesh.primitives) {
    const pos = readAccessor(json, bin, prim.attributes.POSITION);
    const nrm = readAccessor(json, bin, prim.attributes.NORMAL);
    const uv = readAccessor(json, bin, prim.attributes.TEXCOORD_0);
    const idx = readAccessor(json, bin, prim.indices);

    const vcount = pos.acc.count;
    if (nrm.acc.count !== vcount) problems.push(`normal count ${nrm.acc.count} != pos ${vcount}`);
    if (uv.acc.count !== vcount) problems.push(`uv count ${uv.acc.count} != pos ${vcount}`);
    if (idx.acc.count % 3 !== 0) problems.push(`index count ${idx.acc.count} not divisible by 3`);
    // index range
    let maxIdx = 0;
    for (const v of idx.arr) if (v > maxIdx) maxIdx = v;
    if (maxIdx >= vcount) problems.push(`index ${maxIdx} out of range (${vcount} verts)`);

    totalVerts += vcount;
    totalTris += idx.acc.count / 3;

    for (let i = 0; i < pos.arr.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const c = pos.arr[i + k];
        if (c < bbMin[k]) bbMin[k] = c;
        if (c > bbMax[k]) bbMax[k] = c;
      }
    }
    for (let i = 0; i < nrm.arr.length; i += 3) {
      const len = Math.hypot(nrm.arr[i], nrm.arr[i + 1], nrm.arr[i + 2]);
      normalCount++;
      if (Math.abs(len - 1) > 0.02) badNormals++;
    }
    for (let i = 0; i < uv.arr.length; i += 2) {
      const u = uv.arr[i], v = uv.arr[i + 1];
      if (u >= -0.05 && u <= 1.05 && v >= -0.05 && v <= 1.05) uvIn++; else uvOut++;
    }

    // POSITION min/max present
    if (!pos.acc.min || !pos.acc.max) problems.push('POSITION accessor missing min/max');
  }

  const dims = [bbMax[0] - bbMin[0], bbMax[1] - bbMin[1], bbMax[2] - bbMin[2]];
  const maxDim = Math.max(...dims);

  // checks
  if (totalTris <= 500) problems.push(`triangle count ${totalTris} <= 500`);
  const normFrac = badNormals / Math.max(1, normalCount);
  if (normFrac > 0.02) problems.push(`${(normFrac * 100).toFixed(1)}% normals not unit length`);
  const uvFrac = uvIn / Math.max(1, uvIn + uvOut);
  if (uvFrac < 0.6) notes.push(`only ${(uvFrac * 100).toFixed(1)}% UVs in [0,1] (tiling maps ok)`);

  const stem = path.basename(glbPath, '.glb');
  if (stem === 'c_shotgun' && (maxDim < 10 || maxDim > 45)) {
    problems.push(`shotgun maxDim ${maxDim.toFixed(1)} outside 10-45 units`);
  }
  if (maxDim < 3 || maxDim > 500) problems.push(`bbox maxDim ${maxDim.toFixed(1)} implausible`);

  // Orientation: elongated weapons must not stand upright (long axis along Y),
  // except melee verified as authored blade-up in the hand frame.
  const sorted = [...dims].sort((a, b) => b - a);
  const elongated = sorted[0] > 1.4 * sorted[1];
  const longestAxis = dims.indexOf(maxDim); // 0=X 1=Y 2=Z
  if (elongated && longestAxis === 1 && !VERTICAL_OK.has(stem)) {
    problems.push(`elongated model standing upright: long axis is Y, dims [${dims.map((x) => x.toFixed(1))}]`);
  }

  const three = await tryThree(buf);

  console.log(`\n=== ${stem}.glb ===`);
  console.log(`  materials: ${json.materials.map((m) => m.name).join(', ')}`);
  console.log(`  primitives: ${mesh.primitives.length}, tris: ${totalTris}, verts: ${totalVerts}`);
  console.log(`  bbox min [${bbMin.map((x) => x.toFixed(2))}] max [${bbMax.map((x) => x.toFixed(2))}]`);
  console.log(`  dims [${dims.map((x) => x.toFixed(2))}] maxDim ${maxDim.toFixed(2)}`);
  console.log(`  normals unit: ${(100 - normFrac * 100).toFixed(1)}%   UVs in [0,1]: ${(uvFrac * 100).toFixed(1)}%`);
  if (three.ok) console.log(`  three.js load: OK (${three.meshes} mesh, ${three.tris} tris, mats: ${three.mats.join(', ')})`);
  else console.log(`  three.js load: ${three.err}`);
  for (const n of notes) console.log(`  note: ${n}`);
  if (problems.length) {
    console.log(`  FAIL:`);
    for (const p of problems) console.log(`    - ${p}`);
  } else {
    console.log(`  PASS`);
  }
  return problems.length === 0;
}

async function main() {
  let files = process.argv.slice(2);
  if (files.length === 0) {
    const dir = path.join(REPO, 'public/data/models');
    files = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.glb'))
      .sort()
      .map((f) => path.join(dir, f));
  }
  let allPass = true;
  for (const f of files) {
    const ok = await check(path.resolve(REPO, f));
    allPass = allPass && ok;
  }
  console.log(`\n${allPass ? 'ALL PASS' : 'SOME FAILED'}`);
  process.exit(allPass ? 0 : 1);
}

main();
