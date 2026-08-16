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
let failures = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) console.log(`ok - ${label}`);
  else {
    failures++;
    console.error(`not ok - ${label}${detail ? ` (${detail})` : ''}`);
  }
}

  // Deliberately asymmetric rows prove V is source-image-down, not flipped.
  const image = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      16, 0, 0, 255, 31, 0, 0, 255,
      32, 0, 0, 255, 255, 0, 0, 255,
    ]),
  };

  check('top-left UV samples first source row', sampleGroupAtUv(image, 0, 0)?.red === 16);
  check('bottom-left UV samples second source row (V-down)', sampleGroupAtUv(image, 0, 0.75)?.red === 32);
  check('right/bottom edges clamp to the last texel', JSON.stringify(groupTexelAtUv(image, 1, 1)) === JSON.stringify({ x: 1, y: 1 }));
  check('outside and non-finite UVs reject', groupTexelAtUv(image, -0.001, 0) === null && groupTexelAtUv(image, 0, Number.NaN) === null);
  check('red-channel sampling ignores green/blue/alpha', sampleGroupRedAtUv(image, 0.75, 0) === 31);
  check('bucketing rounds at the fxc 1/16 boundary', groupByteToCompositorBucket(23) === 1 && groupByteToCompositorBucket(24) === 2);
  check('bucket 16 supports raw byte 255', sampleGroupAtUv(image, 1, 1)?.bucket === 16);
  check(
    'visible buckets convert back to authored selector IDs',
    rawGroupIdForBucket(1) === 16
      && rawGroupIdForBucket(15) === 240
      && rawGroupIdForBucket(16) === 255
      && rawGroupIdForBucket(0) === null,
  );
  check(
    'present selector buckets are discovered without the background',
    JSON.stringify(groupBucketsInImage(image)) === JSON.stringify([1, 2, 16]),
  );
  assert.equal(failures, 0);
});
