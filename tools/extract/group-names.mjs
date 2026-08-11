// Download the curated TF2 paintable-weapon group reference and turn it into
// the compact lookup table consumed by the editor. The guide is deliberately
// kept as source data rather than scraped by the browser at runtime.
//
// Usage: node tools/extract/group-names.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = path.join(ROOT, 'src', 'editor', 'groupNames.generated.json');
const GUIDE_URL = 'https://steamcommunity.com/sharedfiles/filedetails/?id=3035470027&l=english';

function decodeHtml(fragment) {
  return fragment
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGuide(html) {
  const textures = {};
  const sectionPattern = /<div class="subSection detailBox"[^>]*>\s*<div class="subSectionTitle">\s*([\s\S]*?)\s*<\/div>\s*<div class="subSectionDesc">([\s\S]*?)<div style="clear: both"><\/div>/g;
  for (const section of html.matchAll(sectionPattern)) {
    const weapon = decodeHtml(section[1]);
    const tablePattern = /<div class="bb_table">([\s\S]*?)<\/div><br>/g;
    for (const table of section[2].matchAll(tablePattern)) {
      const cells = [...table[1].matchAll(/<div class="bb_table_t[hd]">([\s\S]*?)<\/div>/g)]
        .map((cell) => decodeHtml(cell[1]));
      if (cells[0] !== 'Texture Name' || !cells[1]) continue;

      const groups = {};
      for (let i = 2; i + 1 < cells.length; i += 2) {
        if (!/^\d+$/.test(cells[i]) || !cells[i + 1]) continue;
        groups[cells[i]] = cells[i + 1];
      }
      if (Object.keys(groups).length === 0) continue;

      const texture = cells[1].replace(/\\/g, '/').replace(/^materials\//i, '').toLowerCase();
      const previous = textures[texture];
      if (previous && JSON.stringify(previous.groups) !== JSON.stringify(groups)) {
        throw new Error(`The guide has conflicting names for ${texture}`);
      }
      textures[texture] = { weapon, groups };
    }
  }
  return textures;
}

const response = await fetch(GUIDE_URL, {
  headers: {
    'accept-language': 'en-US,en;q=0.9',
    'user-agent': 'warpaint-viewer group-name reference updater',
  },
});
if (!response.ok) throw new Error(`Could not download group-name reference (${response.status})`);

const textures = parseGuide(await response.text());
if (Object.keys(textures).length < 80) {
  throw new Error(`Only found ${Object.keys(textures).length} group textures; guide markup may have changed`);
}

const output = {
  // The source is a curated reference, not a Valve-authored part-name API.
  // Empty or unmapped values are intentionally omitted so the UI can fall
  // back honestly instead of presenting a fabricated part name.
  source: {
    title: 'War Paint Texture Groups Reference for War Paint Authors',
    url: GUIDE_URL.replace('&l=english', ''),
  },
  textures: Object.fromEntries(Object.entries(textures).sort(([left], [right]) => left.localeCompare(right))),
};

fs.writeFileSync(OUTPUT, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Wrote ${Object.keys(textures).length} group-texture name maps to ${path.relative(ROOT, OUTPUT)}`);
