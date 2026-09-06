// Physical periodic sticker UV-chart topology contract check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { buildStickerUvTopology } from '../../../src/editor/stickerUvTopology';
import type { StickerUv, StickerUvTopologyAttribute, StickerUvTopologyGeometry, StickerUvTopologyIndex, StickerVec3 } from '../../../src/editor/stickerUvTopology';

function positionAttribute(points: readonly StickerVec3[]): StickerUvTopologyAttribute {
  return {
    count: points.length,
    getX: (index) => points[index][0],
    getY: (index) => points[index][1],
    getZ: (index) => points[index][2],
  };
}

function uvAttribute(points: readonly StickerUv[]): StickerUvTopologyAttribute {
  return {
    count: points.length,
    getX: (index) => points[index][0],
    getY: (index) => points[index][1],
  };
}

function geometry(
  positions: readonly StickerVec3[],
  uvs: readonly StickerUv[],
  indexes: readonly number[] | null = null,
): StickerUvTopologyGeometry {
  const index: StickerUvTopologyIndex | null = indexes
    ? { count: indexes.length, getX: (position) => indexes[position] ?? -1 }
    : null;
  return {
    getAttribute: (name) => name === 'position' ? positionAttribute(positions) : uvAttribute(uvs),
    getIndex: () => index,
  };
}

test('physical periodic sticker UV-chart topology', () => {

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
  assert.deepEqual(
    seam.findCandidates([[1.02, 0.2]])[0][0].periodicOffset,
    [-1, 0],
    'candidate records which wrapped tile supplied the physical UV copy',
  );

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

  // Compare indexed chart queries with the exhaustive path at bin boundaries,
  // wrapped tiles and just outside edges. Visibility/triangle identity must
  // remain identical; the index is only a search acceleration.
  const targets: StickerUv[] = [];
  for (let u = -2; u <= 18; u += 1) {
    for (let v = -2; v <= 18; v += 1) {
      targets.push([u / 16, v / 16], [u / 16 - 1e-8, v / 16 + 1e-8]);
    }
  }
  for (const topology of [reused, seam, mirrored, nonIndexedTopology]) {
    const exhaustive = topology.findCandidates(targets);
    for (const chart of topology.charts) {
      assert.deepEqual(topology.findCandidates(targets, chart.id), exhaustive.map((candidates) => (
        candidates.filter((candidate) => candidate.chartId === chart.id)
      )));
    }
  }
});
