import * as THREE from 'three';

import { HANGING_PARTS } from './poseRigs';
import type { ItemRuntime } from './showcaseTypes';
import { dominantBones, posedPositions } from './weaponGeometry';

// Turns a posed weapon silhouette into the board cells it occupies, for placement checks.
const SILHOUETTE_PX_PER_CELL = 8;

export const cellKey = (i: number, j: number) => (i + 2048) * 4096 + (j + 2048);

/** Rasterise the posed, rotated weapon onto the board; its silhouette shows while placing and its cells are the fit footprint. */
export function refreshFootprint(runtime: ItemRuntime, cell: number, nextVersion: () => number): void {
  const savedPosition = runtime.root.position.clone();
  runtime.root.position.set(0, 0, 0);
  runtime.root.updateMatrixWorld(true);
  const key = `${JSON.stringify(runtime.item.pose)}|${runtime.item.flipped}|${runtime.visibility}`;
  let cache = runtime.local;
  if (!cache || cache.key !== key) {
    // Skinning is the expensive part, so it only happens when the pose or
    // side changes; rotations reuse these positions.
    const toOrient = runtime.orient.matrixWorld.clone().invert();
    const positions = runtime.meshes.map((mesh, meshIndex) => posedPositions(mesh, toOrient.clone().multiply(mesh.matrixWorld), runtime.subsets[meshIndex]?.used ?? null));
    const indices = runtime.meshes.map((mesh, meshIndex) => runtime.subsets[meshIndex]?.index ?? mesh.geometry.getIndex()?.array ?? null);
    const hangingBones = runtime.item.part ? undefined : HANGING_PARTS[runtime.item.weaponKey]?.bones;
    const hanging = runtime.meshes.map((mesh, meshIndex) => {
      if (!hangingBones || !(mesh instanceof THREE.SkinnedMesh)) return null;
      const owner = dominantBones(mesh);
      const used = runtime.subsets[meshIndex]?.used ?? null;
      return Uint8Array.from({ length: positions[meshIndex].length / 3 }, (_, slot) => Number(hangingBones.includes(owner[used ? used[slot] : slot])));
    });
    cache = { key, positions, projected: positions.map((local) => new Float32Array((local.length / 3) * 2)), indices, hanging };
    runtime.local = cache;
  }
  const e = runtime.orient.matrixWorld.elements;
  runtime.root.position.copy(savedPosition);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const body = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const projected = cache.positions.map((local, meshIndex) => {
    const out = cache.projected[meshIndex];
    const hanging = cache.hanging[meshIndex];
    for (let index = 0, o = 0; index < local.length; index += 3, o += 2) {
      const lx = local[index];
      const ly = local[index + 1];
      const lz = local[index + 2];
      const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
      const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
      const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
      out[o] = x;
      out[o + 1] = y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
      if (!hanging?.[o / 2]) {
        body.minX = Math.min(body.minX, x);
        body.maxX = Math.max(body.maxX, x);
        body.minY = Math.min(body.minY, y);
        body.maxY = Math.max(body.maxY, y);
      }
    }
    return out;
  });
  if (!Number.isFinite(minX)) return;
  const originX = Math.floor(minX / cell) * cell;
  const originY = Math.floor(minY / cell) * cell;
  const cellsW = Math.max(1, Math.ceil((maxX - originX) / cell));
  const cellsH = Math.max(1, Math.ceil((maxY - originY) / cell));
  const width = cellsW * SILHOUETTE_PX_PER_CELL;
  const height = cellsH * SILHOUETTE_PX_PER_CELL;
  const previousMask = runtime.footprint?.mask;
  const mask = previousMask && previousMask.length === width * height ? previousMask.fill(0) : new Uint8Array(width * height);
  const scale = SILHOUETTE_PX_PER_CELL / cell;
  const top = originY + cellsH * cell;
  // 1 marks the weapon itself, 2 a piece that may hang past the edge; the weapon wins where they meet.
  let value = 1;
  const mark = (px: number, py: number) => {
    const x = Math.floor(px);
    const y = Math.floor(py);
    if (x >= 0 && y >= 0 && x < width && y < height && mask[y * width + x] !== 1) mask[y * width + x] = value;
  };
  // Edges are walked pixel by pixel, so needle-thin parts like a hose or a
  // barrel still register even when no pixel centre falls inside them.
  const markEdge = (x0: number, y0: number, x1: number, y1: number) => {
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
    for (let step = 0; step <= steps; step += 1) {
      const t = steps ? step / steps : 0;
      mark(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
    }
  };
  projected.forEach((points, meshIndex) => {
    const indices = cache.indices[meshIndex] ?? null;
    const hanging = cache.hanging[meshIndex];
    const count = indices ? indices.length : points.length / 2;
    for (let corner = 0; corner + 2 < count; corner += 3) {
      const a = (indices ? indices[corner] : corner) * 2;
      const b = (indices ? indices[corner + 1] : corner + 1) * 2;
      const c = (indices ? indices[corner + 2] : corner + 2) * 2;
      value = hanging && hanging[a / 2] + hanging[b / 2] + hanging[c / 2] >= 2 ? 2 : 1;
      const ax = (points[a] - originX) * scale, ay = (top - points[a + 1]) * scale;
      const bx = (points[b] - originX) * scale, by = (top - points[b + 1]) * scale;
      const cx = (points[c] - originX) * scale, cy = (top - points[c + 1]) * scale;
      markEdge(ax, ay, bx, by);
      markEdge(bx, by, cx, cy);
      markEdge(cx, cy, ax, ay);
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
      const x1 = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)));
      const y1 = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
      const sign = area > 0 ? 1 : -1;
      for (let py = y0; py <= y1; py += 1) {
        const sy = py + 0.5;
        for (let px = x0; px <= x1; px += 1) {
          const sx = px + 0.5;
          if (sign * ((bx - ax) * (sy - ay) - (by - ay) * (sx - ax)) < 0) continue;
          if (sign * ((cx - bx) * (sy - by) - (cy - by) * (sx - bx)) < 0) continue;
          if (sign * ((ax - cx) * (sy - cy) - (ay - cy) * (sx - cx)) < 0) continue;
          mark(px, py);
        }
      }
    }
  });
  const cells = new Set<number>();
  const solid = new Set<number>();
  const baseI = Math.round(originX / cell);
  const baseJ = Math.round(originY / cell);
  for (let by = 0; by < cellsH; by += 1) {
    for (let bx = 0; bx < cellsW; bx += 1) {
      let covered = 0;
      let weapon = 0;
      for (let py = 0; py < SILHOUETTE_PX_PER_CELL; py += 1) {
        const row = (by * SILHOUETTE_PX_PER_CELL + py) * width + bx * SILHOUETTE_PX_PER_CELL;
        for (let px = 0; px < SILHOUETTE_PX_PER_CELL; px += 1) {
          const pixel = mask[row + px];
          if (pixel) covered += 1;
          if (pixel === 1) weapon += 1;
        }
      }
      // A cell counts once the weapon covers a couple of its pixels, so a
      // corner that barely touches it does not claim the whole cell.
      const key = cellKey(baseI + bx, baseJ + (cellsH - 1 - by));
      if (covered >= 2) cells.add(key);
      if (weapon >= 2) solid.add(key);
    }
  }
  runtime.footprint = {
    cells, solid, mask, maskWidth: width, maskHeight: height, originX, originY, width: cellsW * cell, height: cellsH * cell, minZ, maxZ,
    body: Number.isFinite(body.minX) ? body : { minX, minY, maxX, maxY },
    version: nextVersion(),
  };
}
