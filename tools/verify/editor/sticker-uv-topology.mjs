// Physical periodic sticker UV-chart topology contract check.
//
//   node tools/verify/editor/sticker-uv-topology.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'sticker-uv-topology-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  const result = spawnSync(process.execPath, [viteBin, 'build', '--ssr', 'src/editor/stickerUvTopology.ts', '--outDir', BUILD_DIR, '--logLevel', 'warn'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) throw new Error('Vite could not bundle sticker UV topology.');
  return pathToFileURL(path.join(BUILD_DIR, 'stickerUvTopology.js')).href;
}

function attribute(points) {
  return {
    count: points.length,
    getX: (index) => points[index][0],
    getY: (index) => points[index][1],
    getZ: (index) => points[index][2],
  };
}

function geometry(positions, uvs, indexes = null) {
  return {
    getAttribute: (name) => name === 'position' ? attribute(positions) : name === 'uv' ? attribute(uvs) : undefined,
    getIndex: () => indexes ? ({ count: indexes.length, getX: (index) => indexes[index] }) : null,
  };
}

try {
  const { buildStickerUvTopology } = await import(bundleModule());

  const repeated = geometry(
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [3, 0, 0], [4, 0, 0], [4, 1, 0], [3, 1, 0]],
    [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0], [1, 0], [1, 1], [0, 1]],
    [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7],
  );
  const reused = buildStickerUvTopology([repeated]);
  assert.equal(reused.charts.length, 2, 'disconnected geometry with identical UVs stays as two physical charts');
  assert.equal(reused.triangles[0].chartId, reused.triangles[1].chartId, 'adjacent indexed square triangles join');
  assert.notEqual(reused.triangles[0].chartId, reused.triangles[2].chartId, 'UV reuse cannot merge disconnected positions');
  assert.equal(reused.findCandidates([[0.25, 0.25]]).length, 1);
  assert.equal(reused.findCandidates([[0.25, 0.25]])[0].length, 4, 'a UV point reports each containing triangle from both physical instances');
  const firstChart = reused.triangles[0].chartId;
  assert.equal(reused.findCandidates([[0.25, 0.25]], firstChart)[0].length, 2, 'chart filter selects one coherent instance');

  const periodicSeam = geometry(
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]],
    [[0, 0], [1, 0], [0, 1], [1, 1]],
    [0, 1, 2, 1, 3, 2],
  );
  const seam = buildStickerUvTopology([periodicSeam]);
  assert.equal(seam.charts.length, 1, 'UV endpoints differing by one wrap join the same physical chart');
  assert.equal(seam.findCandidates([[1.02, 0.2]])[0].length, 1, 'queries continue across a normal texture seam');

  const mirroredSeam = geometry(
    [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
    [[0.1, 0.1], [0.8, 0.2], [0.2, 0.8], [0.2, 0.8], [0.8, 0.8], [0.8, 0.2]],
  );
  const mirrored = buildStickerUvTopology([mirroredSeam]);
  assert.equal(mirrored.charts.length, 2, 'a shared physical edge with nonmatching/mirrored UV endpoint assignments stays split');

  const nonIndexed = geometry(
    [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]],
    [[0, 0], [1, 0], [1, 1], [0, 0], [1, 1], [0, 1]],
  );
  const nonIndexedTopology = buildStickerUvTopology([nonIndexed]);
  assert.equal(nonIndexedTopology.charts.length, 1, 'non-indexed duplicate vertices still join through a matched physical+UV edge');
  assert.equal(nonIndexedTopology.triangles.length, 2);
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log('[verify] sticker UV topology passed');
