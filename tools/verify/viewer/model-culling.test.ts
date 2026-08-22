import assert from 'node:assert/strict';
import * as THREE from 'three';
import { test } from 'vitest';
import { CullableGeometry } from '../../../src/viewer/modelCulling';

function indexedGeometry(positions: readonly number[], indices: readonly number[]): THREE.BufferGeometry {
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    .setIndex([...indices]);
}

function sampleGeometry(seamed = false): THREE.BufferGeometry {
  return seamed
    ? indexedGeometry([
      0, 0, 0, 1, 0, 0, 0, 1, 0,
      0, 1.0000001, 0, 1, 1, 0, 1.0000001, 0, 0,
      10, 10, 0, 11, 10, 0, 10, 11, 0,
    ], [0, 1, 2, 3, 4, 5, 6, 7, 8])
    : indexedGeometry([
      0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0,
      10, 10, 0, 11, 10, 0, 10, 11, 0,
    ], [0, 1, 2, 2, 1, 3, 4, 5, 6]);
}

function indexValues(geometry: THREE.BufferGeometry): number[] {
  const index = geometry.getIndex();
  return index ? Array.from({ length: index.count }, (_, offset) => index.getX(offset)) : [];
}

test('assigns stable component IDs and caches component geometry', () => {
  const source = sampleGeometry();
  const cullable = new CullableGeometry(source);

  assert.equal(cullable.componentCount, 2);
  assert.deepEqual([0, 1, 2].map((face) => cullable.componentForVisibleFace(face)), [0, 0, 1]);
  assert.equal(cullable.componentForVisibleFace(-1), null);
  assert.equal(cullable.componentForVisibleFace(3), null);

  const first = cullable.getComponentGeometry(0);
  const second = cullable.getComponentGeometry(1);
  assert.ok(first);
  assert.ok(second);
  assert.equal(first, cullable.getComponentGeometry(0));
  assert.deepEqual(indexValues(first), [0, 1, 2, 2, 1, 3]);
  assert.deepEqual(indexValues(second), [4, 5, 6]);
  assert.equal(first.getAttribute('position'), cullable.geometry.getAttribute('position'));
  assert.equal(cullable.getComponentGeometry(2), null);

  cullable.dispose();
  assert.equal(cullable.getComponentGeometry(0), null);
  source.dispose();
});

test('hides and restores stable components without mutating the source', () => {
  const source = sampleGeometry();
  const original = indexValues(source);
  const cullable = new CullableGeometry(source);

  assert.equal(cullable.hideComponent(0), true);
  assert.deepEqual(indexValues(cullable.geometry), [4, 5, 6]);
  assert.equal(cullable.componentForVisibleFace(0), 1);
  assert.equal(cullable.hideComponent(0), false);
  assert.equal(cullable.hideComponent(1), true);
  assert.equal(cullable.hiddenCount, 2);
  assert.deepEqual(indexValues(cullable.geometry), []);

  assert.equal(cullable.restoreComponent(0), true);
  assert.deepEqual(indexValues(cullable.geometry), [0, 1, 2, 2, 1, 3]);
  assert.equal(cullable.isComponentHidden(1), true);
  assert.equal(cullable.restore(), true);
  assert.deepEqual(indexValues(cullable.geometry), original);
  assert.equal(cullable.restore(), false);
  assert.deepEqual(indexValues(source), original);

  cullable.dispose();
  source.dispose();
});

test('welds duplicated seams while keeping separated surfaces distinct', () => {
  const source = sampleGeometry(true);
  const cullable = new CullableGeometry(source);

  assert.equal(cullable.componentCount, 2);
  const first = cullable.componentForVisibleFace(0);
  if (first === null) assert.fail('expected the first face to resolve to a component');
  assert.equal(cullable.hideComponent(first), true);
  assert.deepEqual(indexValues(cullable.geometry), [6, 7, 8]);
  assert.equal(cullable.componentForVisibleFace(0), 1);

  cullable.dispose();
  source.dispose();
});

test('unsupported geometry is cloned but cannot be culled', () => {
  const source = new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  const cullable = new CullableGeometry(source);

  assert.notEqual(cullable.geometry, source);
  assert.equal(cullable.hideComponent(0), false);
  assert.equal(cullable.restore(), false);
  cullable.dispose();
  source.dispose();
});
