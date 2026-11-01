// TF2 Warpaint Viewer data extraction pipeline entry point.
//   node tools/extract/warpaints.mjs [--only <step>] [--force]
// Steps: protodefs-base, export-snapshot, recipes, weapons, textures, icons, manifest, verify.
// The proto decode always runs first. --force rebuilds textures and icons; otherwise outputs
// whose source VPK data is unchanged are reused.
// Writes under public/data/ and staging/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRoot, parseContainer, decodeType, DEF_TYPE } from '../lib/proto.mjs';
import { kvGet } from '../lib/kv.mjs';
import { loadLocalization, locLookup } from '../lib/localization.mjs';
import {
  buildIndex, resolveRecipe, WEAPON_SLOTS, texturePublicPath,
} from '../lib/resolve.mjs';
import {
  readItemsGameKV, indexItemsByName, paintkitIndexOf, paintkitDisplayName,
} from '../lib/items-game.mjs';
import { listVPK, TEXTURES_VPK, MISC_VPK, TF_DIR } from '../lib/vpk.mjs';
import { buildBundle } from '../lib/recipe-pack.mjs';
import { extractInventoryIcons, generatePaintIcons, pickPaintIconRef } from './icons.mjs';
import { readImageDimensions } from './image-dimensions.mjs';
import { resolveWeaponMaterials } from './materials.mjs';
import {
  computeVpkFingerprint, loadExtractState, saveExtractState, vpkFingerprintMatches,
} from './state.mjs';
import { extractAndDecodeTextures } from './textures.mjs';
import { verifyExtraction } from './verify.mjs';
import { extractModelAttachment } from './attachments.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const STAGING = path.join(ROOT, 'staging');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const TF = `${TF_DIR}/tf`;
const VPD = `${TF}/scripts/protodefs/proto_defs.vpd`;
const LOC_PROTO = `${TF}/resource/tf_proto_obj_defs_english.txt`;
const LOC_ENGLISH = `${TF}/resource/tf_english.txt`;

const WEAR_LEVELS = [0.2, 0.4, 0.6, 0.8, 1.0];
const WEAR_NAMES = ['Factory New', 'Minimal Wear', 'Field-Tested', 'Well-Worn', 'Battle Scarred'];
const COMPOSITE_1024_WEAPONS = new Set(['c_flameball', 'c_holymackerel', 'c_lochnload', 'c_quadball']);
// Community proto definitions can reference stock textures that no shipped recipe uses;
// ship them so imported paints fall back to TF2 like built-in recipe inputs.
const CUSTOM_DEFINITION_TEXTURE_REFS = [
  'textures/models/workshop/weapons/c_models/c_blackbox/p_blackbox_groups_02.webp',
  'textures/models/weapons/c_models/c_flameball/p_flameball_ao.webp',
  'textures/models/weapons/c_models/c_knife/p_knife_albedo_engraving.webp',
  'textures/models/weapons/c_models/c_stickybomb_launcher/p_stickybomb_launcher_groups_03.webp',
  'textures/models/weapons/c_models/c_stickybomb_launcher/p_stickybomb_launcher_groups_05.webp',
];

function log(...a) { console.log(...a); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function collectLayerPreviewRefs(node, refs) {
  if (!node?.nodes) return;
  node.nodes.forEach((child, index) => {
    // Skip the leftmost (unmasked base) texture: its layer row uses the full-size texture.
    if (child.type === 'select' && index > 0) {
      const collectTextures = (candidate) => {
        if (candidate.type === 'texture_lookup') refs.add(candidate.texture);
        for (const nested of candidate.nodes || []) collectTextures(nested);
      };
      collectTextures(node.nodes[index - 1]);
    } else {
      collectLayerPreviewRefs(child, refs);
    }
  });
}

const EXTRACT_STATE_PATH = path.join(STAGING, 'extract_state.json');

function loadItemsGame() {
  const kv = readItemsGameKV();
  const root = kvGet(kv, 'items_game');
  return {
    items: kvGet(root, 'items') || {},
    prefabs: kvGet(root, 'prefabs') || {},
    collections: kvGet(root, 'item_collections') || {},
  };
}

// Paintkit defindex -> localized collection name. Items may be nested under rarity grade keys.
function buildCollectionMap(itemsGame, locEnglish, locProto) {
  const machineByDisplay = new Map(); // display name -> items_game collection machine name
  const byName = indexItemsByName(itemsGame.items);

  const leafNames = (block, out) => {
    for (const [k, v] of Object.entries(block)) {
      if (v && typeof v === 'object') leafNames(v, out);
      else out.push(k);
    }
    return out;
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

// items_game item index -> weapon key. Imported proto_defs name weapons by this index, so the
// browser needs this map. Reskins share a model, so the mapping is many-to-one.
function buildItemDefMap(itemsGame, weaponRegistry) {
  const map = {};
  for (const [index, item] of Object.entries(itemsGame.items)) {
    if (!/^\d+$/.test(index) || !item || typeof item !== 'object') continue;
    const key = modelStem(resolveItemField(itemsGame, item, 'model_player'));
    if (key && weaponRegistry.has(key)) map[index] = key;
  }
  return map;
}

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
  return {
    defs, itemDefs, operations, variables, byType: c.byType,
  };
}

// Non-paintkit defTypes shipped as raw protobuf blocks in protodefs-base.bin. Community JSON
// fragments reference them by index but supply their own paintkit definitions (defType 9,
// 90%+ of the container), so the browser needs these without the rest.
const BASE_BLOB_DEF_TYPES = [
  DEF_TYPE.PAINTKIT_VARIABLES,
  DEF_TYPE.PAINTKIT_OPERATION,
  DEF_TYPE.PAINTKIT_ITEM_DEFINITION,
  10, // DEF_TYPE_HEADER_ONLY, not named in proto.mjs DEF_TYPE but tagged the same way by the container.
];

function stepProtodefsBase(byType) {
  const chunks = [];
  for (const defType of BASE_BLOB_DEF_TYPES) {
    const list = byType[defType] || [];
    const header = Buffer.alloc(8);
    header.writeInt32LE(defType, 0);
    header.writeInt32LE(list.length, 4);
    chunks.push(header);
    for (const block of list) {
      const size = Buffer.alloc(4);
      size.writeInt32LE(block.size, 0);
      chunks.push(size, block.buffer);
    }
  }
  const bytes = Buffer.concat(chunks);
  const outPath = path.join(PUBLIC_DATA, 'protodefs-base.bin');
  fs.writeFileSync(outPath, bytes);
  log(`[protodefs-base] wrote ${outPath} (${bytes.length} bytes) for defTypes ${BASE_BLOB_DEF_TYPES.join(',')}`);
}

// Named weapon slots plus the old-style repeated item[] of a paintkit definition.
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

// Export builder snapshot. A pack splices a paintkit into a complete proto_defs container and
// names it in a complete localization file. Neither can be partial: anything under tf/custom/
// shadows the game's copy, so a stub would strip every other paint from the client.
const LOC_PROTO_PATTERN = /^tf_proto_obj_defs_([a-z]+)\.txt$/i;

// TF2 build of these files (steam.inf PatchVersion). A pack from a stale snapshot removes newer paints.
function readGameBuild() {
  try {
    const inf = fs.readFileSync(`${TF}/steam.inf`, 'utf8');
    return /^PatchVersion=(.+)$/m.exec(inf)?.[1].trim() ?? null;
  } catch {
    return null;
  }
}

function stepExportSnapshot() {
  fs.copyFileSync(VPD, path.join(PUBLIC_DATA, 'protodefs-full.bin'));
  log(`[export-snapshot] wrote protodefs-full.bin (${fs.statSync(VPD).size} bytes)`);

  const outDir = path.join(PUBLIC_DATA, 'protodefs-loc');
  ensureDir(outDir);
  const languages = [];
  for (const entry of fs.readdirSync(`${TF}/resource`)) {
    const language = LOC_PROTO_PATTERN.exec(entry)?.[1].toLowerCase();
    if (!language) continue;
    // Copied byte for byte: UTF-16LE, BOM and CRLF are all required by the engine's KeyValues reader.
    fs.copyFileSync(`${TF}/resource/${entry}`, path.join(outDir, `${language}.txt`));
    languages.push(language);
  }
  log(`[export-snapshot] wrote protodefs-loc/ (${languages.length} languages: ${languages.sort().join(', ')})`);
}

async function main() {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
  const run = (name) => !only || only === name;
  const FORCE = args.includes('--force');

  ensureDir(PUBLIC_DATA);
  ensureDir(STAGING);

  const extractState = loadExtractState(EXTRACT_STATE_PATH);
  const currentVpkFingerprint = computeVpkFingerprint();
  const vpkChanged = FORCE || !vpkFingerprintMatches(extractState.vpkFingerprint, currentVpkFingerprint);
  if (FORCE) log('[extract] --force: rebuilding textures and icons from scratch');
  else if (vpkChanged) log('[extract] source vpks changed since last run; re-checking every texture and icon');
  else log('[extract] source vpks unchanged; skipping textures and icons whose output already exists');

  const { defs, itemDefs, operations, byType } = stepProtodefs();
  const ctx = buildIndex(operations, itemDefs);

  if (run('protodefs-base')) stepProtodefsBase(byType);
  if (run('export-snapshot')) stepExportSnapshot();

  log('[items] parsing items_game.txt ...');
  const itemsGame = loadItemsGame();
  log(`[items] items=${Object.keys(itemsGame.items).length} prefabs=${Object.keys(itemsGame.prefabs).length}`);

  log('[loc] loading localization ...');
  const locProto = loadLocalization(LOC_PROTO);
  const locEnglish = loadLocalization(LOC_ENGLISH);

  const { byPaintkit: collectionByPaintkit, machineByDisplay } = buildCollectionMap(itemsGame, locEnglish, locProto);
  log(`[collections] mapped ${collectionByPaintkit.size} paintkits to collections`);

  log('[recipes] resolving recipes ...');
  // The compositor derives an omitted sticker spec as <base>_s. Keep that ref only when it is
  // shipped; otherwise Source binds black and the sticker is matte.
  const compositorVpkPaths = new Set([...listVPK(TEXTURES_VPK), ...listVPK(MISC_VPK)]);
  const manifestPaintkits = [];
  const paintIconRefByKit = new Map(); // paintkit id -> representative pattern texture ref
  const weaponRegistry = new Map(); // weaponKey -> { key, name, itemDefIndex, modelPath }
  const allTextureRefs = new Set();
  const layerPreviewRefs = new Set();
  // Ship every lightwarp, not just those stock materials name. Imported VMTs can ask for any
  // of the ~37 (each a few KB), e.g. Ghastly Guns lights its weapons with the Pyro's.
  for (const vpkPath of compositorVpkPaths) {
    if (!/lightwarp[^/]*\.vtf$/i.test(vpkPath)) continue;
    const ref = texturePublicPath(vpkPath);
    if (ref) allTextureRefs.add(ref);
  }
  for (const ref of CUSTOM_DEFINITION_TEXTURE_REFS) allTextureRefs.add(ref);
  const recipesToWrite = []; // { kitId, key, tree }
  const skipped = [];
  let recipeCount = 0;

  for (const def of defs) {
    const id = def.header.defindex;
    const slots = collectSlots(def);
    if (!slots.length) continue;
    const name = paintkitDisplayName(locProto, def);
    const hasTeam = !!def.has_team_textures;
    // Both teams always resolve: the game composites by the item's team regardless of
    // has_team_textures, which only drives the inspect panel's team buttons.
    const teams = ['red', 'blu'];

    const kitWeapons = new Set();
    const kitMaterialOverrides = {};
    const kitTextureRefs = new Set();
    let kitBluDiffers = false;
    const kitRecipes = []; // { weaponKey, team, trees:[per wear], refs }

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
      // Source does not apply a paint-kit material override to the paint can model.
      if (weaponKey !== 'paintkit_tool' && typeof materialOverride === 'string' && materialOverride) {
        kitMaterialOverrides[weaponKey] = materialOverride.toLowerCase();
      }

      const nWear = (itemDef.definition || []).length || 1;
      let redTrees = [];
      for (const team of teams) {
        const trees = [];
        const refs = new Set();
        for (let w = 0; w < nWear; w++) {
          const r = resolveRecipe(def, slot, itemDef, w, team, ctx);
          if (!r) { trees.push(null); continue; }
          addImplicitStickerSpecs(r.tree, compositorVpkPaths, r.textureRefs);
          collectLayerPreviewRefs(r.tree, layerPreviewRefs);
          for (const t of r.textureRefs) refs.add(t);
          trees.push(r.tree);
        }
        if (team === 'red') redTrees = trees;
        if (!trees.some((t) => t)) continue;
        if (team === 'blu' && trees.some((t, w) => JSON.stringify(t) !== JSON.stringify(redTrees[w]))) kitBluDiffers = true;
        kitRecipes.push({ weaponKey, team, trees, refs });
      }
    }

    if (!kitWeapons.size) { skipped.push({ id, reason: 'no resolvable weapons' }); continue; }

    // BLU is kept for every weapon or none: a per-weapon drop leaves BLU items without a texture.
    // Refs are added after this so a dropped pass adds none.
    const hasTeamTextures = hasTeam || kitBluDiffers;
    const keptRecipes = kitRecipes.filter((rec) => hasTeamTextures || rec.team === 'red');
    let kitPerWear = false;
    for (const rec of keptRecipes) {
      for (const t of rec.refs) { allTextureRefs.add(t); kitTextureRefs.add(t); }
      const nonNull = rec.trees.filter((t) => t);
      if (nonNull.some((t) => JSON.stringify(t) !== JSON.stringify(nonNull[0]))) kitPerWear = true;
    }

    // Emit recipe variants (bundled per kit id below).
    for (const rec of keptRecipes) {
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
      hasTeamTextures,
      perWear: kitPerWear,
      weapons: [...kitWeapons].sort(),
      ...(Object.keys(kitMaterialOverrides).length ? { materialOverrides: kitMaterialOverrides } : {}),
    });
    const firstTree = keptRecipes[0]?.trees.find((t) => t);
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

  const weaponModels = {};
  let materialOverrides = {};
  if (run('weapons') || run('manifest') || run('textures')) {
    log('[weapons] resolving weapon material params ...');
    materialOverrides = resolveWeaponMaterials({
      weaponRegistry, allTextureRefs, weaponModels, manifestPaintkits, stagingPath: STAGING, log,
    });
  }

  let textureMetadata = {};
  if (run('textures')) {
    const result = await extractAndDecodeTextures({
      allTextureRefs,
      layerPreviewRefs,
      publicDataPath: PUBLIC_DATA,
      stagingPath: STAGING,
      vpkChanged,
      force: FORCE,
      prevHashes: extractState.textureHashes,
      log,
    });
    textureMetadata = result.metadata;
    extractState.textureHashes = result.hashes;
    extractState.vpkFingerprint = currentVpkFingerprint;
    saveExtractState(EXTRACT_STATE_PATH, extractState);
  } else {
    const metadataPath = path.join(STAGING, 'texture_metadata.json');
    if (fs.existsSync(metadataPath)) textureMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  }

  let collectionIcons = {};
  if (run('icons') || run('manifest')) {
    const iconResult = await extractInventoryIcons({
      itemsGame,
      weaponRegistry,
      machineByDisplay,
      resolveItemField,
      publicDataPath: PUBLIC_DATA,
      stagingPath: STAGING,
      vpkChanged,
      force: FORCE,
      prevHashes: extractState.iconHashes,
      log,
    });
    collectionIcons = iconResult.collectionIcons;
    extractState.iconHashes = iconResult.hashes;
    extractState.vpkFingerprint = currentVpkFingerprint;
    saveExtractState(EXTRACT_STATE_PATH, extractState);
    await generatePaintIcons({
      manifestPaintkits, paintIconRefByKit, publicDataPath: PUBLIC_DATA, stagingPath: STAGING, force: FORCE, log,
    });
  }

  if (run('manifest') || run('recipes')) {
    // Read back so a partial run keeps what a full run wrote.
    let previousManifest = null;
    try {
      previousManifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
    } catch { /* first run, or unreadable: fall through to whatever this run has */ }

    const weapons = [...weaponRegistry.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((w) => {
        const dimensions = readImageDimensions(PUBLIC_DATA, w.compositeTexture) || {
          width: COMPOSITE_1024_WEAPONS.has(w.key) ? 1024 : 2048,
          height: COMPOSITE_1024_WEAPONS.has(w.key) ? 1024 : 2048,
        };
        const iconCamera = w.modelPath ? extractModelAttachment(w.modelPath, 'icon_camera') : null;
        const roundVector = (values) => values.map((value) => Math.round(value * 1e6) / 1e6);
        // Keep attachments from the previous run: their assets come from the viewmodel import.
        const attachments = previousManifest?.weapons?.find((entry) => entry.key === w.key)?.attachments;
        return ({
        key: w.key,
        name: w.name,
        model: `models/${w.key}.glb`,
        ...(attachments ? { attachments } : {}),
        compositeWidth: dimensions.width,
        compositeHeight: dimensions.height,
        ...(w.icon ? { icon: w.icon } : {}),
        ...(iconCamera ? {
          iconCamera: {
            position: roundVector(iconCamera.pos),
            forward: roundVector(iconCamera.forward),
            up: roundVector(iconCamera.up),
          },
        } : {}),
        material: w.material || { phongExponent: null, phongBoost: 1, envmapTint: [0, 0, 0], normalMap: null },
      }); });
    const manifest = {
      generatedAt: new Date().toISOString(),
      gameBuild: readGameBuild(),
      paintkits: manifestPaintkits,
      weapons,
      materials: materialOverrides,
      // Textures come from the textures step. An empty map on --only manifest would delete
      // every entry the compositor reads, so keep the last full run's map.
      textures: Object.keys(textureMetadata).length ? textureMetadata : previousManifest?.textures ?? textureMetadata,
      collectionIcons,
      wearLevels: WEAR_LEVELS,
      wearNames: WEAR_NAMES,
    };
    ensureDir(PUBLIC_DATA);
    const manifestPath = path.join(PUBLIC_DATA, 'manifest.json');
    const manifestTempPath = `${manifestPath}.tmp`;
    fs.writeFileSync(manifestTempPath, JSON.stringify(manifest, null, 1));
    fs.renameSync(manifestTempPath, manifestPath);
    fs.writeFileSync(path.join(STAGING, 'weapon_models.json'), JSON.stringify(weaponModels, null, 1));
    const itemDefMap = buildItemDefMap(itemsGame, weaponRegistry);
    fs.writeFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), JSON.stringify(itemDefMap));
    log(`[manifest] wrote manifest.json (${manifest.paintkits.length} paintkits, ${manifest.weapons.length} weapons)`);
    log(`[manifest] wrote item-defs.json (${Object.keys(itemDefMap).length} item definition indexes)`);
    log(`[manifest] wrote staging/weapon_models.json (${Object.keys(weaponModels).length} weapons)`);
  }

  if (run('verify')) {
    verifyExtraction({ publicDataPath: PUBLIC_DATA, manifestPaintkits, allTextureRefs, skipped, log });
  }
}

function addImplicitStickerSpecs(node, vpkPaths, textureRefs) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'apply_sticker') {
    for (const sticker of node.stickers || []) {
      if (!sticker.base || sticker.spec) continue;
      const implicit = sticker.base.replace(/\.webp$/i, '_s.webp');
      const vpkPath = `materials/${implicit.replace(/^textures\//i, '').replace(/\.webp$/i, '.vtf')}`.toLowerCase();
      if (vpkPaths.has(vpkPath)) {
        sticker.spec = implicit;
        textureRefs.add(implicit);
      }
    }
  }
  for (const child of node.nodes || []) addImplicitStickerSpecs(child, vpkPaths, textureRefs);
}
await main();
