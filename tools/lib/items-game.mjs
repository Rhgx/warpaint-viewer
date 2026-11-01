// Shared items_game.txt access. The parsed tree is cached in staging/, and item lookups resolve the same way everywhere.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseKV, kvGet } from './kv.mjs';
import { locLookup } from './localization.mjs';
import { TF_DIR } from './vpk.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGING = path.join(ROOT, 'staging');
const ITEMS_GAME = `${TF_DIR}/tf/scripts/items/items_game.txt`;

// Whole parsed tree (root key items_game), from the staging cache when present.
export function readItemsGameKV() {
  const cache = path.join(STAGING, 'items_game.json');
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const kv = parseKV(fs.readFileSync(ITEMS_GAME, 'utf8'));
  fs.mkdirSync(STAGING, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(kv));
  return kv;
}

// Item name -> definition. Collections refer to items by name, so this joins them.
export function indexItemsByName(items) {
  const byName = new Map();
  for (const it of Object.values(items)) {
    if (it && typeof it === 'object' && typeof it.name === 'string') byName.set(it.name, it);
  }
  return byName;
}

// Paintkit defindex from static_attrs, then attributes. Each may hold the value directly or under "value".
export function paintkitIndexOf(item) {
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

// Localized name, else the definition's own name, else a numeric placeholder so every paintkit has a unique key.
export function paintkitDisplayName(locProto, def) {
  return locLookup(locProto, def.loc_desctoken) || def.header.name || `paintkit_${def.header.defindex}`;
}
