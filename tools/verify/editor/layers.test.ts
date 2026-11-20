// Group-map sampling, curated group names, and texture-aware layer colours.

import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  formatGroupNameForDisplay,
  groupTextureLoadRef,
  loadGroupNameReference,
  lookupGroupName,
  lookupGroupNameForBucket,
  normalizeGroupTextureReference,
} from '../../../src/editor/layers/groupNames';
import {
  groupBucketsInImage,
  groupByteToCompositorBucket,
  groupTexelAtUv,
  rawGroupIdForBucket,
  sampleGroupAtUv,
  sampleGroupRedAtUv,
  type RgbaImageDataLike,
} from '../../../src/editor/layers/groupSampling';
import { EDITOR_LAYER_MAP_COLORS, chooseEditorLayerColors } from '../../../src/editor/layers/layerMap';

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

const amputator = 'models/workshop/weapons/c_models/c_amputator/p_amputator_groups';

test('group names resolve from any spelling of the texture path, by raw id or by bucket', async () => {
  assert.equal(lookupGroupName(amputator, 16), null, 'nothing resolves before the reference loads');
  await loadGroupNameReference();
  assert.equal(normalizeGroupTextureReference(`materials\\${amputator}.webp`), amputator);
  assert.equal(lookupGroupName(`materials\\${amputator}.vtf`, 255), 'Blade');
  assert.equal(lookupGroupNameForBucket(`textures/${amputator}.webp`, 1), 'Knuckle Guard');
  assert.equal(lookupGroupNameForBucket(amputator, 16), 'Blade');
  assert.equal(lookupGroupName(amputator, 0), null);
  assert.equal(lookupGroupName('models/not-in-reference/p_groups', 16), null);
});

test('long group names are shortened for display', () => {
  const full = 'Pump Knuckle Guards + Wire Grommets + Hose Knobs near Tank + Pump Hose Gland + Hose Structure near Pump (sans Bolt Neck)';
  assert.equal(formatGroupNameForDisplay(full), 'Pump Knuckle Guards + 4 more');
  assert.equal(formatGroupNameForDisplay('Pump Wires (though the wear texture always zeroes this out)'), 'Pump Wires');
  assert.equal(formatGroupNameForDisplay('Barrel Between Rearmost and Foremost Barrel Bracket'), 'Barrel Between Rearmost and Foremost\u2026');
});

test('a group texture picked from the layout list loads by its public texture path', () => {
  assert.equal(
    groupTextureLoadRef('models/weapons/c_models/c_rocketlauncher/p_rocketlauncher_groups_02'),
    'textures/models/weapons/c_models/c_rocketlauncher/p_rocketlauncher_groups_02.webp',
  );
});

function thumbnail(red: number, green: number, blue: number, alpha = 255): RgbaImageDataLike {
  const data = new Uint8ClampedArray(16 * 16 * 4);
  for (let pixel = 0; pixel < 16 * 16; pixel += 1) {
    data.set([red, green, blue, alpha], pixel * 4);
  }
  return { width: 16, height: 16, data };
}

test('texture-aware editor layer colors', () => {
  const vibrant = thumbnail(226, 38, 96);
  const transparent = thumbnail(255, 255, 255, 0);

  assert.deepEqual(
    chooseEditorLayerColors([{ thumbnail: transparent, fallbackIndex: 4 }]),
    [EDITOR_LAYER_MAP_COLORS[4]],
    'fully transparent artwork retains the exact indexed fallback',
  );
  assert.deepEqual(
    chooseEditorLayerColors([{ thumbnail: null, fallbackIndex: 5 }]),
    [EDITOR_LAYER_MAP_COLORS[5]],
    'missing artwork retains the exact indexed fallback',
  );

  const sameTexture = [0, 1, 2, 3, 4, 5].map((fallbackIndex) => ({ thumbnail: vibrant, fallbackIndex }));
  const first = chooseEditorLayerColors(sameTexture);
  const second = chooseEditorLayerColors(sameTexture);
  assert.deepEqual(first, second, 'identical input always chooses the same colour order');
  assert.equal(new Set(first.map((color) => color.join(','))).size, first.length, 'same-texture layers stay distinct');
  const pairDistances = first.flatMap((color, index) => first.slice(index + 1).map((other) => (
    Math.hypot(color[0] - other[0], color[1] - other[1], color[2] - other[2])
  )));
  assert.ok(Math.min(...pairDistances) > 0.2, 'generated layer colours remain clearly separated');
});
