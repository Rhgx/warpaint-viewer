import fs from 'node:fs';
import path from 'node:path';

import { kvGet, parseKV } from '../lib/kv.mjs';
import { texturePublicPath } from '../lib/resolve.mjs';
import { extractBatch, listVPK, MISC_VPK } from '../lib/vpk.mjs';

export function resolveWeaponMaterials({
  weaponRegistry, allTextureRefs, weaponModels, manifestPaintkits, stagingPath, log = console.log,
}) {
  const misc = listVPK(MISC_VPK);
  const vmtDirectory = path.join(stagingPath, 'vmt');
  fs.mkdirSync(vmtDirectory, { recursive: true });
  const toExtract = [];
  const weaponVmts = new Map();
  const overrideVmts = new Map();

  for (const weapon of weaponRegistry.values()) {
    weaponModels[weapon.key] = [weapon.modelPath ? weapon.modelPath.replace(/\\/g, '/') : null].filter(Boolean);
    if (!weapon.modelPath) continue;
    const modelMaterial = `materials/${weapon.modelPath.replace(/\\/g, '/').replace(/\.mdl$/i, '.vmt')}`.toLowerCase();
    if (misc.has(modelMaterial)) {
      weaponVmts.set(weapon.key, modelMaterial);
      toExtract.push(modelMaterial);
      continue;
    }
    const fallback = [
      `materials/models/weapons/c_models/${weapon.key}/${weapon.key}.vmt`,
      `materials/models/weapons/c_models/${weapon.key}.vmt`,
      `materials/models/weapons/c_items/${weapon.key}.vmt`,
    ].map((candidate) => candidate.toLowerCase()).find((candidate) => misc.has(candidate));
    if (fallback) {
      weaponVmts.set(weapon.key, fallback);
      toExtract.push(fallback);
    }
  }

  for (const paintkit of manifestPaintkits) {
    for (const materialId of Object.values(paintkit.materialOverrides || {})) {
      const vmtPath = `materials/${materialId.replace(/\.vmt$/i, '')}.vmt`.toLowerCase();
      if (!misc.has(vmtPath)) continue;
      overrideVmts.set(materialId, vmtPath);
      toExtract.push(vmtPath);
    }
  }
  extractBatch(MISC_VPK, toExtract, vmtDirectory);

  for (const weapon of weaponRegistry.values()) {
    let material = defaultMaterial();
    const vmtPath = weaponVmts.get(weapon.key);
    const fullPath = vmtPath && path.join(vmtDirectory, vmtPath);
    if (fullPath && fs.existsSync(fullPath)) {
      try {
        const body = readVmtBody(fullPath);
        const baseTexture = kvGet(body, '$basetexture');
        if (baseTexture) weapon.compositeTexture = texturePublicPath(baseTexture);
        material = parseMaterialBody(body, allTextureRefs);
      } catch (error) {
        log(`[weapons] failed to parse VMT ${vmtPath}: ${error.message}`);
      }
    }
    weapon.material = material;
  }

  const overrides = {};
  for (const [materialId, vmtPath] of overrideVmts) {
    try {
      overrides[materialId] = parseMaterialBody(readVmtBody(path.join(vmtDirectory, vmtPath)), allTextureRefs);
    } catch (error) {
      log(`[weapons] failed to parse override VMT ${vmtPath}: ${error.message}`);
    }
  }
  return overrides;
}

function readVmtBody(fullPath) {
  const parsed = parseKV(fs.readFileSync(fullPath, 'utf8'));
  return parsed[Object.keys(parsed)[0]] || {};
}

function parseVector(value) {
  if (value == null) return null;
  const numbers = String(value).replace(/[[\]{}]/g, ' ').trim().split(/\s+/).map(Number).filter(Number.isFinite);
  return numbers.length ? numbers : null;
}

function bool(body, key, fallback = false) {
  const value = parseVector(kvGet(body, key));
  return value ? value[0] !== 0 : fallback;
}

function color(body, key, fallback = null) {
  const value = parseVector(kvGet(body, key));
  if (!value) return fallback;
  if (value.length === 1) return [value[0], value[0], value[0]];
  return value.length >= 3 ? value.slice(0, 3) : fallback;
}

function scalar(body, key, fallback = null) {
  return parseVector(kvGet(body, key))?.[0] ?? fallback;
}

function parseMaterialBody(body, textureRefs) {
  const normalMap = publicTexture(body, '$bumpmap');
  const phongExponentTexture = publicTexture(body, '$phongexponenttexture');
  const lightwarpTexture = publicTexture(body, '$lightwarptexture');
  for (const ref of [normalMap, phongExponentTexture, lightwarpTexture]) if (ref) textureRefs.add(ref);

  const material = {
    phongExponent: scalar(body, '$phongexponent'),
    phongBoost: scalar(body, '$phongboost', 1),
    envmapTint: color(body, '$envmaptint', [0, 0, 0]),
    normalMap,
    phong: bool(body, '$phong'),
    phongExponentFactor: scalar(body, '$phongexponentfactor'),
    phongExponentTexture,
    lightwarpTexture,
    halfLambert: bool(body, '$halflambert'),
    baseMapAlphaPhongMask: bool(body, '$basemapalphaphongmask'),
    baseMapAlphaEnvmapMask: bool(body, '$basealphaenvmapmask'),
    normalMapAlphaEnvmapMask: bool(body, '$normalmapalphaenvmapmask'),
    phongAlbedoTint: bool(body, '$phongalbedotint'),
    phongTint: color(body, '$phongtint'),
    phongFresnelRanges: color(body, '$phongfresnelranges', [0, 0.5, 1]),
    rimLight: bool(body, '$rimlight'),
    rimLightExponent: scalar(body, '$rimlightexponent', 4),
    rimLightBoost: scalar(body, '$rimlightboost', 1),
    rimMask: bool(body, '$rimmask'),
  };
  if (!bool(body, '$selfillum')) return material;
  const selfIllumMask = publicTexture(body, '$selfillummask');
  if (selfIllumMask) textureRefs.add(selfIllumMask);
  return {
    ...material,
    selfIllum: true,
    selfIllumMask,
    selfIllumTint: color(body, '$selfillumtint', [1, 1, 1]),
    selfIllumFresnel: bool(body, '$selfillumfresnel'),
    selfIllumFresnelMinMaxExp: color(body, '$selfillumfresnelminmaxexp', [0, 1, 1]),
    modelGlowColor: !!kvGet(kvGet(body, 'proxies') || {}, 'modelglowcolor'),
  };
}

function publicTexture(body, key) {
  const value = kvGet(body, key);
  return value ? texturePublicPath(value) : null;
}

function defaultMaterial() {
  return {
    phongExponent: null, phongBoost: 1, envmapTint: [0, 0, 0], normalMap: null,
    phong: false, phongExponentFactor: null, phongExponentTexture: null,
    lightwarpTexture: null, baseMapAlphaPhongMask: false,
    baseMapAlphaEnvmapMask: false, halfLambert: false,
    normalMapAlphaEnvmapMask: false, phongAlbedoTint: false, phongTint: null,
    phongFresnelRanges: [0, 0.5, 1], rimLight: false, rimLightExponent: 4,
    rimLightBoost: 1, rimMask: false,
  };
}
