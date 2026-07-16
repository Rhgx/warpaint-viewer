// One-off script: build a paintkit name -> grade (rarity) mapping from the local
// TF2 install and write it to public/data/grades.json.
//
//   node tools/extract-grades.mjs
//
// Source of truth: items_game.txt's item_collections block nests each collection's
// war paint items under a rarity tier key (common/uncommon/rare/mythical/legendary/
// ancient). Those tier keys are the same internal names items_game uses for the
// war paint "grade" system (Rarity_Common_Weapon etc. localize to "Civilian",
// "Freelance", "Mercenary", "Commando", "Assassin", "Elite"). Paintkit names are
// resolved the same way extract.mjs resolves them, so keys line up with the
// generated manifest without any extra normalization.
//
// This reads the same local files extract.mjs reads (no network, no re-download)
// and does not modify extract.mjs or its output.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRoot, parseContainer, decodeType, DEF_TYPE } from './lib/proto.mjs';
import { parseKV, kvGet } from './lib/kv.mjs';
import { loadLocalization, locLookup } from './lib/localization.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STAGING = path.join(ROOT, 'staging');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const TF = 'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2/tf';
const VPD = `${TF}/scripts/protodefs/proto_defs.vpd`;
const ITEMS_GAME = `${TF}/scripts/items/items_game.txt`;
const LOC_PROTO = `${TF}/resource/tf_proto_obj_defs_english.txt`;

// items_game rarity tier name -> war paint grade (see Rarity_*_Weapon loc tokens).
const TIER_TO_GRADE = {
  common: 'civilian',
  uncommon: 'freelance',
  rare: 'mercenary',
  mythical: 'commando',
  legendary: 'assassin',
  ancient: 'elite',
};

function log(...a) { console.log(...a); }

function loadItemsGame() {
  const cache = path.join(STAGING, 'items_game.json');
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const kv = parseKV(fs.readFileSync(ITEMS_GAME, 'utf8'));
  fs.mkdirSync(STAGING, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(kv));
  return kv;
}

function paintkitIndexOf(item) {
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
}

function main() {
  log('[grades] decoding paintkit definitions ...');
  const root = loadRoot();
  const c = parseContainer(VPD);
  const defs = decodeType(root, c.byType, DEF_TYPE.PAINTKIT_DEFINITION);

  log('[grades] loading localization ...');
  const locProto = loadLocalization(LOC_PROTO);

  // paintkit id -> display name, resolved exactly as extract.mjs resolves it.
  const nameById = new Map();
  for (const def of defs) {
    const id = def.header.defindex;
    const name = locLookup(locProto, def.loc_desctoken) || def.header.name || `paintkit_${id}`;
    nameById.set(id, name);
  }
  log(`[grades] resolved ${nameById.size} paintkit names`);

  log('[grades] parsing items_game.txt ...');
  const kv = loadItemsGame();
  const gameRoot = kvGet(kv, 'items_game');
  const itemsGame = {
    items: kvGet(gameRoot, 'items') || {},
    collections: kvGet(gameRoot, 'item_collections') || {},
  };
  const byName = new Map();
  for (const it of Object.values(itemsGame.items)) {
    if (it && typeof it === 'object' && typeof it.name === 'string') byName.set(it.name, it);
  }

  // paintkit id -> grade, from the rarity-tier nesting under each non-reference
  // collection's items block.
  const gradeById = new Map();
  let conflicts = 0;
  for (const entry of Object.values(itemsGame.collections)) {
    if (!entry || typeof entry !== 'object') continue;
    if (kvGet(entry, 'is_reference_collection')) continue;
    const itemsBlock = kvGet(entry, 'items');
    if (!itemsBlock || typeof itemsBlock !== 'object') continue;
    for (const [tierKey, tierItems] of Object.entries(itemsBlock)) {
      const grade = TIER_TO_GRADE[tierKey.toLowerCase()];
      if (!grade || !tierItems || typeof tierItems !== 'object') continue;
      for (const itemName of Object.keys(tierItems)) {
        const item = byName.get(itemName);
        if (!item) continue;
        const pk = paintkitIndexOf(item);
        if (pk == null || !Number.isFinite(pk)) continue;
        if (gradeById.has(pk) && gradeById.get(pk) !== grade) {
          log(`[grades] paintkit ${pk} has conflicting grades: keeping "${gradeById.get(pk)}", ignoring "${grade}"`);
          conflicts++;
          continue;
        }
        gradeById.set(pk, grade);
      }
    }
  }
  log(`[grades] mapped ${gradeById.size} paintkits to a grade (${conflicts} conflicts skipped)`);

  // Build the name -> grade output, checking for name collisions across ids.
  const gradeByName = {};
  let nameConflicts = 0;
  for (const [id, grade] of gradeById) {
    const name = nameById.get(id);
    if (!name) continue;
    if (gradeByName[name] !== undefined && gradeByName[name] !== grade) {
      log(`[grades] name "${name}" (paintkit ${id}) already mapped to "${gradeByName[name]}", now sees "${grade}"`);
      nameConflicts++;
      continue;
    }
    gradeByName[name] = grade;
  }
  log(`[grades] ${Object.keys(gradeByName).length} unique names mapped (${nameConflicts} name conflicts skipped)`);

  const sorted = Object.fromEntries(Object.keys(gradeByName).sort().map((k) => [k, gradeByName[k]]));
  fs.mkdirSync(PUBLIC_DATA, { recursive: true });
  const outPath = path.join(PUBLIC_DATA, 'grades.json');
  fs.writeFileSync(outPath, JSON.stringify(sorted, null, 1));
  log(`[grades] wrote ${outPath}`);

  // Cross-check against the current manifest, if present, so coverage is visible
  // without a separate step.
  const manifestPath = path.join(PUBLIC_DATA, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const total = manifest.paintkits.length;
    const matched = manifest.paintkits.filter((p) => sorted[p.name] !== undefined).length;
    log(`[grades] manifest coverage: ${matched}/${total} paintkits matched`);
    const unmatched = manifest.paintkits.filter((p) => sorted[p.name] === undefined);
    if (unmatched.length) {
      log(`[grades] unmatched paintkit names: ${unmatched.map((p) => p.name).join(', ')}`);
    }
  }
}

main();
