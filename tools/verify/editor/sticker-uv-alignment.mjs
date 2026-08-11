// End-to-end UV-orientation contract for the 2D sticker editor.
//
//   node tools/verify/editor/sticker-uv-alignment.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'sticker-uv-alignment-verify');

function bundle(entry, output) {
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', entry, '--outDir', output, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error(`Vite could not bundle ${entry}.`);
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

try {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  bundle('src/editor/stickerGeometry.ts', path.join(BUILD_DIR, 'geometry'));
  bundle('src/editor/stickerSurface.ts', path.join(BUILD_DIR, 'rows'));
  bundle('src/editor/stickerViewport.ts', path.join(BUILD_DIR, 'viewport'));
  const geometry = await import(pathToFileURL(path.join(BUILD_DIR, 'geometry', 'stickerGeometry.js')).href);
  const rows = await import(pathToFileURL(path.join(BUILD_DIR, 'rows', 'stickerSurface.js')).href);
  const viewport = await import(pathToFileURL(path.join(BUILD_DIR, 'viewport', 'stickerViewport.js')).href);

  // This deliberately asymmetric placement catches a vertical flip. The 2D
  // editor maps its CSS left/top percentages straight to these UV coordinates;
  // the Viewer and compositor consume the same authored TL/TR/BL fields.
  const placement = { x: 0.23, y: 0.71, width: 0.18, height: 0.12, rotation: 0 };
  const quad = geometry.stickerPlacementToQuad(placement);
  assert.ok(quad, 'valid placement serializes to an authored destination');
  close(quad.tl[0], 0.14, 'top-left uses CSS/UV x directly');
  close(quad.tl[1], 0.65, 'top-left uses CSS/UV y directly');
  close(quad.tr[0], 0.32, 'top-right preserves x axis');
  close(quad.tr[1], 0.65, 'top-right remains on the visual top row');
  close(quad.bl[0], 0.14, 'bottom-left preserves x axis');
  close(quad.bl[1], 0.77, 'bottom-left is visually below top-left');

  // A screen pointer at 92px,142px on a 400x200 fitted 2D surface means
  // exactly the same (.23,.71) UV point used by the authored centre above.
  // This catches accidentally passing CSS-normalized values to a viewport API
  // that expects pixels (or introducing another vertical flip while zooming).
  const pointerUv = viewport.stickerViewportPointToUv(
    { x: 92, y: 142 },
    viewport.DEFAULT_STICKER_VIEWPORT,
    { width: 400, height: 200 },
  );
  close(pointerUv.x, placement.x, '2D pointer x matches authored/3D UV x');
  close(pointerUv.y, placement.y, '2D pointer y matches authored/3D UV y');

  // Model a 2x2 compositor target. readback row 0 is UV v=0 and has a
  // unique red marker. In an editor canvas that marker must remain in its top
  // row, never appear at v=1; this is the exact failure that made 2D and 3D
  // sticker placement disagree.
  const readback = new Uint8ClampedArray([
    255, 0, 0, 17, 0, 255, 0, 18,
    0, 0, 255, 19, 255, 255, 0, 20,
  ]);
  const preview = rows.compositorReadbackToEditorPixels(readback, 2, 2);
  assert.deepEqual([...preview], [
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 0, 255,
  ], 'UV v=0 readback row remains the top editor row and the preview is opaque');
  assert.deepEqual(
    [...rows.compositorReadbackToEditorPixels(readback, 2, 2, false)],
    [...readback],
    'isolated group artwork keeps its deliberate transparent background',
  );
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log('[verify] 2D/editor and 3D/compositor sticker UV alignment passed');
