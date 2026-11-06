#!/usr/bin/env node
// From client.dll and items_game.txt: paintkit_base names the model in weapon_uses_stattrak_module.
// Its one bone, c_weapon_stattrack, is bone-merged onto the weapon's bone of that name.
// weapon_stattrak_module_scale in the weapon's prefab sets its size, and a weapon without one gets 1.
// The world model keeps bodygroup Face at 0. Only a flipped viewmodel uses the other, mirrored one.
// Skins 0 and 1 are RED and BLU. 2 and 3 are the same with a cracked skull, for a weapon held by someone else.
// Six meshes draw the digits, one material each, and StatTrakDigit picks the frame of the rolling dial.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { readItemsGameKV } from '../lib/items-game.mjs';
import { kvGet } from '../lib/kv.mjs';
import { decodeVTFAllFrames } from '../lib/vtf.mjs';
import { extractBatch, MISC_VPK, TEXTURES_VPK } from '../lib/vpk.mjs';
import { invertAffine3x4, multiplyAffine3x4, parseMDL } from '../models/lib/mdl.mjs';
import { parseMaterialBody, readVmtBody } from './materials.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGING = path.join(ROOT, 'staging', 'stat-clock');
const MODELS_STAGING = path.join(ROOT, 'staging', 'models');
const MANIFEST = path.join(ROOT, 'staging', 'weapon_models.json');
const OUT = path.join(ROOT, 'public', 'data', 'stat-clock');

const CLOCK_MODEL = 'models/weapons/c_models/stattrack.mdl';
const CLOCK_BONE = 'c_weapon_stattrack';
const CRAFTING = 'materials/models/player/items/crafting';
const DIAL = 'materials/models/weapons/stattrack/stattrack_dial';
const LINES = 'materials/models/weapons/c_items/stattracker_lines';
const LIGHTWARP = 'materials/models/buildables/sentry1/sentry1_lightwarp';
const DATA_PREFIX = 'stat-clock/';

const log = (...args) => console.log('[stat-clock]', ...args);
const round = (values) => values.map((value) => Math.round(value * 1e5) / 1e5);

function stringList(value) {
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function fromItemOrPrefabs(item, prefabs, read) {
  const own = read(item);
  if (own !== undefined) return own;
  for (const name of stringList(kvGet(item, 'prefab'))) {
    const prefab = kvGet(prefabs, name);
    const inherited = prefab && fromItemOrPrefabs(prefab, prefabs, read);
    if (inherited !== undefined) return inherited;
  }
  return undefined;
}

function staticAttr(name) {
  return (item) => {
    const attrs = kvGet(item, 'static_attrs');
    return attrs ? kvGet(attrs, name) : undefined;
  };
}

/** Only items that use the clock count: others sharing the model name no size. A model with two sizes is refused, not guessed at. */
function clockScales() {
  const { items, prefabs } = kvGet(readItemsGameKV(), 'items_game');
  const scales = new Map();
  for (const item of Object.values(items)) {
    if (!item || typeof item !== 'object') continue;
    const model = fromItemOrPrefabs(item, prefabs, (entry) => {
      const value = kvGet(entry, 'model_player');
      return typeof value === 'string' ? value : undefined;
    });
    if (!model || !fromItemOrPrefabs(item, prefabs, staticAttr('weapon_uses_stattrak_module'))) continue;
    // CALL_ATTRIB_HOOK_FLOAT's default in the client is 1.
    const scale = Number(fromItemOrPrefabs(item, prefabs, staticAttr('weapon_stattrak_module_scale')) ?? 1);
    const key = model.replaceAll(String.fromCharCode(92), '/').toLowerCase();
    if (!scales.has(key)) scales.set(key, new Set());
    scales.get(key).add(scale);
  }
  return scales;
}

/** Row-major rotation to [x, y, z, w], which the bind pose keeps free of scale. */
function quaternionOf(m) {
  const [m00, m01, m02, , m10, m11, m12, , m20, m21, m22] = m;
  const trace = m00 + m11 + m22;
  let quaternion;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    quaternion = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    quaternion = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    quaternion = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    quaternion = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  const length = Math.hypot(...quaternion);
  return quaternion.map((value) => value / length);
}

/** The clock's bone in the published GLB's frame, which is the root bone's frame (see rootFrameTransforms). */
function placementsByWeapon() {
  const weaponModels = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const scales = clockScales();
  const placements = {};
  const without = [];
  for (const [weaponKey, paths] of Object.entries(weaponModels)) {
    const vpkPath = (Array.isArray(paths) ? paths[0] : paths)?.replaceAll(String.fromCharCode(92), '/');
    if (!vpkPath) throw new Error(`no model for ${weaponKey}`);
    const mdlPath = path.join(MODELS_STAGING, vpkPath);
    if (!fs.existsSync(mdlPath)) extractBatch(MISC_VPK, [vpkPath], MODELS_STAGING);
    const mdl = parseMDL(mdlPath);
    const bone = mdl.bones.find((entry) => entry.name === CLOCK_BONE);
    const sizes = scales.get(vpkPath.toLowerCase());
    if (!bone || !sizes) {
      without.push(weaponKey);
      continue;
    }
    if (sizes.size !== 1) throw new Error(`${weaponKey} has more than one clock size: ${[...sizes].join(', ')}`);
    const matrix = multiplyAffine3x4(mdl.bones[0].poseToBone, invertAffine3x4(bone.poseToBone));
    placements[weaponKey] = {
      pos: round([matrix[3], matrix[7], matrix[11]]),
      quat: round(quaternionOf(matrix)),
      scale: [...sizes][0],
    };
  }
  return { placements, without };
}

function decoded(vtfPath) {
  return decodeVTFAllFrames(fs.readFileSync(path.join(STAGING, vtfPath)));
}

/** Lossy, keeping the colour under transparent pixels: alpha here is a specular mask, not transparency. */
async function writeMap(frames, name, { lossless = false, quality = 88 } = {}) {
  const { width, height } = frames[0];
  const pixels = Buffer.concat(frames.map((frame) => frame.rgba));
  const image = sharp(pixels, { raw: { width, height: height * frames.length, channels: 4 } });
  await image.webp(lossless ? { lossless: true, effort: 6, exact: true } : { quality, alphaQuality: 100, effort: 6, exact: true, smartSubsample: true })
    .toFile(path.join(OUT, name));
  return `${DATA_PREFIX}${name}`;
}

function scrollOf(vmtBody) {
  const scroll = kvGet(kvGet(vmtBody, 'proxies') ?? {}, 'texturescroll') ?? {};
  return {
    detailScrollRate: Number(kvGet(scroll, 'texturescrollrate') ?? 0),
    detailScrollAngle: Number(kvGet(scroll, 'texturescrollangle') ?? 0),
  };
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(STAGING, { recursive: true });

  const vmts = [`${CRAFTING}/stat_clock.vmt`, `${CRAFTING}/stat_clock_red_happy.vmt`, `${DIAL}000.vmt`];
  extractBatch(MISC_VPK, vmts, STAGING);
  const vtfs = [
    `${CRAFTING}/stat_clock.vtf`, `${CRAFTING}/stat_clock_blue.vtf`,
    `${CRAFTING}/stat_clock_red_happy.vtf`, `${CRAFTING}/stat_clock_blue_happy.vtf`,
    `${DIAL}.vtf`, `${LINES}.vtf`, `${LIGHTWARP}.vtf`,
  ];
  extractBatch(TEXTURES_VPK, vtfs, STAGING);

  execFileSync(process.execPath, [path.join(ROOT, 'tools/models/mdl2gltf.mjs'), CLOCK_MODEL, '--out', 'public/data/stat-clock'], { cwd: ROOT, stdio: 'inherit' });
  fs.renameSync(path.join(OUT, 'stattrack.glb'), path.join(OUT, 'clock.glb'));

  const dialFrames = decoded(`${DIAL}.vtf`);
  const [dial, lines, lightwarp, bodyRed, bodyBlu, faceRed, faceBlu] = await Promise.all([
    writeMap(dialFrames, 'dial.webp'),
    writeMap(decoded(`${LINES}.vtf`), 'lines.webp', { lossless: true }),
    writeMap(decoded(`${LIGHTWARP}.vtf`), 'lightwarp.webp', { lossless: true }),
    writeMap(decoded(`${CRAFTING}/stat_clock.vtf`), 'body_red.webp'),
    writeMap(decoded(`${CRAFTING}/stat_clock_blue.vtf`), 'body_blu.webp'),
    writeMap(decoded(`${CRAFTING}/stat_clock_red_happy.vtf`), 'face_red.webp', { quality: 92 }),
    writeMap(decoded(`${CRAFTING}/stat_clock_blue_happy.vtf`), 'face_blu.webp', { quality: 92 }),
  ]);

  const unusedRefs = new Set();
  const material = (vmtPath) => ({ ...parseMaterialBody(readVmtBody(path.join(STAGING, vmtPath)), unusedRefs), lightwarpTexture: lightwarp });
  const faceBody = readVmtBody(path.join(STAGING, `${CRAFTING}/stat_clock_red_happy.vmt`));
  const { placements, without } = placementsByWeapon();
  const output = {
    model: `${DATA_PREFIX}clock.glb`,
    dial: { texture: dial, frames: dialFrames.length, digits: 6 },
    teams: { red: { body: bodyRed, face: faceRed }, blu: { body: bodyBlu, face: faceBlu } },
    lines,
    lightwarp,
    materials: {
      body: material(`${CRAFTING}/stat_clock.vmt`),
      dial: material(`${DIAL}000.vmt`),
      // UnlitTwoTexture multiplies its two textures and has no lighting, phong or cubemap of its own.
      face: {
        phongExponent: null, phongBoost: 1, envmapTint: [0, 0, 0], normalMap: null, phong: false, phongExponentFactor: null,
        unlit: true, unlitTwoTexture: true,
        detailTexture: lines, detailScale: 1, detailBlendFactor: 1, detailBlendMode: 0,
        ...scrollOf(faceBody),
      },
    },
    placements,
  };
  fs.writeFileSync(path.join(OUT, 'stat-clock.json'), `${JSON.stringify(output)}\n`);

  const sizes = fs.readdirSync(OUT).map((file) => `${file} ${fs.statSync(path.join(OUT, file)).size}`);
  log(sizes.join(', '));
  log(`${Object.keys(placements).length} weapons placed; without a clock: ${without.join(', ') || 'none'}`);
}

await main();
