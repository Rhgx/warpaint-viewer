// CPU group-map sampling parity check.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  groupBucketsInImage,
  groupByteToCompositorBucket,
  groupTexelAtUv,
  rawGroupIdForBucket,
  sampleGroupAtUv,
  sampleGroupRedAtUv,
} from '../../../src/editor/groupSampling';

test('CPU group-map sampling parity', () => {
  // Deliberately asymmetric rows prove V is source-image-down, not flipped.
  const image = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      16, 0, 0, 255, 31, 0, 0, 255,
      32, 0, 0, 255, 255, 0, 0, 255,
    ]),
  };

  assert.ok(sampleGroupAtUv(image, 0, 0)?.red === 16, 'top-left UV samples first source row');
  assert.ok(sampleGroupAtUv(image, 0, 0.75)?.red === 32, 'bottom-left UV samples second source row (V-down)');
  assert.deepEqual(groupTexelAtUv(image, 1, 1), { x: 1, y: 1 }, 'right/bottom edges clamp to the last texel');
  assert.ok(groupTexelAtUv(image, -0.001, 0) === null && groupTexelAtUv(image, 0, Number.NaN) === null, 'outside and non-finite UVs reject');
  assert.ok(sampleGroupRedAtUv(image, 0.75, 0) === 31, 'red-channel sampling ignores green/blue/alpha');
  assert.ok(groupByteToCompositorBucket(23) === 1 && groupByteToCompositorBucket(24) === 2, 'bucketing rounds at the fxc 1/16 boundary');
  assert.ok(sampleGroupAtUv(image, 1, 1)?.bucket === 16, 'bucket 16 supports raw byte 255');
  assert.ok(rawGroupIdForBucket(1) === 16
      && rawGroupIdForBucket(15) === 240
      && rawGroupIdForBucket(16) === 255
      && rawGroupIdForBucket(0) === null, 'visible buckets convert back to authored selector IDs');
  assert.deepEqual(groupBucketsInImage(image), [1, 2, 16], 'present selector buckets are discovered without the background');
});
