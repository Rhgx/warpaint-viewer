#!/usr/bin/env node
// mdl2gltf: convert TF2 c_model weapons (MDL v48/49 + VVD + VTX) to GLB.
//
// Usage:
//   node tools/models/mdl2gltf.mjs <vpkRelativeMdlPath...> --out public/data/models
//   node tools/models/mdl2gltf.mjs --from-manifest [--out public/data/models]
//
// Meets DESIGN.md "Models": positions, normals, UV0, indices; one primitive per
// material (material name preserved); LOD0; bodygroup 0; skin 0; Y-up; no textures.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseMDL, resolveMaterialName } from './lib/mdl.mjs';
import { parseVVD } from './lib/vvd.mjs';
import { parseVTX } from './lib/vtx.mjs';
import { buildGLB } from './lib/glb.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');

const TF2 = 'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2';
const VPK_EXE = path.join(TF2, 'bin', 'vpk.exe');
const MISC_VPK = path.join(TF2, 'tf', 'tf2_misc_dir.vpk');
const STAGING = path.join(REPO, 'staging', 'models');
const MANIFEST = path.join(REPO, 'staging', 'weapon_models.json');

// --- CLI parsing ---
function parseArgs(argv) {
  const out = { mdlPaths: [], outDir: null, fromManifest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.outDir = argv[++i];
    else if (a === '--from-manifest') out.fromManifest = true;
    else out.mdlPaths.push(a);
  }
  return out;
}

// Ensure a model's MDL/VVD/VTX triple is present in staging, extracting from the
// VPK if needed. `vpkRel` is like models/weapons/c_models/c_shotgun/c_shotgun.mdl
function ensureExtracted(vpkRel) {
  vpkRel = vpkRel.replace(/\\/g, '/').replace(/^\/+/, '');
  const stem = vpkRel.replace(/\.mdl$/i, '');
  const needed = [`${stem}.mdl`, `${stem}.vvd`, `${stem}.dx90.vtx`];
  const missing = needed.filter((rel) => !fs.existsSync(path.join(STAGING, rel)));
  if (missing.length) {
    // vpk.exe does not create intermediate dirs; pre-create them.
    for (const rel of missing) {
      fs.mkdirSync(path.join(STAGING, path.dirname(rel)), { recursive: true });
    }
    execFileSync(VPK_EXE, ['x', MISC_VPK, ...missing], { cwd: STAGING, stdio: 'pipe' });
  }
  return {
    mdl: path.join(STAGING, `${stem}.mdl`),
    vvd: path.join(STAGING, `${stem}.vvd`),
    vtx: path.join(STAGING, `${stem}.dx90.vtx`),
  };
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
function rootFrameTransforms(mdl) {
  const ptb = mdl.bones[0]?.poseToBone;
  if (!ptb) {
    return { pos: (v) => v, nrm: (v) => v };
  }
  const m = ptb; // row-major 3x4: rows [r0 r1 r2], col 3 = translation
  const pos = (v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
  ];
  const nrm = (v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
  return { pos, nrm };
}

function normalize3(x, y, z) {
  const len = Math.hypot(x, y, z) || 1;
  return [x / len, y / len, z / len];
}

function convert(vpkRel) {
  const files = ensureExtracted(vpkRel);
  const mdl = parseMDL(files.mdl);
  const vvd = parseVVD(files.vvd);
  const vtx = parseVTX(files.vtx);

  if (vvd.checksum !== mdl.checksum) {
    console.warn(`  ! VVD checksum mismatch (mdl=${mdl.checksum} vvd=${vvd.checksum})`);
  }
  if (vtx.checksum !== mdl.checksum) {
    console.warn(`  ! VTX checksum mismatch (mdl=${mdl.checksum} vtx=${vtx.checksum})`);
  }

  const xform = rootFrameTransforms(mdl);

  // Group geometry by resolved material name (one primitive per material).
  // bodygroup 0 => submodel 0 of each bodypart; skin 0 => skin family 0.
  const groups = new Map(); // materialName -> { positions:[], normals:[], uvs:[], indices:[], vmap:Map }
  const materialOrder = [];

  function groupFor(name) {
    let g = groups.get(name);
    if (!g) {
      g = { positions: [], normals: [], uvs: [], indices: [], vmap: new Map() };
      groups.set(name, g);
      materialOrder.push(name);
    }
    return g;
  }

  for (let bp = 0; bp < mdl.bodyparts.length; bp++) {
    const bodypart = mdl.bodyparts[bp];
    const modelIdx = 0; // bodygroup 0
    const model = bodypart.models[modelIdx];
    if (!model || model.numvertices === 0) continue;
    const vtxModel = vtx.bodyparts[bp]?.models[modelIdx];
    if (!vtxModel) continue;

    for (let mi = 0; mi < model.meshes.length; mi++) {
      const mesh = model.meshes[mi];
      const vtxMesh = vtxModel.meshes[mi];
      if (!vtxMesh) continue;
      const matName = resolveMaterialName(mdl, mesh.material, 0);
      const g = groupFor(matName);

      // Global VVD index base for this mesh.
      const meshVertBase = model.vertexStart + mesh.vertexoffset;

      // Emit triangles; dedupe by the global VVD vertex index. VTX's
      // origMeshVertID restarts at zero for every mesh/bodypart, so using it as
      // the material-wide key welded Medigun's separate hose onto vertices 0..
      // of the gun body (and can corrupt any repeated-material bodypart).
      const localOf = (orig) => {
        const globalIdx = meshVertBase + orig;
        let li = g.vmap.get(globalIdx);
        if (li !== undefined) return li;
        const vert = vvd.verts[globalIdx];
        if (!vert) {
          throw new Error(
            `vertex out of range: bp${bp} mesh${mi} orig=${orig} global=${globalIdx} (have ${vvd.verts.length})`,
          );
        }
        const p = xform.pos(vert.pos);
        const n = xform.nrm(vert.normal);
        const nn = normalize3(n[0], n[1], n[2]);
        li = g.positions.length / 3;
        g.positions.push(p[0], p[1], p[2]);
        g.normals.push(nn[0], nn[1], nn[2]);
        g.uvs.push(vert.uv[0], vert.uv[1]);
        g.vmap.set(globalIdx, li);
        return li;
      };

      const tris = vtxMesh.triangles;
      for (let t = 0; t < tris.length; t += 3) {
        g.indices.push(localOf(tris[t]), localOf(tris[t + 1]), localOf(tris[t + 2]));
      }
    }
  }

  // Fix winding: compare geometric normals to shading normals; flip if the
  // majority disagree (keeps glTF CCW front faces regardless of source order).
  for (const [, g] of groups) fixWinding(g);

  // Build GLB primitives.
  const materials = materialOrder.map((name) => ({ name }));
  const primitives = materialOrder.map((name, i) => {
    const g = groups.get(name);
    return {
      material: i,
      positions: new Float32Array(g.positions),
      normals: new Float32Array(g.normals),
      uvs: new Float32Array(g.uvs),
      indices: new Uint32Array(g.indices),
    };
  });

  const stem = path.basename(vpkRel).replace(/\.mdl$/i, '');
  const glb = buildGLB({
    primitives,
    materials,
    meta: { name: stem, extras: { sourceModel: mdl.name, materials: materialOrder } },
  });

  const stats = {
    materials: materialOrder,
    vertexCount: primitives.reduce((s, p) => s + p.positions.length / 3, 0),
    triangleCount: primitives.reduce((s, p) => s + p.indices.length / 3, 0),
    bones: mdl.bones.length,
    multiBoneWeighted: countMultiBone(vvd),
  };
  return { glb, stats, stem };
}

function countMultiBone(vvd) {
  let n = 0;
  for (const v of vvd.verts) if (v.numbones > 1) n++;
  return n;
}

function fixWinding(g) {
  let agree = 0, disagree = 0;
  const P = g.positions, N = g.normals, I = g.indices;
  const step = Math.max(3, Math.floor(I.length / 3 / 500) * 3); // sample up to ~500 tris
  for (let t = 0; t + 2 < I.length; t += step) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
    const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
    const cx = P[c * 3], cy = P[c * 3 + 1], cz = P[c * 3 + 2];
    const e1 = [bx - ax, by - ay, bz - az];
    const e2 = [cx - ax, cy - ay, cz - az];
    const gx = e1[1] * e2[2] - e1[2] * e2[1];
    const gy = e1[2] * e2[0] - e1[0] * e2[2];
    const gz = e1[0] * e2[1] - e1[1] * e2[0];
    // average shading normal
    const sx = N[a * 3] + N[b * 3] + N[c * 3];
    const sy = N[a * 3 + 1] + N[b * 3 + 1] + N[c * 3 + 1];
    const sz = N[a * 3 + 2] + N[b * 3 + 2] + N[c * 3 + 2];
    const dot = gx * sx + gy * sy + gz * sz;
    if (dot >= 0) agree++; else disagree++;
  }
  if (disagree > agree) {
    for (let t = 0; t + 2 < I.length; t += 3) {
      const tmp = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = tmp;
    }
    return true;
  }
  return false;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const outDir = path.resolve(REPO, args.outDir || 'public/data/models');
  fs.mkdirSync(outDir, { recursive: true });

  let jobs = []; // { outName, mdlPath }
  if (args.fromManifest) {
    if (!fs.existsSync(MANIFEST)) {
      console.error(`Manifest not found: ${MANIFEST}`);
      process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    for (const [key, paths] of Object.entries(manifest)) {
      const first = Array.isArray(paths) ? paths[0] : paths;
      if (!first) { console.warn(`skip ${key}: no mdl path`); continue; }
      jobs.push({ outName: key, mdlPath: first });
    }
  } else {
    if (args.mdlPaths.length === 0) {
      console.error('No MDL paths given. Use <mdlPath...> or --from-manifest.');
      process.exit(1);
    }
    for (const p of args.mdlPaths) {
      const stem = path.basename(p).replace(/\.mdl$/i, '');
      jobs.push({ outName: stem, mdlPath: p });
    }
  }

  let failures = 0;
  for (const job of jobs) {
    try {
      console.log(`Converting ${job.mdlPath} -> ${job.outName}.glb`);
      const { glb, stats } = convert(job.mdlPath);
      const outPath = path.join(outDir, `${job.outName}.glb`);
      fs.writeFileSync(outPath, glb);
      console.log(
        `  ok: ${stats.triangleCount} tris, ${stats.vertexCount} verts, ` +
        `${stats.materials.length} material(s), ${stats.bones} bones, ` +
        `${stats.multiBoneWeighted} multi-bone verts`,
      );
      console.log(`  materials: ${stats.materials.join(', ')}`);
      console.log(`  wrote ${path.relative(REPO, outPath)} (${glb.length} bytes)`);
    } catch (err) {
      failures++;
      console.error(`  FAILED ${job.mdlPath}: ${err.message}`);
    }
  }
  if (failures) process.exit(1);
}

main();
