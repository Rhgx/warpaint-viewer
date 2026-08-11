// Compact 2D sticker editor geometry contract check.
//
//   node tools/verify/editor/sticker-editor-geometry.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'sticker-editor-geometry-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', 'src/editor/stickerGeometry.ts', '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('Vite could not bundle sticker editor geometry.');
  return pathToFileURL(path.join(BUILD_DIR, 'stickerGeometry.js')).href;
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

function closePoint(actual, expected, message) {
  close(actual[0], expected[0], `${message} x`);
  close(actual[1], expected[1], `${message} y`);
}

try {
  const geometry = await import(bundleModule());
  const original = { x: 0.37, y: 0.58, width: 0.28, height: 0.11, rotation: 31 };
  const quad = geometry.stickerPlacementToQuad(original);
  assert.ok(quad, 'valid placement emits an authored quad');
  const parsed = geometry.stickerPlacementFromQuad(quad);
  assert.equal(parsed.editable, true, 'rotated rectangle stays editable');
  assert.ok(parsed.placement, 'supported quad returns a placement');
  for (const field of ['x', 'y', 'width', 'height', 'rotation']) {
    close(parsed.placement[field], original[field], `quad round-trip ${field}`);
  }
  assert.equal(
    geometry.stickerPlacementContainsPoint(original, { x: original.x, y: original.y }),
    true,
    'rotated sticker contains its centre',
  );
  assert.equal(
    geometry.stickerPlacementContainsPoint(original, { x: 0.02, y: 0.02 }),
    false,
    'rotated sticker rejects a distant point',
  );
  const nested = [
    { id: 'large', placement: { x: 0.5, y: 0.5, width: 0.6, height: 0.6, rotation: 0 } },
    { id: 'small', placement: { x: 0.5, y: 0.5, width: 0.1, height: 0.1, rotation: 0 } },
  ].filter(({ placement }) => geometry.stickerPlacementContainsPoint(placement, { x: 0.5, y: 0.5 }))
    .sort((first, second) => first.placement.width * first.placement.height - second.placement.width * second.placement.height);
  assert.equal(nested[0].id, 'small', 'nested selection prefers the smallest containing sticker');

  const skewed = geometry.stickerPlacementFromQuad({ tl: [0, 0], tr: [0.4, 0], bl: [0.1, 0.2] });
  assert.equal(skewed.editable, false, 'skewed quad is not silently flattened');
  assert.match(skewed.reason, /skewed/i, 'skew has a useful refusal reason');

  const mirrored = geometry.stickerPlacementFromQuad({ tl: [0, 0], tr: [0.4, 0], bl: [0, -0.2] });
  assert.equal(mirrored.editable, false, 'mirrored quad is not silently flattened');
  assert.match(mirrored.reason, /mirrored/i, 'mirror has a useful refusal reason');

  const resized = geometry.resizeStickerFromCorner(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 },
    'bottom-right',
    { x: 0.7, y: 0.6 },
  );
  close(resized.x, 0.55, 'corner resize centre x');
  close(resized.y, 0.525, 'corner resize centre y');
  close(resized.width, 0.3, 'corner resize width');
  close(resized.height, 0.15, 'corner resize height');

  const lockedResize = geometry.resizeStickerFromCorner(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 },
    'bottom-right',
    { x: 0.65, y: 0.7 },
    { preserveAspect: true },
  );
  close(lockedResize.width / lockedResize.height, 2, 'locked corner resize keeps artwork ratio');
  close(lockedResize.x - lockedResize.width / 2, 0.4, 'locked resize holds opposite x');
  close(lockedResize.y - lockedResize.height / 2, 0.45, 'locked resize holds opposite y');

  const widthOnly = geometry.resizeStickerFromEdge(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 },
    'right',
    { x: 0.7, y: 0.9 },
  );
  close(widthOnly.x, 0.55, 'right edge resize shifts centre x');
  close(widthOnly.y, 0.5, 'right edge resize keeps centre y');
  close(widthOnly.width, 0.3, 'right edge resize changes width');
  close(widthOnly.height, 0.1, 'right edge resize preserves height');

  const heightOnly = geometry.resizeStickerFromEdge(
    { x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 },
    'top',
    { x: 0.9, y: 0.35 },
  );
  close(heightOnly.x, 0.5, 'top edge resize keeps centre x');
  close(heightOnly.y, 0.45, 'top edge resize shifts centre y');
  close(heightOnly.width, 0.2, 'top edge resize preserves width');
  close(heightOnly.height, 0.2, 'top edge resize changes height');

  const snapped = geometry.snapStickerPlacement(
    { x: 0.513, y: 0.487, width: 0.263, height: 0.236, rotation: 22 },
    0.025,
  );
  close(snapped.x, 0.525, 'grid snap x');
  close(snapped.y, 0.475, 'grid snap y');
  close(snapped.width, 0.275, 'grid snap width');
  close(snapped.height, 0.225, 'grid snap height');
  close(snapped.rotation, 15, 'grid snap turn');

  const moved = geometry.moveStickerPlacement(original, { x: 0.1, y: -0.2 });
  close(moved.x, 0.47, 'move x');
  close(moved.y, 0.38, 'move y');
  closePoint(geometry.stickerPlacementToQuad({ x: 0.5, y: 0.5, width: 0.2, height: 0.1, rotation: 0 }).tl, [0.4, 0.45], 'unrotated top left');
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log('[verify] compact sticker editor geometry passed');
