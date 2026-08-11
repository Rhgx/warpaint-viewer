// Sticker camera-ownership contract check.
//
//   node tools/verify/editor/sticker-camera-controls.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'sticker-camera-controls-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', 'src/viewer/inspectControls.ts', '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('Vite could not bundle the inspect controls.');
  return pathToFileURL(path.join(BUILD_DIR, 'inspectControls.js')).href;
}

try {
  const { inspectDragForPointer, inspectDoubleClickResets, isRapidInspectClickPair } = await import(bundleModule());
  assert.equal(inspectDragForPointer(0, 'rotate'), 'rotate', 'normal inspect left-drag rotates');
  assert.equal(inspectDragForPointer(1, 'rotate'), 'pan', 'normal inspect middle-drag pans');
  assert.equal(inspectDragForPointer(2, 'rotate'), 'pan', 'normal inspect right-drag pans');
  assert.equal(inspectDragForPointer(0, 'disabled'), 'none', 'sticker-mode empty left-drag does not rotate');
  assert.equal(inspectDragForPointer(1, 'disabled'), 'rotate', 'sticker-mode middle-drag rotates');
  assert.equal(inspectDragForPointer(2, 'disabled'), 'pan', 'sticker-mode right-drag pans');
  assert.equal(inspectDoubleClickResets(0, 'rotate'), true, 'normal left double-click resets');
  assert.equal(inspectDoubleClickResets(0, 'disabled'), false, 'sticker-mode left double-click never resets');
  assert.equal(isRapidInspectClickPair(
    { clientX: 50, clientY: 80, time: 1_000 },
    { clientX: 54, clientY: 83, time: 1_250 },
  ), true, 'two completed middle clicks inside the gesture window reset sticker-mode inspect');
  assert.equal(isRapidInspectClickPair(
    { clientX: 50, clientY: 80, time: 1_000 },
    { clientX: 65, clientY: 83, time: 1_250 },
  ), false, 'a moved middle click is not mistaken for a reset');
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log('[verify] sticker camera ownership passed');
