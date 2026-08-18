import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as THREE from 'three';
import { getPreset } from '../../../src/viewer/lighting';

const EPSILON = 1e-6;

function assertVector(actual: THREE.Vector3, expected: THREE.Vector3, message: string): void {
  assert.ok(actual.distanceTo(expected) <= EPSILON, `${message}: ${actual.toArray()} !== ${expected.toArray()}`);
}

test('inspect lighting matches InspectionPanel.res in camera-local space', () => {
  const lights = getPreset('inspect').build(new THREE.PerspectiveCamera());
  assert.equal(lights.length, 3);
  const [key, spot, point] = lights;
  if (!(key instanceof THREE.DirectionalLight)) throw new Error('inspect key light is not directional');
  if (!(spot instanceof THREE.SpotLight)) throw new Error('inspect spot light is not a spotlight');
  if (!(point instanceof THREE.PointLight)) throw new Error('inspect point light is not a point light');

  assertVector(key.position, new THREE.Vector3(0, -10_000, 0), 'directional incident sign');

  assertVector(spot.position, new THREE.Vector3(0, 100, 0), 'spot source-panel position');
  assertVector(
    spot.position.clone().sub(spot.target.position).normalize(),
    new THREE.Vector3(0, 1, 2).normalize(),
    'spot incident direction',
  );
  const sourceOuterConeCosine = Math.cos(90);
  const sourceInnerConeCosine = Math.cos(1);
  assert.ok(
    Math.abs(Math.cos(spot.angle) - sourceOuterConeCosine) <= EPSILON,
    'spot outer cone matches LightDesc_t cos(90)',
  );
  assert.ok(
    Math.abs(Math.cos(spot.angle * (1 - spot.penumbra)) - sourceInnerConeCosine) <= EPSILON,
    'spot inner cone matches LightDesc_t cos(1)',
  );
  assert.equal(getPreset('inspect').spotFalloff, 25);
  assert.equal(spot.distance, 0, 'spot avoids Three smooth range cutoff');

  assertVector(point.position, new THREE.Vector3(50, -200, -15), 'point source-panel position');
  assert.equal(point.distance, 0, 'point avoids Three smooth range cutoff');
});
