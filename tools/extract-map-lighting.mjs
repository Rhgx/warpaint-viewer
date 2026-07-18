// Extract TF2 lighting presets from BSPSource VMFs and their real skybox faces.
//
// Usage:
//   node tools/extract-map-lighting.mjs
// Optional environment overrides:
//   BSPSOURCE_HOME=C:/path/to/BSPSource
//   TF2_DIR=C:/path/to/Team Fortress 2

// The generated TypeScript intentionally retains the raw Hammer values. The
// runtime owns the small, documented conversion from Source brightness units
// to three.js units.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeVTF } from './lib/vtf.mjs';
import { encodePNG } from './lib/png.mjs';
import { extractBatch, listVPK } from './lib/vpk.mjs';
import { sampleBspAmbientCube } from './lib/bsp-lighting.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BSPSOURCE = process.env.BSPSOURCE_HOME || 'C:/Users/TR/Desktop/BSPSource';
const TF2_DIR = process.env.TF2_DIR || 'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2';
const TF_DIR = path.join(TF2_DIR, 'tf');
const TEXTURES_VPK = path.join(TF_DIR, 'tf2_textures_dir.vpk');
const WORK_DIR = path.join(ROOT, '.tmp', 'map-lighting');
const VMF_DIR = path.join(WORK_DIR, 'vmf');
const VTF_DIR = path.join(WORK_DIR, 'vtf');
const SKYBOX_OUT = path.join(ROOT, 'public', 'data', 'env', 'maps');
const GENERATED_OUT = path.join(ROOT, 'src', 'viewer', 'mapLighting.generated.ts');

const PRESETS = [
  { id: 'daylight', label: 'Badlands', map: 'cp_badlands', sampleOrigin: [0, 0, 364], captureAngles: [0, 45, 0] },
  { id: 'overcast', label: 'Sawmill', map: 'koth_sawmill', sampleOrigin: [511.677, -4.29442, 160.25], captureAngles: [0, 225, 0] },
  {
    id: 'indoors', label: '2Fort', map: 'ctf_2fort',
    // Valve's unobstructed point_devshot_camera "devshot_red_flagroom2".
    // This is also the exact origin used by the captured 2Fort backplate.
    sampleOrigin: [-592, 3328, -65.111], captureAngles: [0, 338, 0], focusDistance: 128, localLightCount: 4,
  },
  { id: 'night', label: 'Harvest Event', map: 'koth_harvest_event', sampleOrigin: [0, 0, 104.25], captureAngles: [0, 45, 0] },
];

function assertFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
}

function parseVector(value, count = 3) {
  const values = String(value ?? '').trim().split(/\s+/).map(Number);
  if (values.length < count || values.slice(0, count).some((value) => !Number.isFinite(value))) return null;
  return values.slice(0, count);
}

function parseLight(value) {
  const values = parseVector(value, 4);
  return values ? values.map((entry) => Math.round(entry * 1000) / 1000) : null;
}

function parseVmf(text) {
  const blocks = [];
  for (const match of text.matchAll(/^(world|entity)\s*\{([\s\S]*?)^\}/gm)) {
    const values = {};
    for (const pair of match[2].matchAll(/"([^"]+)"\s+"([^"]*)"/g)) values[pair[1]] = pair[2];
    blocks.push(values);
  }
  return blocks;
}

function entityData(entity) {
  return {
    classname: entity.classname,
    origin: parseVector(entity.origin),
    angles: parseVector(entity.angles),
    pitch: Number(entity.pitch ?? 0),
    light: parseLight(entity._lightHDR)?.[0] === -1 ? parseLight(entity._light) : (parseLight(entity._lightHDR) || parseLight(entity._light)),
    ambient: parseLight(entity._ambientHDR)?.[0] === -1 ? parseLight(entity._ambient) : (parseLight(entity._ambientHDR) || parseLight(entity._ambient)),
    cone: Number(entity._cone ?? 45),
    innerCone: Number(entity._inner_cone ?? entity._cone ?? 30),
    fiftyPercentDistance: Number(entity._fifty_percent_distance ?? 0),
    zeroPercentDistance: Number(entity._zero_percent_distance ?? 0),
  };
}

function nearestLocalLights(entities, origin, count) {
  if (!origin || !count) return [];
  return entities
    .filter((entity) => entity.classname === 'light' || entity.classname === 'light_spot')
    .map((entity) => {
      const data = entityData(entity);
      const point = data.origin;
      const distance = point ? Math.hypot(point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]) : Infinity;
      return { ...data, distance: Math.round(distance * 1000) / 1000 };
    })
    .filter((light) => light.light && Number.isFinite(light.distance))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count);
}

function decompileMaps() {
  fs.mkdirSync(VMF_DIR, { recursive: true });
  const java = path.join(BSPSOURCE, 'bin', 'java.exe');
  assertFile(java, 'BSPSource runtime');
  const bspFiles = PRESETS.map(({ map }) => path.join(TF_DIR, 'maps', `${map}.bsp`));
  bspFiles.forEach((file) => assertFile(file, 'TF2 map'));
  execFileSync(java, [
    '-m', 'info.ata4.bspsrc.app/info.ata4.bspsrc.app.src.BspSourceLauncher',
    '--appid=440', '--no_brushes', '--no_disps', '--no_sprp', '--no_overlays',
    '--no_details', '--no_areaportals', '--no_occluders', '--no_ladders',
    '--no_visclusters', '--no_cams', '--no_prot', '-o', VMF_DIR, ...bspFiles,
  ], { cwd: BSPSOURCE, stdio: 'inherit' });
}

const FACE_SUFFIXES = { px: 'rt', nx: 'lf', py: 'up', ny: 'dn', pz: 'ft', nz: 'bk' };

function squareSkyFace(decoded) {
  if (decoded.width === decoded.height) return decoded;
  // TF2 commonly stores side faces at 2:1 and its sky VMT applies `scale 1 2`.
  // WebGL cubemaps require square faces, so reproduce that vertical stretch
  // here with bilinear sampling instead of handing THREE an invalid cube.
  const size = Math.max(decoded.width, decoded.height);
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sourceY = (y / Math.max(1, size - 1)) * (decoded.height - 1);
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(decoded.height - 1, y0 + 1);
    const blend = sourceY - y0;
    for (let x = 0; x < size; x++) {
      const sourceX = Math.round((x / Math.max(1, size - 1)) * (decoded.width - 1));
      const target = (y * size + x) * 4;
      const top = (y0 * decoded.width + sourceX) * 4;
      const bottom = (y1 * decoded.width + sourceX) * 4;
      for (let channel = 0; channel < 4; channel++) {
        rgba[target + channel] = Math.round(decoded.rgba[top + channel] * (1 - blend) + decoded.rgba[bottom + channel] * blend);
      }
    }
  }
  return { ...decoded, width: size, height: size, rgba };
}

function extractSkybox(skyName, vpkFiles) {
  const outputDir = path.join(SKYBOX_OUT, skyName);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(path.join(VTF_DIR, 'materials', 'skybox'), { recursive: true });

  const jobs = Object.entries(FACE_SUFFIXES).map(([face, suffix]) => {
    const exact = `materials/skybox/${skyName}${suffix}.vtf`.toLowerCase();
    const sharedSide = `materials/skybox/${skyName}side.vtf`.toLowerCase();
    const source = vpkFiles.has(exact) ? exact : (['rt', 'lf', 'ft', 'bk'].includes(suffix) && vpkFiles.has(sharedSide) ? sharedSide : null);
    if (!source) throw new Error(`Missing ${face} face for skybox ${skyName}`);
    return { face, source };
  });

  extractBatch(TEXTURES_VPK, [...new Set(jobs.map((job) => job.source))], VTF_DIR);
  for (const { face, source } of jobs) {
    const decoded = squareSkyFace(decodeVTF(fs.readFileSync(path.join(VTF_DIR, source))));
    fs.writeFileSync(path.join(outputDir, `${face}.png`), encodePNG(decoded.rgba, decoded.width, decoded.height));
  }
}

function main() {
  assertFile(TEXTURES_VPK, 'TF2 textures VPK');
  decompileMaps();
  const vpkFiles = listVPK(TEXTURES_VPK);
  const result = {};

  for (const preset of PRESETS) {
    const vmfPath = path.join(VMF_DIR, `${preset.map}_d.vmf`);
    assertFile(vmfPath, 'BSPSource VMF');
    const entities = parseVmf(fs.readFileSync(vmfPath, 'utf8'));
    const world = entities.find((entity) => entity.classname === 'worldspawn');
    const environment = entities.find((entity) => entity.classname === 'light_environment');
    const fog = entities.find((entity) => entity.classname === 'env_fog_controller');
    if (!world?.skyname || !environment) throw new Error(`Incomplete lighting entities in ${preset.map}`);
    extractSkybox(world.skyname, vpkFiles);
    const bspPath = path.join(TF_DIR, 'maps', `${preset.map}.bsp`);
    result[preset.id] = {
      label: preset.label,
      map: preset.map,
      skybox: world.skyname,
      sampleOrigin: preset.sampleOrigin ?? null,
      captureAngles: preset.captureAngles ?? [0, 0, 0],
      focusDistance: preset.focusDistance ?? 0,
      ambientProbe: sampleBspAmbientCube(bspPath, preset.sampleOrigin),
      environment: entityData(environment),
      localLights: nearestLocalLights(entities, preset.sampleOrigin, preset.localLightCount),
      fog: fog ? {
        color: parseVector(fog.fogcolor)?.map(Math.round) ?? null,
        color2: parseVector(fog.fogcolor2)?.map(Math.round) ?? null,
        start: Number(fog.fogstart ?? 0),
        end: Number(fog.fogend ?? 0),
      } : null,
    };
  }

  const generated = `// Generated by tools/extract-map-lighting.mjs using BSPSource. Do not hand-edit.\n` +
    `export const BSP_MAP_LIGHTING = ${JSON.stringify(result, null, 2)} as const;\n`;
  fs.writeFileSync(GENERATED_OUT, generated);
  console.log(`Wrote ${path.relative(ROOT, GENERATED_OUT)} and ${PRESETS.length} skyboxes.`);
}

main();
