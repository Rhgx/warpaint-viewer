// Sticker artwork level-adjustment contract check.
//
//   node tools/verify/sticker-artwork.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'sticker-artwork-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', 'src/editor/stickerArtwork.ts', '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('Vite could not bundle the sticker artwork helper.');
  return pathToFileURL(path.join(BUILD_DIR, 'stickerArtwork.js')).href;
}

try {
  const {
    adjustStickerArtworkPixels,
    matchResolvedStickerArtwork,
    stickerArtworkNeedsComposedPreview,
    stickerLevelsAreIdentity,
  } = await import(bundleModule());
  assert.equal(stickerLevelsAreIdentity({ black: 0, white: 1, gamma: 1 }), true);
  assert.equal(stickerLevelsAreIdentity({ black: 0, white: 0.5, gamma: 1 }), false);
  assert.equal(stickerArtworkNeedsComposedPreview(['patterns/FFV3/square']), true);
  assert.equal(stickerArtworkNeedsComposedPreview(['textures/patterns/FFV3/groupsticker.webp']), true);
  assert.equal(stickerArtworkNeedsComposedPreview(['patterns/FFV3/black_square']), true);
  assert.equal(stickerArtworkNeedsComposedPreview(['patterns/FFV3/tf2logo']), false);
  const targets = [
    { bases: ['stickers/first'], quad: { tl: [0.1, 0.2], tr: [0.3, 0.2], bl: [0.1, 0.4] } },
    { bases: ['stickers/second'], quad: { tl: [0.5, 0.6], tr: [0.7, 0.6], bl: [0.5, 0.8] } },
  ];
  const expanded = [
    { base: 'templates/unrelated', destTl: [0, 0], destTr: [1, 0], destBl: [0, 1] },
    { base: 'textures/stickers/second.webp', destTl: [0.5, 0.6], destTr: [0.7, 0.6], destBl: [0.5, 0.8] },
    { base: 'stickers/first', destTl: [0.1, 0.2], destTr: [0.3, 0.2], destBl: [0.1, 0.4] },
  ];
  assert.deepEqual(
    matchResolvedStickerArtwork(targets, expanded).map((candidate) => candidate?.base),
    ['stickers/first', 'textures/stickers/second.webp'],
    'expanded template stickers must not shift authored artwork pairing',
  );

  const pixels = new Uint8ClampedArray([51, 128, 204, 128]);
  adjustStickerArtworkPixels(pixels, { black: 0.2, white: 0.8, gamma: 1 });
  assert.deepEqual([...pixels], [0, 128, 255, 128], 'RGB and alpha follow the compositor level range');

  const threshold = new Uint8ClampedArray([63, 64, 65, 255]);
  adjustStickerArtworkPixels(threshold, { black: 0.25, white: 0.25, gamma: 1 });
  assert.deepEqual([...threshold], [0, 255, 255, 255], 'degenerate ranges reproduce the compositor threshold');

  const gamma = new Uint8ClampedArray([128]);
  adjustStickerArtworkPixels(gamma, { black: 0, white: 1, gamma: 2 });
  assert.equal(gamma[0], 64, 'gamma is applied after the black and white range');
  console.log('[verify] sticker artwork levels passed');
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}
