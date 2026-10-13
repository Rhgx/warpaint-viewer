import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseTextureDirectory } from '../extract/texture-directory.mjs';

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

test('entries are keyed by the heading id and keep the page text verbatim', () => {
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

test('unrecognised markup fails instead of shipping partial data', () => {
  assert.throws(() => parseTextureDirectory(page(entry('No id here', '<h5>Textures</h5><li>a</li>'))), /heading/);
  assert.throws(() => parseTextureDirectory(page(entry('A (1)', '<h5>Textures</h5><li>a</li><h5>Credits</h5><li>b</li>'))), /unknown section/);
  assert.throws(() => parseTextureDirectory(page(entry('A (1)', '<h5>Base</h5><li>a</li>'))), /no textures/);
  assert.throws(() => parseTextureDirectory('<p>redesigned page</p>'), /introduction/);
});
