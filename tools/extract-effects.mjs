// TF2 Warpaint Viewer - unusual/killstreak effect asset extraction.
//   node tools/extract-effects.mjs
//
// Produces:
//   public/data/effects/sheen/mask_strip.png   (killstreak sheen mask frames, stacked vertically)
//   public/data/effects/sheen/sheen.json       ({ maskFrames, maskWidth, maskHeight })
//   public/data/effects/sheen/cubemap/{px,nx,py,ny,pz,nz}.png
//   public/data/effects/unusuals.json          (parsed weapon_unusual_*.pcf particle definitions)
//   public/data/effects/particles/<flat-name>.png
//   public/data/effects/particles/index.json   (materialPath -> { file, frames, width, height })

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listVPK, extractBatch, TEXTURES_VPK, MISC_VPK, HL2_TEXTURES_VPK, HL2_MISC_VPK } from './lib/vpk.mjs';
import { decodeVTFAllFrames, decodeVTFCubemap, parseVTFSpriteSheet } from './lib/vtf.mjs';
import { encodePNG } from './lib/png.mjs';
import { parseKV, kvGet } from './lib/kv.mjs';
import { parsePCF } from './lib/pcf.mjs';
import { extractAttachments, validateAgainstGLB } from './extract-attachments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STAGING = path.join(ROOT, 'staging', 'effects');
const OUT = path.join(ROOT, 'public', 'data', 'effects');

function log(...a) { console.log('[effects]', ...a); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// ---------------------------------------------------------------------------
// 1. Killstreak sheen mask frames -> vertical sprite strip PNG.
// ---------------------------------------------------------------------------

function extractSheenMask(texList, miscList) {
  const rel = 'materials/effects/animatedsheen/animatedsheen0.vtf';
  const src = texList.has(rel) ? TEXTURES_VPK : (miscList.has(rel) ? MISC_VPK : null);
  if (!src) throw new Error(`sheen mask not found in either vpk: ${rel}`);
  extractBatch(src, [rel], STAGING);
  const buf = fs.readFileSync(path.join(STAGING, rel));
  const frames = decodeVTFAllFrames(buf);
  const { width, height } = frames[0];
  const strip = Buffer.alloc(width * height * 4 * frames.length);
  frames.forEach((f, i) => f.rgba.copy(strip, i * width * height * 4));

  const outDir = path.join(OUT, 'sheen');
  ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, 'mask_strip.png'), encodePNG(strip, width, height * frames.length));
  const meta = { maskFrames: frames.length, maskWidth: width, maskHeight: height };
  fs.writeFileSync(path.join(outDir, 'sheen.json'), JSON.stringify(meta, null, 1));
  log(`sheen mask: ${frames.length} frames, ${width}x${height} -> sheen/mask_strip.png`);
  return meta;
}

// ---------------------------------------------------------------------------
// 2. Sheen cubemap -> 6 face PNGs.
// ---------------------------------------------------------------------------

function extractSheenCubemap(texList) {
  const rel = 'materials/cubemaps/cubemap_sheen001.vtf';
  if (!texList.has(rel)) throw new Error(`sheen cubemap not found: ${rel}`);
  extractBatch(TEXTURES_VPK, [rel], STAGING);
  const buf = fs.readFileSync(path.join(STAGING, rel));
  const faces = decodeVTFCubemap(buf);
  const names = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  const outDir = path.join(OUT, 'sheen', 'cubemap');
  ensureDir(outDir);
  faces.forEach((face, i) => {
    fs.writeFileSync(path.join(outDir, `${names[i]}.png`), encodePNG(face.rgba, face.width, face.height));
  });
  log(`sheen cubemap: 6 faces, ${faces[0].width}x${faces[0].height} -> sheen/cubemap/{${names.join(',')}}.png`);
  return { size: faces[0].width };
}

// ---------------------------------------------------------------------------
// 3. Weapon unusual particle definitions.
// ---------------------------------------------------------------------------

// Attributes that describe structure (child/operator lists) rather than plain particle-system
// parameters; kept out of the generic "attributes" bag and surfaced through their own fields.
const STRUCTURAL_KEYS = new Set([
  'renderers', 'operators', 'initializers', 'emitters', 'forces', 'constraints',
  'children', 'preventNameBasedLookup',
]);

function serializeParamValue(v) {
  if (v === null) return null; // element-typed attribute with no reference (index -1)
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(serializeParamValue).filter((x) => x !== undefined);
  if (typeof v === 'object') {
    if (Object.prototype.hasOwnProperty.call(v, 'binary')) return undefined; // skip binary blobs
    if (Object.prototype.hasOwnProperty.call(v, 'attributes')) return v.name; // stray element ref -> its name
    return v;
  }
  return v; // number, string, boolean
}

function buildFunctionList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const op of arr) {
    if (!op || typeof op !== 'object' || !op.attributes) continue;
    const params = {};
    for (const [k, val] of Object.entries(op.attributes)) {
      if (k === 'functionName') continue;
      const sv = serializeParamValue(val);
      if (sv !== undefined) params[k] = sv;
    }
    out.push({ functionName: typeof op.attributes.functionName === 'string' ? op.attributes.functionName : op.name, params });
  }
  return out;
}

// A .pcf's particle system definitions form a forest: each weapon category has a
// "_unusual_parent_<weapon>" root whose sole child is "weapon_unusual_<effect>_<weapon>", which
// in turn has several leaf children (the glow/embers/etc. systems that actually carry material,
// color, and particle behavior). There is no single system named e.g. "weapon_unusual_hot" in
// the file - the effect is authored per weapon. `roots` lists the true entry points (systems
// never referenced as another system's child); `systems` is every DmeParticleSystemDefinition in
// the file, keyed by name, fully resolved and self-contained (children are name references into
// this same map) so a consumer can walk any root down to its leaves.
function buildParticleFile(elements) {
  const defs = elements.filter((e) => e.type === 'DmeParticleSystemDefinition');

  const referenced = new Set();
  for (const d of defs) {
    const childArr = d.attributes.children;
    if (!Array.isArray(childArr)) continue;
    for (const childWrapper of childArr) {
      const target = childWrapper?.attributes?.child;
      if (target?.name) referenced.add(target.name);
    }
  }
  const roots = defs.filter((d) => !referenced.has(d.name)).map((d) => d.name);

  const systems = {};
  const materials = new Set();
  for (const d of defs) {
    const attributes = {};
    for (const [k, val] of Object.entries(d.attributes)) {
      if (STRUCTURAL_KEYS.has(k)) continue;
      const sv = serializeParamValue(val);
      if (sv !== undefined) attributes[k] = sv;
    }
    if (typeof attributes.material === 'string' && attributes.material) {
      attributes.material = attributes.material.replace(/\\/g, '/');
      materials.add(attributes.material);
    }

    const childArr = d.attributes.children;
    const children = Array.isArray(childArr)
      ? childArr.map((c) => c?.attributes?.child?.name).filter(Boolean)
      : [];

    systems[d.name] = {
      attributes,
      children,
      initializers: buildFunctionList(d.attributes.initializers),
      operators: buildFunctionList(d.attributes.operators),
      emitters: buildFunctionList(d.attributes.emitters),
      renderers: buildFunctionList(d.attributes.renderers),
      forces: buildFunctionList(d.attributes.forces),
      constraints: buildFunctionList(d.attributes.constraints),
    };
  }

  return { roots, systems, materials };
}

const UNUSUAL_PCFS = ['weapon_unusual_hot', 'weapon_unusual_isotope', 'weapon_unusual_cool', 'weapon_unusual_energyorb'];

function extractUnusuals(miscList) {
  const rels = UNUSUAL_PCFS.map((n) => `particles/${n}.pcf`);
  const missing = rels.filter((r) => !miscList.has(r));
  if (missing.length) throw new Error(`unusual pcf(s) not found in misc vpk: ${missing.join(', ')}`);
  extractBatch(MISC_VPK, rels, STAGING);

  const unusuals = {};
  const allMaterials = new Set();
  for (const name of UNUSUAL_PCFS) {
    const buf = fs.readFileSync(path.join(STAGING, 'particles', `${name}.pcf`));
    const { elements } = parsePCF(buf);
    const { roots, systems, materials } = buildParticleFile(elements);
    for (const m of materials) allMaterials.add(m);
    unusuals[name] = { roots, systems };
    const totalOps = Object.values(systems).reduce((n, s) => n + s.operators.length + s.initializers.length, 0);
    log(`${name}: ${roots.length} weapon roots, ${Object.keys(systems).length} systems, ${totalOps} operator/initializer instances, ${materials.size} unique materials`);
  }

  ensureDir(OUT);
  fs.writeFileSync(path.join(OUT, 'unusuals.json'), JSON.stringify(unusuals, null, 1));
  return { unusuals, materials: allMaterials };
}

// ---------------------------------------------------------------------------
// 4. Particle sprite textures referenced by the unusual definitions' "material" attributes.
// ---------------------------------------------------------------------------

function flattenMaterialName(materialRef) {
  return materialRef.replace(/\\/g, '/').replace(/^materials\//i, '').replace(/\.vmt$/i, '')
    .replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

// weapon_unusual_cool's water swirl systems (weapon_unusual_water_*_swirls) reference
// "effects/workshop/water_unusual/circle_half.vmt". It genuinely does not exist anywhere in the
// TF2 install: searched tf2_misc_dir.vpk, tf2_textures_dir.vpk, hl2_misc_dir.vpk,
// hl2_textures_dir.vpk, platform_misc_dir.vpk (listed + grepped for "circle_half",
// "water_unusual", "workshop.*circle", "unusual.*circle"), and loose files under tf/materials,
// tf/download, tf/custom, tf/custom_disabled, tf/disabled_addons. No hit anywhere - it looks like
// an asset Valve removed or renamed after authoring this particle system. "effects/circle2.vmt"
// (materials/effects/circle2.vmt + .vtf) does exist and is visually the closest available material
// (a soft circular glow/blob, same family as the other workshop "circleN" swirl materials), so it
// is used as the fallback texture. This is a deliberate substitution, not a resolver bug - it is
// logged loudly below and the index.json entry for the missing material is a real, working entry
// backed by circle2's pixels rather than being silently dropped.
const MATERIAL_FALLBACKS = {
  'effects/workshop/water_unusual/circle_half.vmt': 'effects/circle2.vmt',
};

// Ordered VPK search list threaded through material/texture resolution: TF2 misc, TF2 textures,
// then the HL2 base-game VPKs TF2 mounts (hl2/hl2_misc_dir.vpk, hl2/hl2_textures_dir.vpk). Several
// particle materials referenced by the unusual effects (particle/smokesprites_0001, vgui/white,
// effects/fleck_glass3) are HL2 base content with no TF2-local copy and only resolve once HL2 is
// searched too.
function buildVpkSources(texList, miscList, hl2TexList, hl2MiscList) {
  return [
    { vpk: MISC_VPK, list: miscList, label: 'tf2 misc' },
    { vpk: TEXTURES_VPK, list: texList, label: 'tf2 textures' },
    { vpk: HL2_MISC_VPK, list: hl2MiscList, label: 'hl2 misc' },
    { vpk: HL2_TEXTURES_VPK, list: hl2TexList, label: 'hl2 textures' },
  ];
}

// First source (in priority order) whose file listing contains relPath, or null.
function findInSources(relPath, sources) {
  for (const s of sources) if (s.list.has(relPath)) return s;
  return null;
}

// Resolve a particle "material" attribute (e.g. "effects\\fire_embers1.vmt" or "vgui/white") to a
// vpk-relative .vtf path, plus the VMT's blend/shader flags. Prefers reading $basetexture out of
// the material's .vmt (following a PatchShader's "insert" block if present); a few materials (e.g.
// effects/conc_warp, a refract/heat-warp shader) carry no $basetexture at all, only $normalmap, so
// that is tried next as the best available texture. Several particle materials referenced by these
// pcf files have no .vmt on disk anywhere in TF2+HL2 (removed/consolidated assets), so this finally
// falls back to treating the material's own path as the texture name, which is a common Source
// convention and matches several of the missing-vmt cases actually seen in these files.
//
// Returns { vtfRel, src, shader, additive, viaNormalMap } where shader/additive are null when no
// .vmt could be found or parsed at all (distinct from a .vmt that was found but omits $additive,
// which means additive is false per Source's default). Callers apply the conservative additive:true
// default for the "vmt not found" case per the effects spec (glow effects should default to
// additive). viaNormalMap flags the conc_warp-style case for logging.
function resolveMaterialToVtf(materialRef, sources) {
  const norm = materialRef.replace(/\\/g, '/').replace(/^materials\//i, '').replace(/\.vmt$/i, '');
  const vmtRel = `materials/${norm}.vmt`.toLowerCase();
  const vmtSrc = findInSources(vmtRel, sources);
  let shader = null;
  let additive = null;
  if (vmtSrc) {
    extractBatch(vmtSrc.vpk, [vmtRel], STAGING);
    try {
      const text = fs.readFileSync(path.join(STAGING, vmtRel), 'utf8');
      const kv = parseKV(text);
      const shaderKey = Object.keys(kv)[0];
      let body = kv[shaderKey] || {};
      const insert = kvGet(body, 'insert');
      if (insert && typeof insert === 'object') body = { ...body, ...insert };
      shader = shaderKey;
      const additiveRaw = kvGet(body, '$additive');
      additive = additiveRaw !== undefined && parseFloat(additiveRaw) !== 0;

      const baseTexture = kvGet(body, '$basetexture');
      const normalMap = !baseTexture ? kvGet(body, '$normalmap') : undefined;
      const texRef = baseTexture || normalMap;
      if (texRef) {
        const btNorm = String(texRef).replace(/\\/g, '/').replace(/^materials\//i, '').replace(/\.(vtf|tga|psd)$/i, '');
        const vtfRel = `materials/${btNorm}.vtf`.toLowerCase();
        const vtfSrc = findInSources(vtfRel, sources);
        if (vtfSrc) return { vtfRel, src: vtfSrc.vpk, shader, additive, viaNormalMap: !baseTexture, srcLabel: vtfSrc.label };
      }
    } catch (e) {
      log(`  warning: failed to parse VMT ${vmtRel}: ${e.message}`);
      shader = null;
      additive = null;
    }
  }
  // Fallback: the material path itself, as a .vtf.
  const directRel = `materials/${norm}.vtf`.toLowerCase();
  const directSrc = findInSources(directRel, sources);
  if (directSrc) return { vtfRel: directRel, src: directSrc.vpk, shader, additive, srcLabel: directSrc.label };
  return null;
}

// Convert a validated vtf.mjs sheet ({ version, sequences: [{ sequenceNumber, clamp, totalTime,
// frames: [{displayTime, uv}] }] }) into the index.json "sheet" shape: just clamp + uv per frame.
function sheetToIndexShape(sheet) {
  return { sequences: sheet.sequences.map((s) => ({ clamp: s.clamp, frames: s.frames.map((f) => f.uv) })) };
}

function extractParticleTextures(materials, sources) {
  const outDir = path.join(OUT, 'particles');
  ensureDir(outDir);
  const index = {};
  let ok = 0;
  let fail = 0;
  let additiveFalseCount = 0;
  let noVmtCount = 0;
  let sheetCount = 0;
  let fallbackCount = 0;
  for (const materialRef of materials) {
    let resolved = resolveMaterialToVtf(materialRef, sources);
    if (!resolved && MATERIAL_FALLBACKS[materialRef]) {
      const fallbackRef = MATERIAL_FALLBACKS[materialRef];
      const fallbackResolved = resolveMaterialToVtf(fallbackRef, sources);
      if (fallbackResolved) {
        log(`  material "${materialRef}" not found anywhere in the TF2 install (searched tf2/hl2/platform vpks + loose files) - using documented fallback "${fallbackRef}"`);
        resolved = fallbackResolved;
        fallbackCount++;
      }
    }
    if (!resolved) { fail++; log(`  no vtf resolved for material "${materialRef}"`); continue; }
    if (resolved.srcLabel && resolved.srcLabel.startsWith('hl2')) {
      log(`  "${materialRef}" resolved from ${resolved.srcLabel}${resolved.viaNormalMap ? ' (via $normalmap, no $basetexture)' : ''}`);
    } else if (resolved.viaNormalMap) {
      log(`  "${materialRef}" resolved via $normalmap (no $basetexture)`);
    }
    extractBatch(resolved.src, [resolved.vtfRel], STAGING);
    try {
      const buf = fs.readFileSync(path.join(STAGING, resolved.vtfRel));
      const frames = decodeVTFAllFrames(buf);
      const flat = flattenMaterialName(materialRef);

      // Deliverable 2: blend/render flags from the VMT. Conservative additive:true default when
      // no .vmt could be found/parsed at all, per spec (these are all glow-type effects).
      const additive = resolved.additive === null ? true : resolved.additive;
      const shader = resolved.shader;
      if (resolved.shader === null) {
        noVmtCount++;
        log(`  no VMT found for "${materialRef}" - defaulting additive=true`);
      } else if (!resolved.additive) {
        additiveFalseCount++;
        log(`  additive=false for "${materialRef}" (shader=${shader})`);
      }

      let entry;
      if (frames.length === 1) {
        const { width, height, rgba } = frames[0];
        const file = `${flat}.png`;
        fs.writeFileSync(path.join(outDir, file), encodePNG(rgba, width, height));
        entry = { file, frames: 1, width, height };
      } else {
        const { width, height } = frames[0];
        const strip = Buffer.alloc(width * height * 4 * frames.length);
        frames.forEach((f, i) => f.rgba.copy(strip, i * width * height * 4));
        const file = `${flat}.png`;
        fs.writeFileSync(path.join(outDir, file), encodePNG(strip, width, height * frames.length));
        entry = { file, frames: frames.length, width, height };
      }
      entry.additive = additive;
      entry.shader = shader;

      // Deliverable 3: embedded sprite-sheet resource (VTF 7.3+ resource 0x10). vtf.mjs already
      // validates uv in [0,1] and sequenceCount in [1,64], returning null on any failure - treat
      // that identically to "no sheet".
      const sheet = parseVTFSpriteSheet(buf);
      if (sheet) {
        entry.sheet = sheetToIndexShape(sheet);
        sheetCount++;
        const frameCount = sheet.sequences.reduce((n, s) => n + s.frames.length, 0);
        log(`  sheet for "${materialRef}": ${sheet.sequences.length} sequence(s), ${frameCount} frame(s) total`);
      }

      index[materialRef] = entry;
      ok++;
    } catch (e) {
      fail++;
      log(`  failed to decode ${resolved.vtfRel}: ${e.message}`);
    }
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), JSON.stringify(index, null, 1));
  log(`particle sprites: ${ok} written, ${fail} unresolved (of ${materials.size} unique materials)`);
  log(`particle flags: ${additiveFalseCount} additive=false, ${noVmtCount} no-vmt (defaulted additive=true), ${sheetCount} with sprite sheet, ${fallbackCount} using a documented fallback material`);
  return index;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  ensureDir(OUT);
  ensureDir(STAGING);

  log('indexing vpk contents ...');
  const texList = listVPK(TEXTURES_VPK);
  const miscList = listVPK(MISC_VPK);
  const hl2TexList = listVPK(HL2_TEXTURES_VPK);
  const hl2MiscList = listVPK(HL2_MISC_VPK);
  const sources = buildVpkSources(texList, miscList, hl2TexList, hl2MiscList);

  const sheenMeta = extractSheenMask(texList, miscList);
  const cubemapMeta = extractSheenCubemap(texList);
  const { unusuals, materials } = extractUnusuals(miscList);
  const particleIndex = extractParticleTextures(materials, sources);

  log('\nextracting weapon attachment points ...');
  const attachments = extractAttachments();

  // ---- verification -------------------------------------------------------
  log('\n===== VERIFICATION =====');
  const stripPath = path.join(OUT, 'sheen', 'mask_strip.png');
  log(`sheen mask strip exists: ${fs.existsSync(stripPath)}, frames=${sheenMeta.maskFrames}, ${sheenMeta.maskWidth}x${sheenMeta.maskHeight}`);
  const cubeFaces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((n) => path.join(OUT, 'sheen', 'cubemap', `${n}.png`));
  log(`cubemap faces present: ${cubeFaces.filter((p) => fs.existsSync(p)).length}/6, size=${cubemapMeta.size}`);

  let allNonEmpty = true;
  for (const name of UNUSUAL_PCFS) {
    const u = unusuals[name];
    const leafCounts = Object.values(u.systems).reduce((n, s) => n + s.operators.length + s.initializers.length, 0);
    if (!u.roots.length || !leafCounts) allNonEmpty = false;
    log(`unusuals.json[${name}]: roots=${u.roots.length} systems=${Object.keys(u.systems).length} totalOps/inits=${leafCounts}`);
  }
  log(`unusuals.json non-empty for all 4 systems: ${allNonEmpty}`);

  const particleFiles = Object.values(particleIndex);
  log(`particle sprite PNGs written: ${particleFiles.length}`);

  const attachmentWeaponCount = Object.keys(attachments).length;
  log(`attachments.json: ${attachmentWeaponCount} weapon(s)`);
  const modelsDir = path.join(ROOT, 'public', 'data', 'models');
  const bboxOk = validateAgainstGLB(attachments, ['c_rocketlauncher', 'c_flamethrower', 'c_scattergun'], modelsDir, 0.25);
  log(`attachment bbox validation: ${bboxOk ? 'PASSED' : 'FAILED'}`);
  log('========================\n');

  if (!allNonEmpty) throw new Error('one or more unusual pcf systems parsed with empty operators/initializers - parser is likely wrong');
  if (!particleFiles.length) throw new Error('no particle sprite PNGs were written');
  if (!attachmentWeaponCount) throw new Error('attachments.json is empty');
  if (!bboxOk) throw new Error('attachment bbox validation failed - transform is likely wrong');
}

main();
