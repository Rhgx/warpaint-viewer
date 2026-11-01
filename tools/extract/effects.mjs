// TF2 Warpaint Viewer unusual/killstreak effect asset extraction.
//   node tools/extract/effects.mjs
//
// Writes public/data/effects/: sheen/ (mask_strip.png, sheen.json, cubemap/), unusuals/<effectId>/
// <weaponKey>.json (pre-resolved { root, systems } bundles, see lib/unusual-pack.mjs), and
// particles/ (sprite PNGs and index.json).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listVPK, extractBatch, TEXTURES_VPK, MISC_VPK, HL2_TEXTURES_VPK, HL2_MISC_VPK } from '../lib/vpk.mjs';
import { decodeVTFAllFrames, decodeVTFCubemap, parseVTFSpriteSheet } from '../lib/vtf.mjs';
import { encodePNG } from '../lib/png.mjs';
import { parseKV, kvGet } from '../lib/kv.mjs';
import { parsePCF } from '../lib/pcf.mjs';
import { extractAttachments, validateAgainstGLB } from './attachments.mjs';
import { EFFECT_PCF_KEY, buildBundlesForEffect, transitiveClosure } from '../lib/unusual-pack.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const STAGING = path.join(ROOT, 'staging', 'effects');
const OUT = path.join(ROOT, 'public', 'data', 'effects');

function log(...a) { console.log('[effects]', ...a); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

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

function extractMaterialCubemaps(texList) {
  const paths = [...texList].filter((entry) => (
    /^materials\/cubemaps\/[^/]+\.vtf$/.test(entry) && !entry.endsWith('.hdr.vtf')
  )).sort();
  const names = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  const manifest = {};
  let size = 0;
  for (const rel of paths) {
    const ref = path.basename(rel, '.vtf');
    extractBatch(TEXTURES_VPK, [rel], STAGING);
    const faces = decodeVTFCubemap(fs.readFileSync(path.join(STAGING, rel)));
    const materialDir = path.join(OUT, 'material-cubemaps', ref);
    ensureDir(materialDir);
    faces.forEach((face, i) => {
      fs.writeFileSync(path.join(materialDir, `${names[i]}.png`), encodePNG(face.rgba, face.width, face.height));
    });
    if (ref === 'cubemap_sheen001') {
      const sheenDir = path.join(OUT, 'sheen', 'cubemap');
      ensureDir(sheenDir);
      faces.forEach((face, i) => {
        fs.writeFileSync(path.join(sheenDir, `${names[i]}.png`), encodePNG(face.rgba, face.width, face.height));
      });
    }
    size = faces[0].width;
    manifest[`cubemaps/${ref}`] = ref;
    log(`${ref}: 6 faces, ${size}x${size}`);
  }
  fs.writeFileSync(
    path.join(ROOT, 'src', 'viewer', 'stockCubemaps.generated.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { size, count: paths.length };
}

// Structural lists, kept out of the generic attributes bag and surfaced as their own fields.
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

// A PCF's systems form a forest: "_unusual_parent_<weapon>" roots lead to per-weapon effect
// systems whose leaves carry the material and behaviour. roots are the systems no other system
// references; systems maps every definition by name, with children as name references into it.
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

const UNUSUAL_PCFS = ['weapon_unusual_hot', 'weapon_unusual_isotope', 'weapon_unusual_cool', 'weapon_unusual_energyorb', 'item_fx'];

// Every weapon in the manifest: the same set the viewer can request an unusual effect for.
function loadManifestWeaponKeys() {
  const manifestPath = path.join(ROOT, 'public', 'data', 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  return manifest.weapons.map((w) => w.key);
}

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
    let { roots, systems, materials } = buildParticleFile(elements);
    // item_fx holds many unrelated effects; keep only Community Sparkle and its child closure.
    if (name === 'item_fx') {
      systems = transitiveClosure(systems, 'community_sparkle');
      roots = ['community_sparkle'];
      materials = new Set(Object.values(systems).map((system) => system.attributes.material).filter(Boolean));
    }
    for (const m of materials) allMaterials.add(m);
    unusuals[name] = { roots, systems };
    const totalOps = Object.values(systems).reduce((n, s) => n + s.operators.length + s.initializers.length, 0);
    log(`${name}: ${roots.length} weapon roots, ${Object.keys(systems).length} systems, ${totalOps} operator/initializer instances, ${materials.size} unique materials`);
  }

  // One bundle per effect/weapon pair, so the viewer fetches only the bundle it needs.
  const weaponKeys = loadManifestWeaponKeys();
  const unusualsOutDir = path.join(OUT, 'unusuals');
  let bundleCount = 0;
  let fallbackCount = 0;
  let missingChildCount = 0;
  for (const [effectId, pcfKey] of Object.entries(EFFECT_PCF_KEY)) {
    const systems = unusuals[pcfKey].systems;
    if (effectId === 'sparkle') {
      const effectDir = path.join(unusualsOutDir, effectId);
      fs.rmSync(effectDir, { recursive: true, force: true });
      fs.writeFileSync(
        path.join(unusualsOutDir, `${effectId}.json`),
        JSON.stringify({ root: 'community_sparkle', systems }),
      );
      bundleCount++;
      continue;
    }
    const bundles = buildBundlesForEffect(systems, effectId, weaponKeys, (eId, wKey, root, missingName) => {
      missingChildCount++;
      log(`  ${eId}/${wKey}: child "${missingName}" referenced from ${root} is missing from ${pcfKey}'s systems map`);
    });
    const effectDir = path.join(unusualsOutDir, effectId);
    ensureDir(effectDir);
    for (const b of bundles) {
      if (b.fallback) fallbackCount++;
      fs.writeFileSync(path.join(effectDir, `${b.weaponKey}.json`), JSON.stringify({ root: b.root, systems: b.systems }));
      bundleCount++;
    }
  }
  log(`unusual bundles: ${bundleCount} written across ${Object.keys(EFFECT_PCF_KEY).length} effects (${weaponKeys.length} weapon variants plus shared effects) `
    + `(${fallbackCount} used the alphabetical fallback, ${missingChildCount} missing child references)`);

  return { unusuals, materials: allMaterials };
}

function flattenMaterialName(materialRef) {
  return materialRef.replace(/\\/g, '/').replace(/^materials\//i, '').replace(/\.vmt$/i, '')
    .replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

// Materials verified absent from the whole TF2+HL2 install; recorded as { missing: true } in index.json.
const KNOWN_MISSING_MATERIALS = new Set([]);

// Search order for material and texture lookup. The HL2 VPKs are needed: several particle
// materials (vgui/white, smokesprites, fleck_glass3) exist only there.
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

// Resolve a particle material to a vpk-relative .vtf plus the VMT's blend flags. Reads $basetexture
// from the VMT (or $normalmap when absent, as with conc_warp), following a PatchShader insert block.
// With no VMT on disk, falls back to the material path itself as the texture name.
// shader and additive are null when no VMT was found or parsed; a VMT without $additive is additive=false.
// viaNormalMap marks the $normalmap fallback, for logging.
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

// Reduce a vtf.mjs sheet to the index.json shape: clamp and per-frame uv.
function sheetToIndexShape(sheet) {
  return { sequences: sheet.sequences.map((s) => ({ clamp: s.clamp, frames: s.frames.map((f) => f.uv) })) };
}

// Additive VTFs can have a near-black border (fire_embers1 is RGB(10,2,0)) that shows as a faint
// square where quads overlap. A uniform dark border is taken as that floor and rescaled to black.
// Returns { rgba, floor }, or null when the border is not such a floor.
function cleanBackgroundFloor(rgba, width, height) {
  const BORDER_TOLERANCE = 6;
  const FLOOR_MAX_CHANNEL = 24;

  const border = [];
  for (let x = 0; x < width; x++) {
    border.push(x); // top row
    border.push((height - 1) * width + x); // bottom row
  }
  for (let y = 1; y < height - 1; y++) {
    border.push(y * width); // left column
    border.push(y * width + (width - 1)); // right column
  }

  const sum = [0, 0, 0];
  for (const idx of border) {
    const o = idx * 4;
    sum[0] += rgba[o]; sum[1] += rgba[o + 1]; sum[2] += rgba[o + 2];
  }
  const mean = sum.map((s) => s / border.length);
  if (Math.max(...mean) >= FLOOR_MAX_CHANNEL) return null;

  for (const idx of border) {
    const o = idx * 4;
    if (Math.abs(rgba[o] - mean[0]) > BORDER_TOLERANCE
      || Math.abs(rgba[o + 1] - mean[1]) > BORDER_TOLERANCE
      || Math.abs(rgba[o + 2] - mean[2]) > BORDER_TOLERANCE) return null;
  }

  const floor = mean.map((v) => Math.round(v));
  if (floor.every((v) => v === 0)) return null;

  const out = Buffer.from(rgba);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      const v = out[o + c];
      out[o + c] = Math.round(Math.max(0, v - floor[c]) * 255 / (255 - floor[c]));
    }
  }
  return { rgba: out, floor };
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
  for (const materialRef of materials) {
    const resolved = resolveMaterialToVtf(materialRef, sources);
    if (!resolved) {
      fail++;
      if (KNOWN_MISSING_MATERIALS.has(materialRef)) {
        // Explicit entry so the viewer can skip only the render step; the game cannot render this either.
        index[materialRef] = { missing: true };
        log(`  material "${materialRef}" confirmed missing from the TF2 install - recording index.json entry as { missing: true } (no substitute texture, matches Source's own broken reference)`);
      } else {
        log(`  no vtf resolved for material "${materialRef}"`);
      }
      continue;
    }
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

      // Blend/render flags from the VMT. A missing or unparsed VMT defaults to additive (glow effects).
      const additive = resolved.additive === null ? true : resolved.additive;
      const shader = resolved.shader;
      if (resolved.shader === null) {
        noVmtCount++;
        log(`  no VMT found for "${materialRef}" - defaulting additive=true`);
      } else if (!resolved.additive) {
        additiveFalseCount++;
        log(`  additive=false for "${materialRef}" (shader=${shader})`);
      }

      // Only additive materials are floor-scrubbed; a non-additive border is real edge content.
      const outFrames = additive
        ? frames.map((f) => {
          const cleaned = cleanBackgroundFloor(f.rgba, f.width, f.height);
          if (cleaned) {
            log(`  cleaned background floor for "${materialRef}": floor=(${cleaned.floor.join(',')})`);
            return { ...f, rgba: cleaned.rgba };
          }
          return f;
        })
        : frames;

      let entry;
      if (outFrames.length === 1) {
        const { width, height, rgba } = outFrames[0];
        const file = `${flat}.png`;
        fs.writeFileSync(path.join(outDir, file), encodePNG(rgba, width, height));
        entry = { file, frames: 1, width, height };
      } else {
        const { width, height } = outFrames[0];
        const strip = Buffer.alloc(width * height * 4 * outFrames.length);
        outFrames.forEach((f, i) => f.rgba.copy(strip, i * width * height * 4));
        const file = `${flat}.png`;
        fs.writeFileSync(path.join(outDir, file), encodePNG(strip, width, height * outFrames.length));
        entry = { file, frames: outFrames.length, width, height };
      }
      entry.additive = additive;
      entry.shader = shader;

      // VTF 7.3+ sprite-sheet resource (0x10); parseVTFSpriteSheet returns null on any failure.
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
  log(`particle flags: ${additiveFalseCount} additive=false, ${noVmtCount} no-vmt (defaulted additive=true), ${sheetCount} with sprite sheet`);
  return index;
}

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
  const cubemapMeta = extractMaterialCubemaps(texList);
  const { unusuals, materials } = extractUnusuals(miscList);
  const particleIndex = extractParticleTextures(materials, sources);

  log('\nextracting weapon attachment points ...');
  const attachments = extractAttachments();

  log('\n===== VERIFICATION =====');
  const stripPath = path.join(OUT, 'sheen', 'mask_strip.png');
  log(`sheen mask strip exists: ${fs.existsSync(stripPath)}, frames=${sheenMeta.maskFrames}, ${sheenMeta.maskWidth}x${sheenMeta.maskHeight}`);
  const cubeFaces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'].map((n) => path.join(OUT, 'sheen', 'cubemap', `${n}.png`));
  log(`stock material cubemaps: ${cubemapMeta.count}, sheen faces present: ${cubeFaces.filter((p) => fs.existsSync(p)).length}/6, size=${cubemapMeta.size}`);

  let allNonEmpty = true;
  for (const name of UNUSUAL_PCFS) {
    const u = unusuals[name];
    const leafCounts = Object.values(u.systems).reduce((n, s) => n + s.operators.length + s.initializers.length, 0);
    if (!u.roots.length || !leafCounts) allNonEmpty = false;
    log(`unusuals[${name}]: roots=${u.roots.length} systems=${Object.keys(u.systems).length} totalOps/inits=${leafCounts}`);
  }
  log(`unusual pcf data non-empty for all ${UNUSUAL_PCFS.length} systems: ${allNonEmpty}`);

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
