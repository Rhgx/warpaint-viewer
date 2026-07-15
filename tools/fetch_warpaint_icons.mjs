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

const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
const kits = manifest.paintkits;
const weaponName = new Map(manifest.weapons.map((w) => [w.key, w.name]));

// War Paint can icons are per wear level; Factory New is the cleanest render.
// Decorated-era kits (Gun Mettle/Tough Break) predate War Paint items, so
// their only backpack renders are per weapon.
const canTitle = (kit) => `File:Backpack ${kit.name} War Paint Factory New.png`;
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
      if (!info?.thumburl) continue;
      out.set(normalized.get(page.title) ?? page.title, info.thumburl);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  return out;
}

const canUrls = await queryTitles(kits.map(canTitle));
const needWeapon = kits.filter((kit) => !canUrls.has(canTitle(kit)));
const weaponUrls = await queryTitles(needWeapon.map(weaponTitle).filter(Boolean));
console.log(`[wiki-icons] can icons: ${canUrls.size}, weapon-render fallbacks: ${weaponUrls.size}`);

let ok = 0;
const misses = [];
for (const kit of kits) {
  const thumb = canUrls.get(canTitle(kit)) ?? weaponUrls.get(weaponTitle(kit));
  if (!thumb) { misses.push(kit.name); continue; }
  const res = await fetch(thumb, { headers: { 'user-agent': UA } });
  if (!res.ok) { misses.push(`${kit.name} (http ${res.status})`); continue; }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(PUBLIC_DATA, `icons/paints/${kit.id}.png`), buf);
  ok++;
  if (ok % 50 === 0) console.log(`[wiki-icons] downloaded ${ok}...`);
  await new Promise((r) => setTimeout(r, 60)); // stay polite
}
console.log(`[wiki-icons] downloaded ${ok}, kept swatch fallback for ${misses.length}`);
if (misses.length) console.log('  misses:', misses.join(', '));
