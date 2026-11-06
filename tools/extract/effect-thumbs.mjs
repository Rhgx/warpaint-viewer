// Effect menu thumbnails, made from the sprites each effect already draws with.
//   node tools/extract/effect-thumbs.mjs
//
// The game ships no icons for these effects. Run effects.mjs first: this reads public/data/effects/particles/
// and writes public/data/effects/thumbs/<effectId>.png.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';

const PARTICLES = resolve('public/data/effects/particles');
const OUT = resolve('public/data/effects/thumbs');
const OUT_SIZE = 48;

// Layers run bottom to top. A tint is the colour the effect's particles use, and a sprite without one keeps its own colours.
// `crop` keeps that share of the sprite's middle, for a sprite whose detail is too small to read at menu size.
const EFFECTS = [
  {
    id: 'hot',
    layers: [
      { file: 'effects_sc_hardglow.png', tint: [230, 120, 40] },
      { file: 'effects_fire_embers1.png', tint: [255, 200, 110], crop: 0.8 },
    ],
  },
  { id: 'isotope', layers: [{ file: 'effects_circle_nocull_altered.png', tint: [32, 255, 32] }] },
  { id: 'cool', layers: [{ file: 'effects_snowflake01.png', tint: [142, 218, 225] }] },
  // The sprite is a strip of 27 frames. Its first frame is a square at the top.
  { id: 'energy_orb', layers: [{ file: 'effects_comball_d_ar2_altfire1_d.png' }] },
  { id: 'sparkle', layers: [{ file: 'effects_tp_sparkle2.png', crop: 0.6 }] },
];

/** Additive sprites paint with brightness, so their brightness becomes alpha. */
async function layer({ file, tint, crop = 1 }) {
  const path = join(PARTICLES, file);
  const { width } = await sharp(path).metadata();
  const side = Math.round(width * crop);
  const inset = Math.round((width - side) / 2);
  const { data, info } = await sharp(path)
    .extract({ left: inset, top: inset, width: side, height: side })
    .resize(OUT_SIZE, OUT_SIZE)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 4) {
    const bright = Math.max(data[i], data[i + 1], data[i + 2]) / 255;
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = tint ? tint[c] : bright > 0 ? Math.min(255, data[i + c] / bright) : 0;
    }
    out[i + 3] = Math.round(bright * data[i + 3]);
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

mkdirSync(OUT, { recursive: true });
for (const { id, layers } of EFFECTS) {
  const [base, ...rest] = await Promise.all(layers.map(layer));
  await sharp(base)
    .composite(rest.map((input) => ({ input })))
    .png({ compressionLevel: 9 })
    .toFile(join(OUT, `${id}.png`));
  console.log(id);
}
