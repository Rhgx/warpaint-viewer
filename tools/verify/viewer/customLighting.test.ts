import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as THREE from 'three';
import {
  MAX_CUSTOM_LIGHTS,
  buildCustomLights,
  createDefaultCustomLightingRig,
  framePositionToWorld,
  updateCustomLightRuntime,
  validateCustomLightingRig,
  worldPositionToFrame,
} from '../../../src/viewer/customLighting';

test('custom lighting validation clamps persisted values and caps lights', () => {
  const rig = validateCustomLightingRig({
    ambient: 5,
    exposure: -2,
    lights: Array.from({ length: MAX_CUSTOM_LIGHTS + 2 }, (_, index) => ({
      id: index < 2 ? 'duplicate' : `light-${index}`,
      type: 'spot',
      position: [100, -100, Number.NaN],
      target: [0, 0, 0],
      color: 'not-a-color',
      intensity: 100,
      angleDegrees: 200,
      softness: -1,
      range: -5,
    })),
  });

  assert.equal(rig.lights.length, MAX_CUSTOM_LIGHTS);
  assert.equal(rig.ambient, 1);
  assert.equal(rig.exposure, 0.1);
  assert.equal(rig.cameraRimLight, false);
  assert.equal(new Set(rig.lights.map((light) => light.id)).size, MAX_CUSTOM_LIGHTS);
  const spot = rig.lights[0];
  assert.equal(spot.type, 'spot');
  if (spot.type !== 'spot') throw new Error('expected a spot light');
  assert.deepEqual(spot.position, [10, -10, 0]);
  assert.equal(spot.color, '#ffffff');
  assert.equal(spot.intensity, 20);
  assert.equal(spot.angleDegrees, 90);
  assert.equal(spot.softness, 0);
  assert.equal(spot.range, 0);
});

test('custom lighting coordinates use the largest framed dimension', () => {
  const frame = { dimensions: [2, 4, 3] as const };
  const world = framePositionToWorld([1, -0.5, 0.25], frame);
  assert.deepEqual(world.toArray(), [4, -2, 1]);
  assert.deepEqual(worldPositionToFrame(world, frame), [1, -0.5, 0.25]);
});

test('custom lighting preserves the camera rim preference', () => {
  assert.equal(validateCustomLightingRig({ cameraRimLight: false }).cameraRimLight, false);
  assert.equal(validateCustomLightingRig({ cameraRimLight: true }).cameraRimLight, true);
  assert.equal(validateCustomLightingRig({}).cameraRimLight, false);
});

test('custom lighting defaults to the inspect rig', () => {
  const rig = createDefaultCustomLightingRig();
  assert.equal(rig.ambient, 0.4);
  assert.equal(rig.exposure, 1);
  assert.equal(rig.cameraRimLight, true);
  assert.deepEqual(rig.lights.map((light) => light.type), ['directional', 'spot', 'point']);
  assert.deepEqual(rig.lights.map((light) => light.color), ['#ffffff', '#fff3f3', '#dae7ff']);
  assert.deepEqual(rig.lights.map((light) => light.intensity), [1, 1 / 4.5, 1 / 15]);
});

test('custom lighting builds typed Three.js lights in authored order', () => {
  const rig = createDefaultCustomLightingRig();
  const runtimes = buildCustomLights(rig, { dimensions: [2, 4, 3] });
  assert.equal(runtimes.length, 3);
  assert.ok(runtimes[0].light instanceof THREE.DirectionalLight);
  assert.ok(runtimes[1].light instanceof THREE.SpotLight);
  assert.ok(runtimes[2].light instanceof THREE.PointLight);
  assert.ok(runtimes[1].target instanceof THREE.Object3D);
  assert.equal(runtimes[2].target, null);
  assert.equal(runtimes[0].light.intensity, rig.lights[0].intensity);
  assert.equal(runtimes[1].light.intensity, rig.lights[1].intensity * 16);
});

test('custom lighting updates an existing runtime without replacing its Three.js light', () => {
  const initial = createDefaultCustomLightingRig().lights[2];
  if (initial.type !== 'point') throw new Error('expected a point light');
  const runtime = buildCustomLights({
    version: 1,
    ambient: 0,
    exposure: 1,
    cameraRimLight: false,
    lights: [initial],
  }, { dimensions: [2, 2, 2] })[0];
  const threeLight = runtime.light;
  const updated = { ...initial, color: '#ff0000', intensity: 3, position: [1, 2, 3] as const };

  updateCustomLightRuntime(runtime, updated, { dimensions: [2, 2, 2] });

  assert.equal(runtime.light, threeLight);
  assert.equal(runtime.definition, updated);
  assert.deepEqual(runtime.light.position.toArray(), [2, 4, 6]);
  assert.equal(runtime.light.intensity, 12);
  assert.equal(runtime.light.color.getHexString(), 'ff0000');
});

test('normalized direct-light brightness is independent of model scale', () => {
  const definition = {
    id: 'point',
    name: 'Point',
    type: 'point' as const,
    enabled: true,
    color: '#ffffff',
    intensity: 2,
    position: [0, 0, 2] as const,
    range: null,
  };
  const small = buildCustomLights({ version: 1, ambient: 0, exposure: 1, cameraRimLight: true, lights: [definition] }, { dimensions: [1, 1, 1] })[0];
  const large = buildCustomLights({ version: 1, ambient: 0, exposure: 1, cameraRimLight: true, lights: [definition] }, { dimensions: [100, 100, 100] })[0];

  const normalizedSmall = small.light.intensity / small.source.lengthSq();
  const normalizedLarge = large.light.intensity / large.source.lengthSq();
  assert.equal(normalizedLarge, normalizedSmall);
});

test('directional direction points along the light ray toward its target', () => {
  const runtimes = buildCustomLights({
    version: 1,
    ambient: 0,
    exposure: 1,
    cameraRimLight: true,
    lights: [{
      id: 'sun',
      name: 'Sun',
      type: 'directional',
      enabled: true,
      color: '#ffffff',
      intensity: 1,
      direction: [0, 0, 1],
    }],
  }, { dimensions: [1, 1, 1] });
  const light = runtimes[0].light;
  assert.ok(light instanceof THREE.DirectionalLight);
  assert.ok(light.position.distanceTo(new THREE.Vector3(0, 0, -10)) < 1e-9);
  assert.ok(light.target.position.distanceTo(new THREE.Vector3()) < 1e-9);
});
