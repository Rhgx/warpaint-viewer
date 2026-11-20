import assert from 'node:assert/strict';
import { test } from 'vitest';

import { downscaleRGBA } from '../extract/icons.mjs';
import { parseTextureDirectory } from '../extract/texture-directory.mjs';

test('icon downscale halves to fit and keeps transparent edges from darkening', () => {
  // 4x4: left half opaque red, right half fully transparent black.
  const pixels = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) pixels.push(...(x < 2 ? [255, 0, 0, 255] : [0, 0, 0, 0]));
  const half = downscaleRGBA(new Uint8Array(pixels), 4, 4, 2);
  assert.deepEqual([half.width, half.height], [2, 2]);
  assert.deepEqual([...half.rgba.slice(0, 8)], [255, 0, 0, 255, 0, 0, 0, 0]);
  const one = downscaleRGBA(new Uint8Array(pixels), 4, 4, 1);
  assert.deepEqual([...one.rgba], [255, 0, 0, 128]);
});

const page = (entries) => `
  <div class="introduction">
    <p>Intro.</p>
    <li><b>TL</b> - Texture layer or base texture.</li>
    <li><b>Macaw material</b> - More commonly known as albedo tint.</li>
  </div>
  ${entries}`;

const entry = (heading, body) => `
  <div class="texture_warpaint">
    <h4>${heading}</h4>
    <div class="contentinline"><img src="x.png"></div>
    <div class="contentinline">${body}</div>
  </div>`;

test('texture directory entries are keyed by heading id and keep text verbatim', () => {
  const { legend, entries } = parseTextureDirectory(page(entry('Pirnaha Mania (427)', `
    <h5>Base</h5>
    <li><b>Original</b>*</li>
    <h5>Textures</h5>
    <li><b>TL_1 &amp; TL_2</b> - "patterns/a"</li>
    <h5>Features</h5>
    <li><b>Macaw material</b></li>
  `)));
  assert.deepEqual(legend, [
    { term: 'TL', description: 'Texture layer or base texture.' },
    { term: 'Macaw material', description: 'More commonly known as albedo tint.' },
  ]);
  assert.deepEqual(entries, {
    427: { base: ['Original*'], textures: ['TL_1 & TL_2 - "patterns/a"'], features: ['Macaw material'] },
  });
});

test('texture directory rejects unrecognised markup instead of shipping partial data', () => {
  assert.throws(() => parseTextureDirectory(page(entry('No id here', '<h5>Textures</h5><li>a</li>'))), /heading/);
  assert.throws(() => parseTextureDirectory(page(entry('A (1)', '<h5>Textures</h5><li>a</li><h5>Credits</h5><li>b</li>'))), /unknown section/);
  assert.throws(() => parseTextureDirectory(page(entry('A (1)', '<h5>Base</h5><li>a</li>'))), /no textures/);
  assert.throws(() => parseTextureDirectory('<p>redesigned page</p>'), /introduction/);
});
