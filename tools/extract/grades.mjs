// Writes public/data/grades.json (paintkit name -> grade) from the local TF2 install.
// update:warpaints runs it on every refresh.
//
//   node tools/extract/grades.mjs
//
// items_game's item_collections nest each collection's war paint items under a rarity tier key
// (common ... ancient). Those keys map to the war paint grades (Civilian ... Elite). Names resolve
// as in warpaints.mjs, so keys match manifest.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadRoot, parseContainer, decodeType, DEF_TYPE } from '../lib/proto.mjs';
import { kvGet } from '../lib/kv.mjs';
import { loadLocalization } from '../lib/localization.mjs';
import {
  readItemsGameKV, indexItemsByName, paintkitIndexOf, paintkitDisplayName,
} from '../lib/items-game.mjs';
import { TF_DIR } from '../lib/vpk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const TF = `${TF_DIR}/tf`;
const VPD = `${TF}/scripts/protodefs/proto_defs.vpd`;
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

function main() {
  log('[grades] decoding paintkit definitions ...');
  const root = loadRoot();
  const c = parseContainer(VPD);
  const defs = decodeType(root, c.byType, DEF_TYPE.PAINTKIT_DEFINITION);

  log('[grades] loading localization ...');
  const locProto = loadLocalization(LOC_PROTO);

  // paintkit id -> display name, resolved as in warpaints.mjs.
  const nameById = new Map();
  for (const def of defs) {
    nameById.set(def.header.defindex, paintkitDisplayName(locProto, def));
  }
  log(`[grades] resolved ${nameById.size} paintkit names`);

  log('[grades] parsing items_game.txt ...');
  const kv = readItemsGameKV();
  const gameRoot = kvGet(kv, 'items_game');
  const itemsGame = {
    items: kvGet(gameRoot, 'items') || {},
    collections: kvGet(gameRoot, 'item_collections') || {},
  };
  const byName = indexItemsByName(itemsGame.items);

  // paintkit id -> grade, from the rarity-tier nesting of each non-reference collection.
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

  // Report manifest coverage when a manifest exists.
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
