// Real model UV wireframe contract check.
//
//   node tools/verify/editor/uv-wireframe.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'uv-wireframe-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', 'src/editor/uvWireframe.ts', '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('Vite could not bundle the UV wireframe builder.');
  return pathToFileURL(path.join(BUILD_DIR, 'uvWireframe.js')).href;
}

function attribute(points) {
  return {
    count: points.length,
    getX: (index) => points[index][0],
    getY: (index) => points[index][1],
  };
}

function indexedGeometry(points, indexes) {
  return {
    getAttribute: (name) => name === 'uv' ? attribute(points) : undefined,
    getIndex: () => ({ count: indexes.length, getX: (index) => indexes[index] }),
  };
}

try {
  const { createUvWireframe } = await import(bundleModule());
  const square = indexedGeometry(
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    [0, 1, 2, 0, 2, 3],
  );
  const wireframe = createUvWireframe([square]);
  assert.ok(wireframe, 'indexed mesh with UVs produces a wireframe');
  assert.equal(wireframe.meshCount, 1);
  assert.equal(wireframe.triangleCount, 2);
  assert.equal(wireframe.edgeCount, 5, 'the two triangles share one deduplicated diagonal');
  assert.match(wireframe.svg, /viewBox="0 0 1 1"/);
  assert.ok(wireframe.dataUrl.startsWith('data:image/svg+xml,'));

  const nonIndexed = {
    getAttribute: (name) => name === 'uv' ? attribute([[0, 0], [1, 0], [0, 1], [9, 9]]) : undefined,
    getIndex: () => null,
  };
  const nonIndexedWireframe = createUvWireframe([nonIndexed]);
  assert.equal(nonIndexedWireframe?.triangleCount, 1, 'non-indexed geometry ignores a trailing non-triangle vertex');
  assert.equal(nonIndexedWireframe?.edgeCount, 3);

  assert.equal(createUvWireframe([{ getAttribute: () => undefined, getIndex: () => null }]), null);
  const invalidIndex = indexedGeometry([[0, 0], [1, 0], [0, 1]], [0, 1, 99]);
  assert.equal(createUvWireframe([invalidIndex]), null, 'out-of-range index is safely skipped');
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log('[verify] real model UV wireframe passed');
