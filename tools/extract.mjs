// TF2 Warpaint Viewer - data extraction pipeline entry point.
//   node tools/extract.mjs [--only <step>]
// Steps: protodefs, items, recipes, textures, weapons, manifest, verify (default: all).
//
// Produces:
//   public/data/manifest.json
//   public/data/recipes/<paintkitId>.json  ({ trees, variants }; variants key =
//                                            <weaponKey>_<team>[_w<n>] -> trees index)
//   public/data/textures/<vpk path minus materials/>.webp   (lossless, compositor input)
//   staging/weapon_models.json      (weaponKey -> [vpk-relative .mdl paths]) for the model agent
//   staging/protodefs/*.json        (raw decoded proto dumps, for debugging)
//   staging/items_game.json         (cached parsed items_game)

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import { loadRoot, parseContainer, decodeType, DEF_TYPE } from './lib/proto.mjs';
import { parseKV, kvGet } from './lib/kv.mjs';
import { loadLocalization, locLookup } from './lib/localization.mjs';
import {
  buildIndex, resolveRecipe, WEAPON_SLOTS, texturePublicPath,
} from './lib/resolve.mjs';
import { decodeVTF, decodeVTFCubemap, parseVTFHeader } from './lib/vtf.mjs';
import { encodePNG } from './lib/png.mjs';
import { listVPK, extractBatch, TEXTURES_VPK, MISC_VPK } from './lib/vpk.mjs';
import { buildBundle } from './lib/recipe-pack.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STAGING = path.join(ROOT, 'staging');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const TF = 'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2/tf';
const VPD = `${TF}/scripts/protodefs/proto_defs.vpd`;
const ITEMS_GAME = `${TF}/scripts/items/items_game.txt`;
const LOC_PROTO = `${TF}/resource/tf_proto_obj_defs_english.txt`;
const LOC_ENGLISH = `${TF}/resource/tf_english.txt`;

const WEAR_LEVELS = [0.2, 0.4, 0.6, 0.8, 1.0];
const WEAR_NAMES = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle Scarred'];
const COMPOSITE_1024_WEAPONS = new Set(['c_flameball', 'c_holymackerel', 'c_lochnload', 'c_quadball']);

function log(...a) { console.log(...a); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function pngHeaderDimensions(buf) {
  if (buf.length < 24 || buf.toString('ascii', 1, 4) !== 'PNG') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// Parse just enough of the RIFF/WEBP container to read canvas dimensions, without a full decode.
function webpHeaderDimensions(buf) {
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const fourcc = buf.toString('ascii', 12, 16);
  if (fourcc === 'VP8X') {
    // Extended format: 24-bit little-endian minus-one canvas width/height in the chunk payload.
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    // Lossless format: signature byte 0x2f, then 14-bit width-1 / height-1 packed little-endian.
    if (buf[20] !== 0x2f) return null;
    const b0 = buf[21]; const b1 = buf[22]; const b2 = buf[23]; const b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0xf) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height };
  }
  if (fourcc === 'VP8 ') {
    // Simple lossy format: dimensions live in the frame header after the start code.
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height };
  }
  return null;
}

function pngDimensions(publicRef) {
  if (!publicRef) return null;
  const full = path.join(PUBLIC_DATA, publicRef);
  if (!fs.existsSync(full)) return null;
  const buf = fs.readFileSync(full);
  return publicRef.toLowerCase().endsWith('.webp') ? webpHeaderDimensions(buf) : pngHeaderDimensions(buf);
}

// ---------------------------------------------------------------------------
// items_game parsing + prefab-aware field lookup
// ---------------------------------------------------------------------------

function loadItemsGame() {
  const cache = path.join(STAGING, 'items_game.json');
  let kv;
  if (fs.existsSync(cache)) {
    kv = JSON.parse(fs.readFileSync(cache, 'utf8'));
  } else {
    kv = parseKV(fs.readFileSync(ITEMS_GAME, 'utf8'));
    ensureDir(STAGING);
    fs.writeFileSync(cache, JSON.stringify(kv));
  }
  const root = kvGet(kv, 'items_game');
  return {
    items: kvGet(root, 'items') || {},
    prefabs: kvGet(root, 'prefabs') || {},
    collections: kvGet(root, 'item_collections') || {},
  };
}

// Build paintkit defindex -> localized collection display name from items_game item_collections.
// Collection items may be listed directly or nested under rarity grade keys; each item name maps
// to an item def whose static_attrs (or attributes) carry paintkit_proto_def_index.
function buildCollectionMap(itemsGame, locEnglish, locProto) {
  const machineByDisplay = new Map(); // display name -> items_game collection machine name
  const byName = new Map();
  for (const it of Object.values(itemsGame.items)) {
    if (it && typeof it === 'object' && typeof it.name === 'string') byName.set(it.name, it);
  }

  const leafNames = (block, out) => {
    for (const [k, v] of Object.entries(block)) {
      if (v && typeof v === 'object') leafNames(v, out);
      else out.push(k);
    }
    return out;
  };

  const paintkitIndexOf = (item) => {
    const sa = kvGet(item, 'static_attrs');
    if (sa) {
      const v = kvGet(sa, 'paintkit_proto_def_index');
      if (v !== undefined && typeof v !== 'object') return Number(v);
      if (v && typeof v === 'object') { const vv = kvGet(v, 'value'); if (vv !== undefined) return Number(vv); }
    }
    const attrs = kvGet(item, 'attributes');
    if (attrs) {
      const a = kvGet(attrs, 'paintkit_proto_def_index');
      if (a !== undefined && typeof a !== 'object') return Number(a);
      if (a && typeof a === 'object') { const vv = kvGet(a, 'value'); if (vv !== undefined) return Number(vv); }
    }
    return null;
  };

  const map = new Map(); // paintkitId -> displayName
  for (const [machineName, entry] of Object.entries(itemsGame.collections)) {
    if (!entry || typeof entry !== 'object') continue;
    if (kvGet(entry, 'is_reference_collection')) continue; // master collections list dummies only
    const nameToken = kvGet(entry, 'name');
    const displayName = locLookup(locEnglish, nameToken) || locLookup(locProto, nameToken) || machineName;
    if (!machineByDisplay.has(displayName)) machineByDisplay.set(displayName, machineName);
    const itemsBlock = kvGet(entry, 'items');
    if (!itemsBlock || typeof itemsBlock !== 'object') continue;
    for (const itemName of leafNames(itemsBlock, [])) {
      const item = byName.get(itemName);
      if (!item) continue;
      const pk = paintkitIndexOf(item);
      if (pk == null || !Number.isFinite(pk)) continue;
      if (map.has(pk)) {
        if (map.get(pk) !== displayName) log(`[collections] paintkit ${pk} in multiple collections: keeping "${map.get(pk)}", ignoring "${displayName}"`);
        continue;
      }
      map.set(pk, displayName);
    }
  }
  return { byPaintkit: map, machineByDisplay };
}

// Resolve a scalar field on an item, following its prefab chain (first prefab wins, recursive).
function resolveItemField(itemsGame, node, field, seen = new Set()) {
  if (!node || typeof node !== 'object') return undefined;
  const direct = kvGet(node, field);
  if (direct !== undefined && typeof direct !== 'object') return direct;
  const prefabStr = kvGet(node, 'prefab');
  if (!prefabStr) return undefined;
  for (const pn of String(prefabStr).trim().split(/\s+/)) {
    if (seen.has(pn)) continue;
    seen.add(pn);
    const pf = kvGet(itemsGame.prefabs, pn);
    const v = resolveItemField(itemsGame, pf, field, seen);
    if (v !== undefined) return v;
  }
  return undefined;
}

function modelStem(modelPath) {
  if (!modelPath) return null;
  const base = modelPath.replace(/\\/g, '/').split('/').pop();
  return base.replace(/\.mdl$/i, '');
}

// ---------------------------------------------------------------------------
// Step: decode proto defs
// ---------------------------------------------------------------------------

function stepProtodefs() {
  log('[protodefs] decoding proto_defs.vpd ...');
  const root = loadRoot();
  const c = parseContainer(VPD);
  const defs = decodeType(root, c.byType, DEF_TYPE.PAINTKIT_DEFINITION);
  const itemDefs = decodeType(root, c.byType, DEF_TYPE.PAINTKIT_ITEM_DEFINITION);
  const operations = decodeType(root, c.byType, DEF_TYPE.PAINTKIT_OPERATION);
  const variables = decodeType(root, c.byType, DEF_TYPE.PAINTKIT_VARIABLES);
  const dir = path.join(STAGING, 'protodefs');
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'paintkit_definitions.json'), JSON.stringify(defs, null, 1));
  fs.writeFileSync(path.join(dir, 'paintkit_item_definitions.json'), JSON.stringify(itemDefs, null, 1));
  fs.writeFileSync(path.join(dir, 'paintkit_operations.json'), JSON.stringify(operations, null, 1));
  fs.writeFileSync(path.join(dir, 'paintkit_variables.json'), JSON.stringify(variables, null, 1));
  log(`[protodefs] defs=${defs.length} itemDefs=${itemDefs.length} ops=${operations.length} vars=${variables.length}`);
  return { defs, itemDefs, operations, variables };
}

// ---------------------------------------------------------------------------
// Collect slots from a paintkit definition (named weapon slots + old-style repeated item[]).
// ---------------------------------------------------------------------------

function collectSlots(def) {
  const slots = [];
  for (const name of WEAPON_SLOTS) {
    const s = def[name];
    if (s && s.item_definition_template) slots.push({ slotName: name, slot: s });
  }
  if (def.item) {
    const arr = Array.isArray(def.item) ? def.item : [def.item];
    for (const it of arr) if (it && it.item_definition_template) slots.push({ slotName: 'item', slot: it });
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const run = (name) => !only || only === name;

  ensureDir(PUBLIC_DATA);
  ensureDir(STAGING);

  const { defs, itemDefs, operations, variables } = stepProtodefs();
  const ctx = buildIndex(operations, itemDefs, variables);

  log('[items] parsing items_game.txt ...');
  const itemsGame = loadItemsGame();
  log(`[items] items=${Object.keys(itemsGame.items).length} prefabs=${Object.keys(itemsGame.prefabs).length}`);

  log('[loc] loading localization ...');
  const locProto = loadLocalization(LOC_PROTO);
  const locEnglish = loadLocalization(LOC_ENGLISH);

  const { byPaintkit: collectionByPaintkit, machineByDisplay } = buildCollectionMap(itemsGame, locEnglish, locProto);
  log(`[collections] mapped ${collectionByPaintkit.size} paintkits to collections`);

  // Resolve everything ------------------------------------------------------
  log('[recipes] resolving recipes ...');
  const manifestPaintkits = [];
  const paintIconRefByKit = new Map(); // paintkit id -> representative pattern texture ref
  const weaponRegistry = new Map(); // weaponKey -> { key, name, itemDefIndex, modelPath }
  const allTextureRefs = new Set();
  const recipesToWrite = []; // { kitId, key, tree }
  const skipped = [];
  let recipeCount = 0;

  for (const def of defs) {
    const id = def.header.defindex;
    const slots = collectSlots(def);
    if (!slots.length) continue;
    const name = locLookup(locProto, def.loc_desctoken) || def.header.name || `paintkit_${id}`;
    const hasTeam = !!def.has_team_textures;
    const teams = hasTeam ? ['red', 'blu'] : ['red'];

    const kitWeapons = new Set();
    const kitMaterialOverrides = {};
    const kitTextureRefs = new Set();
    let kitPerWear = false;
    const kitRecipes = []; // { weaponKey, team, trees:[per wear] }

    for (const { slot } of slots) {
      const itemDef = ctx.itemDefByIdx.get(slot.item_definition_template.defindex);
      if (!itemDef) { skipped.push({ id, reason: `no itemDef ${slot.item_definition_template.defindex}` }); continue; }
      const itemDefIndex = itemDef.item_definition_index;
      const gameItem = kvGet(itemsGame.items, String(itemDefIndex));
      const modelPath = gameItem ? resolveItemField(itemsGame, gameItem, 'model_player') : undefined;
      const weaponKey = modelStem(modelPath);
      if (!weaponKey) { skipped.push({ id, itemDefIndex, reason: 'no model_player' }); continue; }

      if (!weaponRegistry.has(weaponKey)) {
        const nameToken = gameItem ? resolveItemField(itemsGame, gameItem, 'item_name') : null;
        const wName = locLookup(locEnglish, nameToken) || weaponKey;
        weaponRegistry.set(weaponKey, { key: weaponKey, name: wName, itemDefIndex, modelPath });
      }
      kitWeapons.add(weaponKey);
      const materialOverride = slot.data?.material_override;
      if (typeof materialOverride === 'string' && materialOverride) {
        kitMaterialOverrides[weaponKey] = materialOverride.toLowerCase();
      }

      const nWear = (itemDef.definition || []).length || 1;
      for (const team of teams) {
        const trees = [];
        for (let w = 0; w < nWear; w++) {
          const r = resolveRecipe(def, slot, itemDef, w, team, ctx);
          if (!r) { trees.push(null); continue; }
          for (const t of r.textureRefs) { allTextureRefs.add(t); kitTextureRefs.add(t); }
          trees.push(r.tree);
        }
        const nonNull = trees.filter((t) => t);
        if (!nonNull.length) continue;
        const differ = nonNull.some((t) => JSON.stringify(t) !== JSON.stringify(nonNull[0]));
        if (differ) kitPerWear = true;
        kitRecipes.push({ weaponKey, team, trees });
      }
    }

    if (!kitWeapons.size) { skipped.push({ id, reason: 'no resolvable weapons' }); continue; }

    // Emit recipe variants (bundled per kit id below).
    for (const rec of kitRecipes) {
      if (kitPerWear) {
        for (let w = 0; w < rec.trees.length; w++) {
          const tree = rec.trees[w] || rec.trees.find((t) => t);
          recipesToWrite.push({ kitId: id, key: `${rec.weaponKey}_${rec.team}_w${w}`, tree });
          recipeCount++;
        }
      } else {
        const tree = rec.trees.find((t) => t);
        recipesToWrite.push({ kitId: id, key: `${rec.weaponKey}_${rec.team}`, tree });
        recipeCount++;
      }
    }

    manifestPaintkits.push({
      id,
      name,
      collection: collectionByPaintkit.get(id) || null,
      hasTeamTextures: hasTeam,
      perWear: kitPerWear,
      weapons: [...kitWeapons].sort(),
      ...(Object.keys(kitMaterialOverrides).length ? { materialOverrides: kitMaterialOverrides } : {}),
    });
    const firstTree = kitRecipes[0]?.trees.find((t) => t);
    if (firstTree) paintIconRefByKit.set(id, pickPaintIconRef(firstTree));
  }

  manifestPaintkits.sort((a, b) => a.id - b.id);
  log(`[recipes] paintkits=${manifestPaintkits.length} weapons=${weaponRegistry.size} recipeFiles=${recipeCount} textureRefs=${allTextureRefs.size} skipped=${skipped.length}`);

  if (run('recipes')) {
    log('[recipes] writing recipe bundles ...');
    const byKit = new Map(); // kitId -> [{ key, tree }]
    for (const r of recipesToWrite) {
      let entries = byKit.get(r.kitId);
      if (!entries) byKit.set(r.kitId, entries = []);
      entries.push({ key: r.key, tree: r.tree });
    }
    const recipesDir = path.join(PUBLIC_DATA, 'recipes');
    ensureDir(recipesDir);
    let written = 0;
    let lastLogged = 0;
    for (const [kitId, entries] of byKit) {
      const bundle = buildBundle(entries);
      fs.writeFileSync(path.join(recipesDir, `${kitId}.json`), JSON.stringify(bundle));
      written += entries.length;
      if (written - lastLogged >= 5000) { log(`  ... ${written}/${recipesToWrite.length}`); lastLogged = written; }
    }
    log(`[recipes] wrote ${byKit.size} bundles (${written} variants)`);
  }

  // Weapons + material params -----------------------------------------------
  const weaponModels = {};
  let materialOverrides = {};
  if (run('weapons') || run('manifest') || run('textures')) {
    log('[weapons] resolving weapon material params ...');
    materialOverrides = resolveWeaponMaterials(weaponRegistry, allTextureRefs, weaponModels, manifestPaintkits);
  }

  // Textures ----------------------------------------------------------------
  let textureMetadata = {};
  if (run('textures')) textureMetadata = await extractAndDecodeTextures(allTextureRefs);
  else {
    const metadataPath = path.join(STAGING, 'texture_metadata.json');
    if (fs.existsSync(metadataPath)) textureMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  }

  // Backpack icons ------------------------------------------------------------
  let collectionIcons = {};
  if (run('icons') || run('manifest')) {
    collectionIcons = extractIcons(itemsGame, weaponRegistry, machineByDisplay);
    generatePaintIcons(manifestPaintkits, paintIconRefByKit);
  }

  // Manifest ----------------------------------------------------------------
  if (run('manifest') || run('recipes')) {
    const weapons = [...weaponRegistry.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((w) => {
        const dimensions = pngDimensions(w.compositeTexture) || {
          width: COMPOSITE_1024_WEAPONS.has(w.key) ? 1024 : 2048,
          height: COMPOSITE_1024_WEAPONS.has(w.key) ? 1024 : 2048,
        };
        return ({
        key: w.key,
        name: w.name,
        model: `models/${w.key}.glb`,
        ...(dimensions ? { compositeWidth: dimensions.width, compositeHeight: dimensions.height } : {}),
        ...(w.icon ? { icon: w.icon } : {}),
        material: w.material || { phongExponent: null, phongBoost: 1, envmapTint: [0, 0, 0], normalMap: null },
      }); });
    const manifest = {
      generatedAt: new Date().toISOString(),
      paintkits: manifestPaintkits,
      weapons,
      materials: materialOverrides,
      textures: textureMetadata,
      collectionIcons,
      wearLevels: WEAR_LEVELS,
      wearNames: WEAR_NAMES,
    };
    ensureDir(PUBLIC_DATA);
    fs.writeFileSync(path.join(PUBLIC_DATA, 'manifest.json'), JSON.stringify(manifest, null, 1));
    fs.writeFileSync(path.join(STAGING, 'weapon_models.json'), JSON.stringify(weaponModels, null, 1));
    log(`[manifest] wrote manifest.json (${manifest.paintkits.length} paintkits, ${manifest.weapons.length} weapons)`);
    log(`[manifest] wrote staging/weapon_models.json (${Object.keys(weaponModels).length} weapons)`);
  }

  // Verify ------------------------------------------------------------------
  if (run('verify')) {
    verify(manifestPaintkits, allTextureRefs, skipped);
  }
}

// ---------------------------------------------------------------------------
// Weapon material params from the base weapon c_model VMT.
// ---------------------------------------------------------------------------

let miscListCache = null;
function miscList() {
  if (!miscListCache) miscListCache = listVPK(MISC_VPK);
  return miscListCache;
}

function parseVmtVec(str) {
  if (str == null) return null;
  const nums = String(str).replace(/[[\]{}]/g, ' ').trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  return nums.length ? nums : null;
}

function vmtBool(body, key, fallback = false) {
  const value = parseVmtVec(kvGet(body, key));
  return value ? value[0] !== 0 : fallback;
}

function vmtColor(body, key, fallback = null) {
  const value = parseVmtVec(kvGet(body, key));
  if (!value) return fallback;
  if (value.length === 1) return [value[0], value[0], value[0]];
  return value.length >= 3 ? [value[0], value[1], value[2]] : fallback;
}

function hasVmtProxy(body, name) {
  const proxies = kvGet(body, 'proxies');
  return !!(proxies && kvGet(proxies, name));
}

function vmtSelfIllum(body, allTextureRefs) {
  if (!vmtBool(body, '$selfillum')) return {};
  const rawMask = kvGet(body, '$selfillummask');
  const selfIllumMask = rawMask ? texturePublicPath(rawMask) : null;
  if (selfIllumMask) allTextureRefs.add(selfIllumMask);
  return {
    selfIllum: true,
    selfIllumMask,
    selfIllumTint: vmtColor(body, '$selfillumtint', [1, 1, 1]),
    selfIllumFresnel: vmtBool(body, '$selfillumfresnel'),
    selfIllumFresnelMinMaxExp: vmtColor(body, '$selfillumfresnelminmaxexp', [0, 1, 1]),
    modelGlowColor: hasVmtProxy(body, 'modelglowcolor'),
  };
}

function parseOverrideMaterial(full, allTextureRefs) {
  const kv = parseKV(fs.readFileSync(full, 'utf8'));
  const body = kv[Object.keys(kv)[0]] || {};
  const phongExp = parseVmtVec(kvGet(body, '$phongexponent'));
  const phongBoost = parseVmtVec(kvGet(body, '$phongboost'));
  const phongFactor = parseVmtVec(kvGet(body, '$phongexponentfactor'));
  const rimExponent = parseVmtVec(kvGet(body, '$rimlightexponent'));
  const rimBoost = parseVmtVec(kvGet(body, '$rimlightboost'));
  const bump = kvGet(body, '$bumpmap');
  const exponentTexture = kvGet(body, '$phongexponenttexture');
  const lightwarpTexture = kvGet(body, '$lightwarptexture');
  const material = {
    phongExponent: phongExp ? phongExp[0] : null,
    phongBoost: phongBoost ? phongBoost[0] : 1,
    envmapTint: vmtColor(body, '$envmaptint', [0, 0, 0]),
    normalMap: bump ? texturePublicPath(bump) : null,
    phong: vmtBool(body, '$phong'),
    phongExponentFactor: phongFactor ? phongFactor[0] : null,
    phongExponentTexture: exponentTexture ? texturePublicPath(exponentTexture) : null,
    lightwarpTexture: lightwarpTexture ? texturePublicPath(lightwarpTexture) : null,
    halfLambert: vmtBool(body, '$halflambert'),
    baseMapAlphaPhongMask: vmtBool(body, '$basemapalphaphongmask'),
    baseMapAlphaEnvmapMask: vmtBool(body, '$basealphaenvmapmask'),
    normalMapAlphaEnvmapMask: vmtBool(body, '$normalmapalphaenvmapmask'),
    phongAlbedoTint: vmtBool(body, '$phongalbedotint'),
    phongTint: vmtColor(body, '$phongtint'),
    phongFresnelRanges: vmtColor(body, '$phongfresnelranges', [0, 0.5, 1]),
    rimLight: vmtBool(body, '$rimlight'),
    rimLightExponent: rimExponent ? rimExponent[0] : 4,
    rimLightBoost: rimBoost ? rimBoost[0] : 1,
    rimMask: vmtBool(body, '$rimmask'),
    ...vmtSelfIllum(body, allTextureRefs),
  };
  if (material.normalMap) allTextureRefs.add(material.normalMap);
  if (material.phongExponentTexture) allTextureRefs.add(material.phongExponentTexture);
  if (material.lightwarpTexture) allTextureRefs.add(material.lightwarpTexture);
  return material;
}

function resolveWeaponMaterials(weaponRegistry, allTextureRefs, weaponModels, manifestPaintkits) {
  const misc = miscList();
  const vmtDir = path.join(STAGING, 'vmt');
  ensureDir(vmtDir);
  const toExtract = [];
  const weaponVmt = new Map();
  const overrideVmt = new Map();

  for (const w of weaponRegistry.values()) {
    // model_player: models/.../c_foo.mdl  ->  materials/models/.../c_foo.vmt
    weaponModels[w.key] = [w.modelPath ? w.modelPath.replace(/\\/g, '/') : null].filter(Boolean);
    if (!w.modelPath) continue;
    const matPath = `materials/${w.modelPath.replace(/\\/g, '/').replace(/\.mdl$/i, '.vmt')}`.toLowerCase();
    if (misc.has(matPath)) { weaponVmt.set(w.key, matPath); toExtract.push(matPath); continue; }
    // fallbacks
    const cands = [
      `materials/models/weapons/c_models/${w.key}/${w.key}.vmt`,
      `materials/models/weapons/c_models/${w.key}.vmt`,
      `materials/models/weapons/c_items/${w.key}.vmt`,
    ].map((s) => s.toLowerCase());
    const found = cands.find((c) => misc.has(c));
    if (found) { weaponVmt.set(w.key, found); toExtract.push(found); }
  }

  for (const kit of manifestPaintkits) {
    for (const materialId of Object.values(kit.materialOverrides || {})) {
      const vmtPath = `materials/${materialId.replace(/\.vmt$/i, '')}.vmt`.toLowerCase();
      if (misc.has(vmtPath)) {
        overrideVmt.set(materialId, vmtPath);
        toExtract.push(vmtPath);
      }
    }
  }

  extractBatch(MISC_VPK, toExtract, vmtDir);

  for (const w of weaponRegistry.values()) {
    const vmtRel = weaponVmt.get(w.key);
    let material = {
      phongExponent: null, phongBoost: 1, envmapTint: [0, 0, 0], normalMap: null,
      phong: false, phongExponentFactor: null, phongExponentTexture: null,
      lightwarpTexture: null, baseMapAlphaPhongMask: false,
      baseMapAlphaEnvmapMask: false, halfLambert: false,
      normalMapAlphaEnvmapMask: false, phongAlbedoTint: false, phongTint: null,
      phongFresnelRanges: [0, 0.5, 1], rimLight: false, rimLightExponent: 4,
      rimLightBoost: 1, rimMask: false,
    };
    if (vmtRel) {
      const full = path.join(vmtDir, vmtRel);
      if (fs.existsSync(full)) {
        try {
          const kv = parseKV(fs.readFileSync(full, 'utf8'));
          const shaderKey = Object.keys(kv)[0];
          const body = kv[shaderKey] || {};
          const phongExp = parseVmtVec(kvGet(body, '$phongexponent'));
          const phongBoost = parseVmtVec(kvGet(body, '$phongboost'));
          const phongFactor = parseVmtVec(kvGet(body, '$phongexponentfactor'));
          const phongFresnel = vmtColor(body, '$phongfresnelranges', [0, 0.5, 1]);
          const rimExponent = parseVmtVec(kvGet(body, '$rimlightexponent'));
          const rimBoost = parseVmtVec(kvGet(body, '$rimlightboost'));
          const bump = kvGet(body, '$bumpmap');
          const exponentTexture = kvGet(body, '$phongexponenttexture');
          const lightwarpTexture = kvGet(body, '$lightwarptexture');
          const baseTexture = kvGet(body, '$basetexture');
          if (baseTexture) {
            w.compositeTexture = texturePublicPath(baseTexture);
          }
          material = {
            phongExponent: phongExp ? phongExp[0] : null,
            phongBoost: phongBoost ? phongBoost[0] : 1,
            envmapTint: vmtColor(body, '$envmaptint', [0, 0, 0]),
            normalMap: bump ? texturePublicPath(bump) : null,
            phong: vmtBool(body, '$phong'),
            phongExponentFactor: phongFactor ? phongFactor[0] : null,
            phongExponentTexture: exponentTexture ? texturePublicPath(exponentTexture) : null,
            lightwarpTexture: lightwarpTexture ? texturePublicPath(lightwarpTexture) : null,
            halfLambert: vmtBool(body, '$halflambert'),
            baseMapAlphaPhongMask: vmtBool(body, '$basemapalphaphongmask'),
            baseMapAlphaEnvmapMask: vmtBool(body, '$basealphaenvmapmask'),
            normalMapAlphaEnvmapMask: vmtBool(body, '$normalmapalphaenvmapmask'),
            phongAlbedoTint: vmtBool(body, '$phongalbedotint'),
            phongTint: vmtColor(body, '$phongtint'),
            phongFresnelRanges: phongFresnel,
            rimLight: vmtBool(body, '$rimlight'),
            rimLightExponent: rimExponent ? rimExponent[0] : 4,
            rimLightBoost: rimBoost ? rimBoost[0] : 1,
            rimMask: vmtBool(body, '$rimmask'),
            ...vmtSelfIllum(body, allTextureRefs),
          };
          if (material.normalMap) allTextureRefs.add(material.normalMap);
          if (material.phongExponentTexture) allTextureRefs.add(material.phongExponentTexture);
          if (material.lightwarpTexture) allTextureRefs.add(material.lightwarpTexture);
        } catch (e) {
          log(`[weapons] failed to parse VMT ${vmtRel}: ${e.message}`);
        }
      }
    }
    w.material = material;
  }

  const overrides = {};
  for (const [materialId, vmtRel] of overrideVmt) {
    try {
      overrides[materialId] = parseOverrideMaterial(path.join(vmtDir, vmtRel), allTextureRefs);
    } catch (e) {
      log(`[weapons] failed to parse override VMT ${vmtRel}: ${e.message}`);
    }
  }
  return overrides;
}

// ---------------------------------------------------------------------------
// Paintkit thumbnails: the game renders war paint icons live, so there is no
// static image to extract. The most distinctive pattern texture of the kit's
// recipe makes a recognizable swatch instead.
// ---------------------------------------------------------------------------

// Shared overlays that appear in nearly every recipe and say nothing about
// the specific paint.
const PAINT_ICON_JUNK = /blank_|paint_dirt|paint_blood|paint_scratches|_wearblend|_ao\.|_albedo\./;

function pickPaintIconRef(tree) {
  const ordered = [];
  (function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'texture_lookup' && n.texture) ordered.push(n.texture);
    if (Array.isArray(n.nodes)) n.nodes.forEach(walk);
  })(tree);
  const patterns = ordered.filter((r) => r.startsWith('textures/patterns/') && !PAINT_ICON_JUNK.test(r));
  // Solid color fills are a last resort; a real pattern identifies the paint.
  return patterns.find((r) => !/\/solid_/.test(r)) || patterns[0] || null;
}

// Downscale each kit's representative pattern PNG to a 96px swatch with
// ImageMagick (already a dev dependency of this machine's pipeline; skipped
// gracefully when unavailable).
function generatePaintIcons(manifestPaintkits, paintIconRefByKit) {
  const probe = spawnSync('magick', ['-version'], { stdio: 'ignore', shell: false });
  if (probe.error || probe.status !== 0) {
    log('[icons] ImageMagick (magick) not found; skipping paintkit thumbnails');
    return;
  }
  const outDir = path.join(PUBLIC_DATA, 'icons', 'paints');
  ensureDir(outDir);
  let ok = 0;
  let miss = 0;
  for (const kit of manifestPaintkits) {
    const ref = paintIconRefByKit.get(kit.id);
    if (!ref) { miss++; continue; }
    const src = path.join(PUBLIC_DATA, ref);
    if (!fs.existsSync(src)) { miss++; continue; }
    const outRel = `icons/paints/${kit.id}.png`;
    const res = spawnSync('magick', [src, '-resize', '96x96^', '-gravity', 'center', '-extent', '96x96', path.join(PUBLIC_DATA, outRel)], { stdio: 'ignore', shell: false });
    if (res.status === 0) {
      kit.icon = outRel;
      ok++;
    } else {
      miss++;
    }
  }
  log(`[icons] wrote ${ok} paintkit thumbnails, ${miss} without one`);
}

// ---------------------------------------------------------------------------
// Backpack icons: per-weapon inventory images and per-collection case images.
// ---------------------------------------------------------------------------

let texListCacheIcons = null;
function texListShared() {
  if (!texListCacheIcons) texListCacheIcons = listVPK(TEXTURES_VPK);
  return texListCacheIcons;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Weapon icons come from each item def's image_inventory (prefab-aware).
// Collection icons come from the case item whose collection_reference names the
// collection; older collections without such a case simply get no icon and the
// UI falls back to text-only rendering. Prefers the _large icon variant.
function extractIcons(itemsGame, weaponRegistry, machineByDisplay) {
  const tex = texListShared();
  const misc = miscList();
  const stagingDir = path.join(STAGING, 'extracted');
  ensureDir(stagingDir);

  const jobs = []; // { outRel, candidates, vpkSource?, vpkPath?, assign }
  for (const w of weaponRegistry.values()) {
    const gameItem = kvGet(itemsGame.items, String(w.itemDefIndex));
    const img = gameItem ? resolveItemField(itemsGame, gameItem, 'image_inventory') : null;
    if (!img) continue;
    const base = String(img).replace(/\\/g, '/').toLowerCase();
    jobs.push({
      outRel: `icons/weapons/${w.key}.png`,
      candidates: [`materials/${base}_large.vtf`, `materials/${base}.vtf`],
      assign: (rel) => { w.icon = rel; },
    });
  }

  // Map collection machine name -> case image_inventory.
  const machineToImage = new Map();
  for (const it of Object.values(itemsGame.items)) {
    if (!it || typeof it !== 'object') continue;
    const ref = resolveItemField(itemsGame, it, 'collection_reference');
    if (!ref) continue;
    const img = resolveItemField(itemsGame, it, 'image_inventory');
    if (!img) continue;
    const key = String(ref).toLowerCase();
    if (!machineToImage.has(key)) machineToImage.set(key, String(img).replace(/\\/g, '/').toLowerCase());
  }

  const collectionIcons = {};
  for (const [displayName, machineName] of machineByDisplay) {
    const img = machineToImage.get(String(machineName).toLowerCase());
    if (!img) continue;
    jobs.push({
      outRel: `icons/collections/${slugify(machineName)}.png`,
      candidates: [`materials/${img}_large.vtf`, `materials/${img}.vtf`],
      assign: (rel) => { collectionIcons[displayName] = rel; },
    });
  }

  const fromTex = [];
  const fromMisc = [];
  for (const job of jobs) {
    job.vpkPath = job.candidates.find((c) => tex.has(c)) || null;
    if (job.vpkPath) { fromTex.push(job.vpkPath); continue; }
    job.vpkPath = job.candidates.find((c) => misc.has(c)) || null;
    if (job.vpkPath) fromMisc.push(job.vpkPath);
  }
  extractBatch(TEXTURES_VPK, fromTex, stagingDir);
  extractBatch(MISC_VPK, fromMisc, stagingDir);

  let ok = 0;
  let fail = 0;
  for (const job of jobs) {
    if (!job.vpkPath) { fail++; continue; }
    try {
      const dec = decodeVTF(fs.readFileSync(path.join(stagingDir, job.vpkPath)));
      const outPath = path.join(PUBLIC_DATA, job.outRel);
      ensureDir(path.dirname(outPath));
      fs.writeFileSync(outPath, encodePNG(dec.rgba, dec.width, dec.height));
      job.assign(job.outRel);
      ok++;
    } catch (e) {
      fail++;
      log(`[icons] failed ${job.outRel}: ${e.message}`);
    }
  }
  log(`[icons] wrote ${ok} icons (${Object.keys(collectionIcons).length} collections), ${fail} unavailable`);
  return collectionIcons;
}

// ---------------------------------------------------------------------------
// Extract referenced VTFs from the vpks and decode to PNG.
// ---------------------------------------------------------------------------

async function extractAndDecodeTextures(allTextureRefs) {
  log(`[textures] indexing vpk contents ...`);
  const texList = listVPK(TEXTURES_VPK);
  const misc = miscList();

  // Map public "textures/foo.webp" -> vpk "materials/foo.vtf".
  const wanted = []; // { pub, vpk, vpkSource }
  for (const pub of allTextureRefs) {
    const rel = pub.replace(/^textures\//, '').replace(/\.webp$/i, '');
    const vpkPath = `materials/${rel}.vtf`.toLowerCase();
    let src = null;
    if (texList.has(vpkPath)) src = 'tex';
    else if (misc.has(vpkPath)) src = 'misc';
    wanted.push({ pub, vpk: vpkPath, src });
  }
  const missing = wanted.filter((w) => !w.src);
  log(`[textures] ${wanted.length} referenced, ${missing.length} not present in vpks`);

  const stagingMat = path.join(STAGING, 'extracted');
  ensureDir(stagingMat);
  const byTex = wanted.filter((w) => w.src === 'tex').map((w) => w.vpk);
  const byMisc = wanted.filter((w) => w.src === 'misc').map((w) => w.vpk);
  log(`[textures] extracting ${byTex.length} from textures.vpk, ${byMisc.length} from misc.vpk ...`);
  extractBatch(TEXTURES_VPK, byTex, stagingMat);
  extractBatch(MISC_VPK, byMisc, stagingMat);

  log('[textures] decoding VTF -> WebP (lossless) ...');
  let ok = 0; let fail = 0;
  const metadata = {};
  const failList = [];
  for (const w of wanted) {
    if (!w.src) { fail++; failList.push({ ...w, err: 'not in vpk' }); continue; }
    const vtfPath = path.join(stagingMat, w.vpk);
    const outPath = path.join(PUBLIC_DATA, w.pub);
    try {
      const buf = fs.readFileSync(vtfPath);
      const dec = decodeVTF(buf);
      const hdr = parseVTFHeader(buf);
      metadata[w.pub] = {
        width: hdr.width, height: hdr.height, mipCount: hdr.mipCount,
        clampS: !!(hdr.flags & 0x4), clampT: !!(hdr.flags & 0x8),
        pointSample: !!(hdr.flags & 0x1), trilinear: !!(hdr.flags & 0x2),
        anisotropic: !!(hdr.flags & 0x10), noMip: !!(hdr.flags & 0x100), noLod: !!(hdr.flags & 0x200),
      };
      ensureDir(path.dirname(outPath));
      // exact:true is required alongside lossless:true - without it libwebp is free to discard
      // RGB data under fully-transparent pixels, which the compositor still reads independently
      // of alpha; dropping it would break bit-identical parity with the source VTF.
      await sharp(dec.rgba, { raw: { width: dec.width, height: dec.height, channels: 4 } })
        .webp({ lossless: true, effort: 4, exact: true })
        .toFile(outPath);
      ok++;
      if (ok % 200 === 0) log(`  ... ${ok} decoded`);
    } catch (e) {
      fail++;
      failList.push({ pub: w.pub, err: e.message });
    }
  }
  log(`[textures] decoded ${ok}, failed ${fail}`);
  if (failList.length) {
    fs.writeFileSync(path.join(STAGING, 'texture_failures.json'), JSON.stringify(failList, null, 1));
    log(`[textures] failure details -> staging/texture_failures.json`);
  }
  fs.writeFileSync(path.join(STAGING, 'texture_metadata.json'), JSON.stringify(metadata));

  // CMDLPanel (and therefore TF2's item inspection panel) always binds
  // materials/editor/cubemap as its local reflection cubemap. Keep the six
  // faces as a first-class viewer asset instead of synthesizing a gradient.
  const editorCubeVpk = 'materials/editor/cubemap.vtf';
  const editorCubeStage = path.join(stagingMat, editorCubeVpk);
  try {
    extractBatch(TEXTURES_VPK, [editorCubeVpk], stagingMat);
    const faces = decodeVTFCubemap(fs.readFileSync(editorCubeStage));
    const names = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
    const outDir = path.join(PUBLIC_DATA, 'env', 'editor-cubemap');
    ensureDir(outDir);
    faces.forEach((face, i) => {
      fs.writeFileSync(path.join(outDir, `${names[i]}.png`), encodePNG(face.rgba, face.width, face.height));
    });
    log('[textures] decoded TF2 editor cubemap (6 faces)');
  } catch (e) {
    log(`[textures] failed to decode TF2 editor cubemap: ${e.message}`);
  }
  return metadata;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function verify(manifestPaintkits, allTextureRefs, skipped) {
  log('\n===== VERIFICATION =====');
  // 1. Every referenced texture PNG exists.
  let missingPng = 0;
  for (const ref of allTextureRefs) {
    if (!fs.existsSync(path.join(PUBLIC_DATA, ref))) missingPng++;
  }
  log(`textures referenced: ${allTextureRefs.size}, missing PNG on disk: ${missingPng}`);

  // 2. Spot-check: walk recipe bundles and assert their texture refs exist.
  const recipesRoot = path.join(PUBLIC_DATA, 'recipes');
  let recipeBundles = 0; let variantCount = 0; let brokenRefs = 0;
  function collectRefs(node, out) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'texture_lookup' && node.texture) out.push(node.texture);
    if (node.type === 'select' && node.groups) out.push(node.groups);
    if (node.type === 'apply_sticker' && node.stickers) for (const s of node.stickers) { if (s.base) out.push(s.base); if (s.spec) out.push(s.spec); }
    if (node.nodes) for (const c of node.nodes) collectRefs(c, out);
  }
  if (fs.existsSync(recipesRoot)) {
    for (const f of fs.readdirSync(recipesRoot)) {
      if (!f.endsWith('.json')) continue;
      recipeBundles++;
      const bundle = JSON.parse(fs.readFileSync(path.join(recipesRoot, f), 'utf8'));
      variantCount += Object.keys(bundle.variants || {}).length;
      for (const tree of bundle.trees || []) {
        const refs = [];
        collectRefs(tree, refs);
        for (const r of refs) if (!fs.existsSync(path.join(PUBLIC_DATA, r))) brokenRefs++;
      }
    }
  }
  log(`recipe bundles on disk: ${recipeBundles}, variants: ${variantCount}, broken texture refs: ${brokenRefs}`);

  // 3. Spot-check three kits.
  const picks = [
    manifestPaintkits.find((p) => p.weapons.length === 1),
    manifestPaintkits.find((p) => p.hasTeamTextures && p.weapons.length > 10),
    manifestPaintkits.find((p) => p.name && /sticker|decal|autumn/i.test(p.name)) || manifestPaintkits[0],
  ].filter(Boolean);
  for (const p of picks) {
    log(`  spot-check kit ${p.id} "${p.name}" weapons=${p.weapons.length} team=${p.hasTeamTextures} perWear=${p.perWear}`);
  }

  log(`skipped weapon/kit resolutions: ${skipped.length}`);
  if (skipped.length) {
    const summary = {};
    for (const s of skipped) summary[s.reason] = (summary[s.reason] || 0) + 1;
    for (const [k, v] of Object.entries(summary)) log(`  skip[${k}] = ${v}`);
  }
  log('========================\n');
}

await main();
