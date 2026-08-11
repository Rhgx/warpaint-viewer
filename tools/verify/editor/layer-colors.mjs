// Texture-aware editor layer-colour contract check.
//
//   node tools/verify/editor/layer-colors.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'layer-colors-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', 'src/editor/layerMap.ts', '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('Vite could not bundle the layer colour chooser.');
  return pathToFileURL(path.join(BUILD_DIR, 'layerMap.js')).href;
}

function thumbnail(red, green, blue, alpha = 255) {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let pixel = 0; pixel < 16 * 16; pixel += 1) {
    data.set([red, green, blue, alpha], pixel * 4);
  }
  return { width: 16, height: 16, data };
}

function isFiniteColor(color) {
  return color.length === 3 && color.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1);
}

try {
  const { EDITOR_LAYER_MAP_COLORS, chooseEditorLayerColors } = await import(bundleModule());
  const dark = thumbnail(8, 12, 18);
  const light = thumbnail(242, 236, 220);
  const vibrant = thumbnail(226, 38, 96);
  const transparent = thumbnail(255, 255, 255, 0);

  const ordinary = chooseEditorLayerColors([
    { thumbnail: dark, fallbackIndex: 0 },
    { thumbnail: light, fallbackIndex: 1 },
    { thumbnail: vibrant, fallbackIndex: 2 },
  ]);
  assert.equal(ordinary.length, 3);
  assert.ok(ordinary.every(isFiniteColor), 'dark, light, and vibrant textures choose finite RGB colours');

  assert.deepEqual(
    chooseEditorLayerColors([{ thumbnail: transparent, fallbackIndex: 4 }]),
    [EDITOR_LAYER_MAP_COLORS[4]],
    'fully transparent artwork retains the exact indexed fallback',
  );
  assert.deepEqual(
    chooseEditorLayerColors([{ thumbnail: null, fallbackIndex: 5 }]),
    [EDITOR_LAYER_MAP_COLORS[5]],
    'missing artwork retains the exact indexed fallback',
  );

  const sameTexture = [
    { thumbnail: vibrant, fallbackIndex: 0 },
    { thumbnail: vibrant, fallbackIndex: 1 },
    { thumbnail: vibrant, fallbackIndex: 2 },
  ];
  const first = chooseEditorLayerColors(sameTexture);
  const second = chooseEditorLayerColors(sameTexture);
  assert.deepEqual(first, second, 'identical input always chooses the same colour order');
  assert.equal(new Set(first.map((color) => color.join(','))).size, first.length, 'same-texture layers stay distinct');
  assert.ok(first.flat().every((channel) => Number.isFinite(channel)), 'all output channels are finite');
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log('[verify] texture-aware editor layer colours passed');
