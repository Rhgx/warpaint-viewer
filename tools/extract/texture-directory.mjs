// Snapshot Pyxell's TF2 Warpaint Texture Directory into
// public/data/texture-directory.json, credited in the README and the Settings
// toggle that shows it.
//
//   npm run update:texture-directory
//
// The page is curated by hand and updates on its own schedule, so this is not
// part of update:warpaints. Entries are keyed by the paint kit ID printed in
// each heading rather than by name: a few headings spell the name differently
// from the game (e.g. "Pirnaha Mania"). Text is kept verbatim, including the
// page's own footnote asterisks.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

export const SOURCE_URL = 'https://pyxell.neocities.org/paintersworkshop/texturedirectory';
const SECTIONS = ['Base', 'Textures', 'Features', 'Notes'];
// The snapshot this guard was written against had 162 entries. Far fewer means
// the markup changed and the parser no longer finds them, not that paints left.
const MIN_ENTRIES = 150;

const ENTITIES = { amp: '&', quot: '"', apos: "'", '#39': "'", lt: '<', gt: '>', nbsp: ' ' };

function text(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|quot|apos|#39|lt|gt|nbsp);/g, (_, name) => ENTITIES[name])
    .replace(/\s+/g, ' ')
    .trim();
}

function listItems(html) {
  return [...html.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1])).filter(Boolean);
}

/**
 * Parses the directory page into its terminology legend and one entry per
 * paint kit ID. Throws on markup it does not recognise rather than guessing.
 */
export function parseTextureDirectory(html) {
  const intro = html.match(/<div class="introduction">([\s\S]*?)<\/div>/);
  if (!intro) throw new Error('introduction block not found');
  const legend = [...intro[1].matchAll(/<li>\s*<b>([\s\S]*?)<\/b>\s*-\s*([\s\S]*?)<\/li>/g)]
    .map((m) => ({ term: text(m[1]), description: text(m[2]) }));
  if (!legend.length) throw new Error('terminology legend not found');

  const entries = {};
  for (const block of html.split('<div class="texture_warpaint">').slice(1)) {
    const heading = block.match(/<h4>([\s\S]*?)<\/h4>/);
    const id = heading && text(heading[1]).match(/\((\d+)\)$/);
    if (!id) throw new Error(`entry without a "(id)" heading: ${text(block).slice(0, 80)}`);
    if (entries[id[1]]) throw new Error(`duplicate entry for paint kit ${id[1]}`);

    const entry = {};
    for (const m of block.matchAll(/<h5>([\s\S]*?)<\/h5>([\s\S]*?)(?=<h5>|<\/div>)/g)) {
      const section = text(m[1]);
      if (!SECTIONS.includes(section)) throw new Error(`paint kit ${id[1]}: unknown section "${section}"`);
      const items = listItems(m[2]);
      if (items.length) entry[section.toLowerCase()] = items;
    }
    if (!entry.textures) throw new Error(`paint kit ${id[1]}: no textures`);
    entries[id[1]] = entry;
  }
  return { legend, entries };
}

async function main() {
  console.log(`[texture-directory] fetching ${SOURCE_URL} ...`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const { legend, entries } = parseTextureDirectory(await res.text());

  const count = Object.keys(entries).length;
  if (count < MIN_ENTRIES) throw new Error(`only ${count} entries parsed (expected at least ${MIN_ENTRIES})`);
  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
  const known = new Set(manifest.paintkits.map((kit) => String(kit.id)));
  const unknown = Object.keys(entries).filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`entries for paint kits not in the manifest: ${unknown.join(', ')}`);

  const out = {
    source: SOURCE_URL,
    retrievedAt: new Date().toISOString().slice(0, 10),
    legend,
    entries,
  };
  fs.writeFileSync(path.join(PUBLIC_DATA, 'texture-directory.json'), `${JSON.stringify(out)}\n`);
  console.log(`[texture-directory] wrote ${count} entries (${known.size - count} paint kits not covered)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[texture-directory] ${err.message}`);
    process.exit(1);
  });
}
