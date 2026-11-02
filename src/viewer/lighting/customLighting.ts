import * as THREE from 'three';
import type { LightingFrame } from './lighting';
import type { CustomLight, CustomLightingRig, FrameVector } from './customLightingModel';

export type {
  CustomLight,
  CustomLightingRig,
  CustomLightType,
  FrameVector,
} from './customLightingModel';

export interface CustomLightRuntime {
  definition: CustomLight;
  readonly light: THREE.Light;
  readonly target: THREE.Object3D | null;
  /** Source position in viewer world space, when the light has one. */
  readonly source: THREE.Vector3;
  /** Target position in viewer world space, when the light has one. */
  readonly targetPosition: THREE.Vector3 | null;
}

/** Update an existing runtime when its authored id and type are unchanged. */
export function updateCustomLightRuntime(
  runtime: CustomLightRuntime,
  light: CustomLight,
  frame?: Pick<LightingFrame, 'dimensions'> | null,
): void {
  const frameScale = customLightFrameScale(frame);
  const source = light.type === 'directional'
    ? vector(light.direction).multiplyScalar(-10 * frameScale)
    : framePositionToWorld(light.position, frame);

  runtime.definition = light;
  runtime.source.copy(source);
  runtime.light.color.set(light.color);
  runtime.light.visible = light.enabled;
  runtime.light.position.copy(source);

  if (light.type === 'point' && runtime.light instanceof THREE.PointLight) {
    runtime.light.intensity = light.intensity * frameScale * frameScale;
    runtime.light.distance = light.range === null ? 0 : light.range * frameScale;
    runtime.light.decay = 2;
  } else if (light.type === 'spot' && runtime.light instanceof THREE.SpotLight) {
    runtime.light.intensity = light.intensity * frameScale * frameScale;
    runtime.light.distance = light.range === null ? 0 : light.range * frameScale;
    runtime.light.angle = THREE.MathUtils.degToRad(light.angleDegrees);
    runtime.light.penumbra = light.softness;
    runtime.light.decay = 2;
    const target = framePositionToWorld(light.target, frame);
    runtime.targetPosition?.copy(target);
    runtime.target?.position.copy(target);
  } else if (light.type === 'directional' && runtime.light instanceof THREE.DirectionalLight) {
    runtime.light.intensity = light.intensity;
    runtime.targetPosition?.set(0, 0, 0);
    runtime.target?.position.set(0, 0, 0);
  }
}

const vector = (value: FrameVector): THREE.Vector3 => new THREE.Vector3(value[0], value[1], value[2]);

function customLightFrameScale(frame?: Pick<LightingFrame, 'dimensions'> | null): number {
  if (!frame) return 1;
  const dimensions = frame.dimensions;
  const largest = Math.max(...dimensions.map((value) => Math.abs(value)));
  return Number.isFinite(largest) && largest > 1e-5 ? largest : 1;
}

export function framePositionToWorld(position: FrameVector, frame?: Pick<LightingFrame, 'dimensions'> | null): THREE.Vector3 {
  return vector(position).multiplyScalar(customLightFrameScale(frame));
}

export function worldPositionToFrame(position: THREE.Vector3, frame?: Pick<LightingFrame, 'dimensions'> | null): FrameVector {
  const scale = customLightFrameScale(frame);
  return [position.x / scale, position.y / scale, position.z / scale];
}

function makeColor(color: string): THREE.Color {
  return new THREE.Color(color);
}

/** Build one runtime light from its serializable definition. */
function buildCustomLight(light: CustomLight, frame?: Pick<LightingFrame, 'dimensions'> | null): CustomLightRuntime {
  const frameScale = customLightFrameScale(frame);
  const source = light.type === 'directional'
    ? vector(light.direction).multiplyScalar(-10 * frameScale)
    : framePositionToWorld(light.position, frame);
  if (light.type === 'point') {
    // Point and spot lights fall off with inverse square. Positions are authored in
    // normalized weapon units but rendered in model units, so intensity grows with the
    // square of the scale to keep the authored brightness.
    const result = new THREE.PointLight(
      makeColor(light.color),
      light.intensity * frameScale * frameScale,
      light.range === null ? 0 : light.range * frameScale,
      2,
    );
    result.position.copy(source);
    result.visible = light.enabled;
    return { definition: light, light: result, target: null, source, targetPosition: null };
  }
  if (light.type === 'spot') {
    const targetPosition = framePositionToWorld(light.target, frame);
    const result = new THREE.SpotLight(
      makeColor(light.color),
      light.intensity * frameScale * frameScale,
      light.range === null ? 0 : light.range * frameScale,
      THREE.MathUtils.degToRad(light.angleDegrees),
      light.softness,
      2,
    );
    result.position.copy(source);
    result.target.position.copy(targetPosition);
    result.visible = light.enabled;
    return { definition: light, light: result, target: result.target, source, targetPosition };
  }
  const result = new THREE.DirectionalLight(makeColor(light.color), light.intensity);
  result.position.copy(source);
  result.target.position.set(0, 0, 0);
  result.visible = light.enabled;
  return { definition: light, light: result, target: result.target, source, targetPosition: new THREE.Vector3() };
}

/** Build all runtime lights, retaining the input order for editor selection. */
export function buildCustomLights(
  rig: CustomLightingRig,
  frame?: Pick<LightingFrame, 'dimensions'> | null,
): CustomLightRuntime[] {
  return rig.lights.map((light) => buildCustomLight(light, frame));
}
