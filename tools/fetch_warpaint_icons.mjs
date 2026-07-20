// Fetch pre-rendered War Paint backpack icons (spray can + pattern) from the
// TF2 wiki. The game renders these live from the paintkit, so they cannot be
// extracted from the VPKs; the wiki hosts the canonical renders. Kits the wiki
// does not know keep the pattern swatch that extract.mjs already generated.
//   node tools/fetch_warpaint_icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
const API = 'https://wiki.teamfortress.com/w/api.php';
const UA = 'warpaint-viewer-local-tool/1.0';
const THUMB_WIDTH = 128;
const WRITE_RETRIES = 5;

const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
const kits = manifest.paintkits;
const weaponName = new Map(manifest.weapons.map((w) => [w.key, w.name]));

// War Paint can icons are per wear level; Factory New is the cleanest render.
// Most paintkit proto defs below 200 are legacy decorated-weapon paints from
// Gun Mettle/Tough Break. The first two Jungle Inferno contract collections
// reuse that range but are actual War Paint items, as are all IDs 200+.
// Keep those namespaces explicit: similarly named wiki files can exist for
// both, and a can-first fallback can silently attach the wrong item type.
const FIRST_WAR_PAINT_ID = 200;
const EARLY_WAR_PAINT_COLLECTIONS = new Set([
  'Decorated War Hero Collection',
  'Contract Campaigner Collection',
]);
const isWarPaint = (kit) => kit.id >= FIRST_WAR_PAINT_ID || EARLY_WAR_PAINT_COLLECTIONS.has(kit.collection);
const wikiPaintName = (kit) => kit.name === 'Sarsaparilla Sprayed' ? 'Sarsparilla Sprayed' : kit.name;
const canTitle = (kit) => `File:Backpack ${wikiPaintName(kit)} War Paint Factory New.png`;
const weaponTitle = (kit) => {
  const name = weaponName.get(kit.weapons[0]);
  return name ? `File:Backpack ${kit.name} ${name} Factory New.png` : null;
};

// api.php normalizes titles (underscores, casing); map normalized -> original.
async function queryTitles(titles) {
  const out = new Map(); // original title -> thumburl
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    const url = `${API}?action=query&format=json&prop=imageinfo&iiprop=url&iiurlwidth=${THUMB_WIDTH}&titles=${encodeURIComponent(batch.join('|'))}`;
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    if (!res.ok) throw new Error(`api ${res.status}`);
    const data = await res.json();
    const normalized = new Map();
    for (const n of data.query?.normalized ?? []) normalized.set(n.to, n.from);
    for (const page of Object.values(data.query?.pages ?? {})) {
      const info = page.imageinfo?.[0];
      const imageUrl = info?.thumburl ?? info?.url;
      if (!imageUrl) continue;
      out.set(normalized.get(page.title) ?? page.title, imageUrl);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

async function writeIcon(file, data) {
  for (let attempt = 1; attempt <= WRITE_RETRIES; attempt++) {
    try {
      fs.writeFileSync(file, data);
      return;
    } catch (error) {
      if (attempt === WRITE_RETRIES || !['UNKNOWN', 'EBUSY', 'EPERM'].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 120));
    }
  }
}

const warPaintKits = kits.filter(isWarPaint);
const decoratedKits = kits.filter((kit) => !isWarPaint(kit));
const canUrls = await queryTitles(warPaintKits.map(canTitle));
const weaponUrls = await queryTitles(decoratedKits.map(weaponTitle).filter(Boolean));
console.log(`[wiki-icons] spray-can icons: ${canUrls.size}, decorated weapon icons: ${weaponUrls.size}`);

let ok = 0;
const misses = [];
for (const kit of kits) {
  const thumb = isWarPaint(kit)
    ? canUrls.get(canTitle(kit))
    : weaponUrls.get(weaponTitle(kit));
  if (!thumb) { misses.push(kit.name); continue; }
  const res = await fetch(thumb, { headers: { 'user-agent': UA } });
  if (!res.ok) { misses.push(`${kit.name} (http ${res.status})`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeIcon(path.join(PUBLIC_DATA, `icons/paints/${kit.id}.png`), buf);
  ok++;
  if (ok % 50 === 0) console.log(`[wiki-icons] downloaded ${ok}...`);
  await new Promise((r) => setTimeout(r, 60)); // stay polite
}
console.log(`[wiki-icons] downloaded ${ok}, kept swatch fallback for ${misses.length}`);
if (misses.length) console.log('  misses:', misses.join(', '));
