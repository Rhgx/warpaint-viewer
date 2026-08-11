// Viewer/2D sticker placement geometry contract check.
//
//   node tools/verify/editor/sticker-placement.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'sticker-placement-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', 'src/editor/viewerStickerPlacement.ts', '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('Vite could not bundle the sticker placement helpers.');
  return pathToFileURL(path.join(BUILD_DIR, 'viewerStickerPlacement.js')).href;
}

function assertUv(actual, expected, message) {
  assert.equal(actual.length, expected.length, message);
  for (let index = 0; index < actual.length; index += 1) {
    assert.ok(Math.abs(actual[index] - expected[index]) < 1e-9, message);
  }
}

try {
  const {
    constrainStickerQuadToTexture,
    nearestPeriodicUv,
    stickerQuadCenter,
    stickerQuadIsWithinTexture,
    moveStickerQuadToUv,
  } = await import(bundleModule());
  const quad = { tl: [0.2, 0.3], tr: [0.5, 0.4], bl: [0.1, 0.7] };
  const originalCentre = stickerQuadCenter(quad);
  assertUv(originalCentre, [0.3, 0.55], 'centre includes both affine basis vectors');

  const moved = moveStickerQuadToUv(quad, [0.7, 0.15]);
  assertUv(stickerQuadCenter(moved), [0.7, 0.15], 'movement follows the picked UV while its centre remains recoverable');
  assert.equal(stickerQuadIsWithinTexture(moved), false, 'valid edge clipping may place destination corners outside the texture');
  assertUv(
    [moved.tr[0] - moved.tl[0], moved.tr[1] - moved.tl[1], moved.bl[0] - moved.tl[0], moved.bl[1] - moved.tl[1]],
    [quad.tr[0] - quad.tl[0], quad.tr[1] - quad.tl[1], quad.bl[0] - quad.tl[0], quad.bl[1] - quad.tl[1]],
    'moving preserves the authored affine shape',
  );

  assert.deepEqual(nearestPeriodicUv([0.98, 0.5], [0.02, 0.5]), [1.02, 0.5], 'wrap seam picks the nearby periodic copy');
  const seamQuad = { tl: [0.92, 0.45], tr: [1.02, 0.45], bl: [0.92, 0.55] };
  const seamMoved = moveStickerQuadToUv(seamQuad, [0.03, 0.5]);
  assertUv(stickerQuadCenter(seamMoved), [1, 0.5], 'seam movement keeps its anchor at the texture edge');
  assert.equal(stickerQuadIsWithinTexture(seamMoved), false, 'seam-safe clipping keeps the compact authored destination');

  const oversized = constrainStickerQuadToTexture({ tl: [-0.5, -0.5], tr: [1.5, -0.5], bl: [-0.5, 1.5] });
  assert.equal(stickerQuadIsWithinTexture(oversized), false, 'large destinations may clip after their edge length is capped');
  assertUv(oversized.tl, [-0.25, -0.25], 'oversized placement retains a centred clipped top-left');
  assertUv(oversized.tr, [1.25, -0.25], 'oversized placement caps its horizontal edge');
  assertUv(oversized.bl, [-0.25, 1.25], 'oversized placement caps its vertical edge');

  const invalid = { tl: [Number.NaN, 0], tr: [0.1, 0], bl: [0, 0.1] };
  assert.equal(moveStickerQuadToUv(invalid, [0.5, 0.5]), invalid, 'bad input is refused without emitting NaN values');
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log('[verify] viewer sticker placement geometry passed');
