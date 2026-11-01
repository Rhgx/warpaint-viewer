// Fetch pre-rendered War Paint backpack icons from the TF2 wiki; the VPKs lack them because the
// game renders them live. Kits the wiki lacks keep their swatch from warpaints.mjs.
//   node tools/extract/warpaint-icons.mjs [--force]
// Only kits with no icon, or a swatch listed in staging/swatch_icons.json, are fetched unless
// --force is passed. Failures are logged, never thrown; an icon is replaced only after its download.
// Thumbnails are transcoded to lossless WebP on write.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

import { loadSwatchedIds, saveSwatchedIds } from './icons.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
const STAGING = path.join(ROOT, 'staging');
const SWATCH_STATE_PATH = path.join(STAGING, 'swatch_icons.json');
const API = 'https://wiki.teamfortress.com/w/api.php';
const UA = 'warpaint-viewer-local-tool/1.0';
const THUMB_WIDTH = 128;
const WRITE_RETRIES = 5;

const FORCE = process.argv.slice(2).includes('--force');

// Spray-can renders are per wear level; Factory New is the cleanest. IDs below 200 are mostly
// decorated-weapon paints, but the collections in EARLY_WAR_PAINT_COLLECTIONS are War Paints.
// Keep the namespaces apart: similarly named wiki files exist for both.
const FIRST_WAR_PAINT_ID = 200;
const EARLY_WAR_PAINT_COLLECTIONS = new Set([
  'Decorated War Hero Collection',
  'Contract Campaigner Collection',
]);
const isWarPaint = (kit) => kit.id >= FIRST_WAR_PAINT_ID || EARLY_WAR_PAINT_COLLECTIONS.has(kit.collection);
const wikiPaintName = (kit) => kit.name === 'Sarsaparilla Sprayed' ? 'Sarsparilla Sprayed' : kit.name;
const canTitle = (kit) => `File:Backpack ${wikiPaintName(kit)} War Paint Factory New.png`;

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

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
  const kits = manifest.paintkits;
  const weaponName = new Map(manifest.weapons.map((w) => [w.key, w.name]));
  const weaponTitle = (kit) => {
    const name = weaponName.get(kit.weapons[0]);
    return name ? `File:Backpack ${kit.name} ${name} Factory New.png` : null;
  };

  const swatchedIds = loadSwatchedIds(SWATCH_STATE_PATH);
  const needsFetch = (kit) => {
    if (FORCE) return true;
    const iconPath = path.join(PUBLIC_DATA, `icons/paints/${kit.id}.webp`);
    return !fs.existsSync(iconPath) || swatchedIds.has(kit.id);
  };
  const candidates = kits.filter(needsFetch);
  console.log(`[wiki-icons] ${candidates.length}/${kits.length} kits need a fetch${FORCE ? ' (--force)' : ''}`);
  if (!candidates.length) return;

  const warPaintKits = candidates.filter(isWarPaint);
  const decoratedKits = candidates.filter((kit) => !isWarPaint(kit));
  const canUrls = await queryTitles(warPaintKits.map(canTitle));
  const weaponUrls = await queryTitles(decoratedKits.map(weaponTitle).filter(Boolean));
  console.log(`[wiki-icons] spray-can icons: ${canUrls.size}, decorated weapon icons: ${weaponUrls.size}`);

  let ok = 0;
  const misses = [];
  for (const kit of candidates) {
    const thumb = isWarPaint(kit)
      ? canUrls.get(canTitle(kit))
      : weaponUrls.get(weaponTitle(kit));
    if (!thumb) { misses.push(kit.name); continue; }
    const res = await fetch(thumb, { headers: { 'user-agent': UA } });
    if (!res.ok) { misses.push(`${kit.name} (http ${res.status})`); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    let webp;
    try {
      webp = await sharp(buf).webp({ lossless: true, effort: 6, exact: true }).toBuffer();
    } catch (error) { misses.push(`${kit.name} (${error.message})`); continue; }
    await writeIcon(path.join(PUBLIC_DATA, `icons/paints/${kit.id}.webp`), webp);
    swatchedIds.delete(kit.id); // now a real wiki render, not a placeholder swatch
    ok++;
    if (ok % 50 === 0) console.log(`[wiki-icons] downloaded ${ok}...`);
    await new Promise((r) => setTimeout(r, 60)); // stay polite
  }
  saveSwatchedIds(SWATCH_STATE_PATH, swatchedIds);
  console.log(`[wiki-icons] downloaded ${ok}, kept swatch fallback for ${misses.length}`);
  if (misses.length) console.log('  misses:', misses.join(', '));
}

try {
  await main();
} catch (error) {
  // Best-effort: update:warpaints must still succeed if the wiki is unreachable.
  console.log(`[wiki-icons] skipped: ${error.message}`);
}
