// Real model UV wireframe contract check.

import assert from 'node:assert/strict';
import { BufferAttribute, BufferGeometry } from 'three';
import { test } from 'vitest';
import { createUvWireframe } from '../../../src/editor/uvWireframe';

function indexedGeometry(points: readonly (readonly [number, number])[], indexes: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(points.flat()), 2));
  geometry.setIndex([...indexes]);
  return geometry;
}

test('real model UV wireframe', () => {
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

  const nonIndexed = new BufferGeometry();
  nonIndexed.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 9, 9]), 2));
  const nonIndexedWireframe = createUvWireframe([nonIndexed]);
  assert.equal(nonIndexedWireframe?.triangleCount, 1, 'non-indexed geometry ignores a trailing non-triangle vertex');
  assert.equal(nonIndexedWireframe?.edgeCount, 3);

  assert.equal(createUvWireframe([new BufferGeometry()]), null);
  const invalidIndex = indexedGeometry([[0, 0], [1, 0], [0, 1]], [0, 1, 99]);
  assert.equal(createUvWireframe([invalidIndex]), null, 'out-of-range index is safely skipped');
});
