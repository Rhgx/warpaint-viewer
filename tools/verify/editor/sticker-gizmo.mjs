// On-model sticker gizmo UV transform contract check.
//
//   node tools/verify/editor/sticker-gizmo.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'sticker-gizmo-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', 'src/editor/stickerGizmo.ts', '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('Vite could not bundle sticker gizmo geometry.');
  return pathToFileURL(path.join(BUILD_DIR, 'stickerGizmo.js')).href;
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}: expected ${expected}, got ${actual}`);
}

function closeUv(actual, expected, message) {
  close(actual[0], expected[0], `${message} u`);
  close(actual[1], expected[1], `${message} v`);
}

try {
  const gizmo = await import(bundleModule());
  const quad = { tl: [0.4, 0.45], tr: [0.6, 0.45], bl: [0.4, 0.55] };

  assert.equal(gizmo.stickerGizmoAnchorContainsCentre([true, false, false]), true,
    'an occluded anchor remains compatible while its chart still contains the authored centre');
  assert.equal(gizmo.stickerGizmoAnchorContainsCentre([false, true, true]), false,
    'a stale anchor is released when only old boundary samples remain on its chart');
  assert.deepEqual(gizmo.stickerGizmoFallbackHandles({ x: 100, y: 80 }), {
    x: { x: 130, y: 80 },
    y: { x: 100, y: 110 },
    uniform: { x: 122, y: 102 },
    turn: { x: 100, y: 50 },
  }, 'occluded-centre recovery exposes compact X, Y, uniform scale, and turn grips');

  const layout = gizmo.createStickerGizmoScreenLayout(
    { x: 20, y: 20 }, { x: 100, y: 20 }, { x: 100, y: 60 }, { x: 20, y: 60 },
  );
  assert.deepEqual(layout.handles.move, { x: 60, y: 40 }, 'move handle stays at the affine centre');
  assert.ok(layout.handles.rotate.y < layout.handles['scale-top-left'].y, 'rotation control sits outside the top edge');
  assert.equal(gizmo.stickerGizmoIntentForHandle('scale-top-left'), 'scale', 'corner handle advertises scale intent');
  assert.deepEqual(layout.handles['scale-right'], { x: 100, y: 40 }, 'right edge handle stays centred on its affine axis');
  assert.deepEqual(layout.handles['scale-bottom'], { x: 60, y: 60 }, 'bottom edge handle stays centred on its affine axis');
  assert.equal(gizmo.stickerGizmoIntentForHandle('rotate'), 'rotate', 'rotation handle advertises rotate intent');
  assert.equal(
    gizmo.pointIsInsideStickerGizmoScreenOutline({ x: 60, y: 40 }, layout.corners),
    true,
    'the projected decal body is an intentional move target',
  );
  assert.equal(
    gizmo.pointIsInsideStickerGizmoScreenOutline({ x: 140, y: 40 }, layout.corners),
    false,
    'empty canvas stays outside the gizmo body',
  );

  const partialCentre = gizmo.deriveStickerGizmoScreenCentre(null, [0.5, 0.5], [
    { uv: [0.4, 0.45], point: { x: 20, y: 20 } },
    { uv: [0.5, 0.45], point: { x: 60, y: 20 } },
    { uv: [0.6, 0.45], point: null },
  ]);
  assert.deepEqual(partialCentre, { x: 60, y: 20 }, 'a hidden UV centre falls back to the closest real boundary sample');
  const partialHull = gizmo.stickerGizmoScreenHull([{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 20, y: 30 }, null]);
  assert.equal(partialHull.length, 3, 'three visible boundary samples form a truthful partial hull');
  assert.deepEqual(gizmo.stickerGizmoScreenHull([null, undefined]), [], 'fully hidden boundary samples produce no outline');
  assert.equal(gizmo.deriveStickerGizmoScreenCentre(null, [0.5, 0.5], [{ uv: [0.4, 0.4], point: null }]), null, 'fully hidden samples produce no invented centre');
  assert.equal(gizmo.hasUsableStickerGizmoScaleDirection({ x: 60, y: 20 }, { x: 60, y: 20 }), false, 'a fallback centre does not expose a directionless scale grip');
  assert.equal(gizmo.hasUsableStickerGizmoScaleDirection({ x: 60, y: 20 }, { x: 68, y: 20 }), true, 'a separated visible boundary sample remains a usable scale grip');
  assert.deepEqual(gizmo.stickerGizmoTurnHandle({ x: 50, y: 50 }, null), { x: 50, y: 20 }, 'turn has a compact screen-space fallback above an attached centre');

  const fromCorner = gizmo.scaleStickerQuadFromGizmo(quad, 'scale-bottom-right', [0.8, 0.65]);
  closeUv(fromCorner.tl, quad.tl, 'corner scale keeps opposing corner fixed');
  closeUv(fromCorner.tr, [0.8, 0.45], 'corner scale preserves aspect ratio horizontally');
  closeUv(fromCorner.bl, [0.4, 0.65], 'corner scale preserves aspect ratio vertically');

  const rotated = gizmo.rotateStickerQuadByDegrees(quad, 90);
  closeUv(rotated.tl, [0.55, 0.4], 'rotation moves first authored corner around affine centre');
  closeUv(rotated.tr, [0.55, 0.6], 'rotation returns an authored UV quad rather than world coordinates');

  const doubled = gizmo.scaleStickerQuadAroundCentre(quad, 2);
  closeUv(doubled.tl, [0.3, 0.4], 'screen-distance scale grows uniformly from the centre');
  closeUv(doubled.tr, [0.7, 0.4], 'uniform scale preserves the horizontal basis');
  closeUv(doubled.bl, [0.3, 0.6], 'uniform scale preserves the vertical basis');

  const xOnly = gizmo.scaleStickerQuadAxisAroundCentre(quad, 'x', 2);
  closeUv(xOnly.tl, [0.3, 0.45], 'X-only scale expands only the local horizontal basis');
  closeUv(xOnly.tr, [0.7, 0.45], 'X-only scale keeps the local vertical position');
  closeUv(xOnly.bl, [0.3, 0.55], 'X-only scale preserves local height');

  const yOnly = gizmo.scaleStickerQuadAxisAroundCentre(quad, 'y', 0.5);
  closeUv(yOnly.tl, [0.4, 0.475], 'Y-only scale contracts only the local vertical basis');
  closeUv(yOnly.tr, [0.6, 0.475], 'Y-only scale preserves local width');
  closeUv(yOnly.bl, [0.4, 0.525], 'Y-only scale keeps the centre fixed');

  const screenRatio = gizmo.stickerGizmoScreenAxisRatio(
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 98, y: 2 }, { x: 147, y: -20 },
  );
  close(screenRatio, 1.5, 'screen-space ratio projects onto the original handle direction');
  const clampedRatio = gizmo.stickerGizmoScreenAxisRatio(
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: -100, y: 0 },
  );
  close(clampedRatio, 0.05, 'screen-space ratio clamps safely when dragged through centre');
  const clampedAxis = gizmo.scaleStickerQuadAxisAroundCentre(quad, 'x', clampedRatio);
  assert.ok([...clampedAxis.tl, ...clampedAxis.tr, ...clampedAxis.bl].every(Number.isFinite), 'clamped edge scale stays finite');

  const grabbed = gizmo.moveStickerQuadByUvDelta(quad, [0.46, 0.48], [0.71, 0.28]);
  closeUv(grabbed.tl, [0.65, 0.25], 'move uses the UV delta from the grabbed point, not the quad centre');
  closeUv(grabbed.tr, [0.85, 0.25], 'move keeps the full authored basis intact');

  const seam = { tl: [0.92, 0.45], tr: [1.02, 0.45], bl: [0.92, 0.55] };
  const seamMoved = gizmo.moveStickerQuadByUvDelta(seam, [0.98, 0.5], [0.03, 0.5]);
  closeUv(seamMoved.tl, [0.97, 0.45], 'move keeps a short seam drag compact');
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

console.log('[verify] sticker gizmo geometry passed');
