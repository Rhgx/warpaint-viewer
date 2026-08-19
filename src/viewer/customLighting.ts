import * as THREE from 'three';
import type { LightingFrame } from './lighting';

/** The id used by the Lighting selector for a user-authored rig. */
export const CUSTOM_LIGHTING_ID = 'custom';
export const CUSTOM_LIGHTING_VERSION = 1 as const;
export const MAX_CUSTOM_LIGHTS = 8;

/** Positions are authored in units of the model's largest framed dimension. */
export const CUSTOM_LIGHT_POSITION_LIMIT = 10;
export const CUSTOM_LIGHT_INTENSITY_LIMIT = 20;
export const CUSTOM_LIGHT_RANGE_LIMIT = 20;
export const MAX_SPOT_ANGLE_DEGREES = 90;

export type CustomLightType = 'point' | 'spot' | 'directional';
export type FrameVector = readonly [number, number, number];

export interface CustomLightBase {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  /** CSS-compatible sRGB hex colour. */
  readonly color: string;
  readonly intensity: number;
}

export interface CustomPointLight extends CustomLightBase {
  readonly type: 'point';
  readonly position: FrameVector;
  /** Null means no distance cutoff. */
  readonly range: number | null;
}

export interface CustomSpotLight extends CustomLightBase {
  readonly type: 'spot';
  readonly position: FrameVector;
  readonly target: FrameVector;
  readonly range: number | null;
  readonly angleDegrees: number;
  /** 0 is a hard edge and 1 is a fully soft edge. */
  readonly softness: number;
}

export interface CustomDirectionalLight extends CustomLightBase {
  readonly type: 'directional';
  /** Unit light-ray vector from the source toward the illuminated point. */
  readonly direction: FrameVector;
}

export type CustomLight = CustomPointLight | CustomSpotLight | CustomDirectionalLight;

export interface CustomLightingRig {
  readonly version: typeof CUSTOM_LIGHTING_VERSION;
  readonly lights: readonly CustomLight[];
  /** Ambient cube strength used by the TF2 vertex-lit shader. */
  readonly ambient: number;
  readonly exposure: number;
  /** Preserve the material-authored, view-dependent TF2 rim highlight. */
  readonly cameraRimLight: boolean;
}

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

const DEFAULT_AMBIENT = 0.18;
const DEFAULT_EXPOSURE = 1;
const DEFAULT_POSITION: FrameVector = [0, 0, 0];
const DEFAULT_DIRECTION: FrameVector = [0, 0, 1];

const vector = (value: FrameVector): THREE.Vector3 => new THREE.Vector3(value[0], value[1], value[2]);

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return THREE.MathUtils.clamp(finiteNumber(value, fallback), min, max);
}

function readVector(value: unknown, fallback: FrameVector, limit = CUSTOM_LIGHT_POSITION_LIMIT): FrameVector {
  if (!Array.isArray(value) || value.length !== 3) return fallback;
  return [
    clampNumber(value[0], -limit, limit, fallback[0]),
    clampNumber(value[1], -limit, limit, fallback[1]),
    clampNumber(value[2], -limit, limit, fallback[2]),
  ];
}

function readDirection(value: unknown): FrameVector {
  const candidate = readVector(value, DEFAULT_DIRECTION, 1);
  const length = Math.hypot(candidate[0], candidate[1], candidate[2]);
  if (length < 1e-5) return DEFAULT_DIRECTION;
  return [candidate[0] / length, candidate[1] / length, candidate[2] / length];
}

function readColor(value: unknown): string {
  if (typeof value !== 'string') return '#ffffff';
  try {
    const color = new THREE.Color(value);
    return `#${color.getHexString()}`;
  } catch {
    return '#ffffff';
  }
}

function readString(value: unknown, fallback: string, maxLength: number): string {
  if (typeof value !== 'string') return fallback;
  const result = value.trim().slice(0, maxLength);
  return result || fallback;
}

function readRange(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return THREE.MathUtils.clamp(value, 0, CUSTOM_LIGHT_RANGE_LIMIT);
}

function readBase(value: Record<string, unknown>, index: number): CustomLightBase {
  return {
    id: readString(value.id, `light-${index + 1}`, 64),
    name: readString(value.name, `Light ${index + 1}`, 64),
    enabled: value.enabled !== false,
    color: readColor(value.color),
    intensity: clampNumber(value.intensity, 0, CUSTOM_LIGHT_INTENSITY_LIMIT, 1),
  };
}

function readLight(value: unknown, index: number): CustomLight {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const base = readBase(object, index);
  switch (object.type) {
    case 'spot':
      return {
        ...base,
        type: 'spot',
        position: readVector(object.position, DEFAULT_POSITION),
        target: readVector(object.target, DEFAULT_POSITION),
        range: readRange(object.range),
        // Three's spot light expects at most a quarter turn from its axis;
        // wider cones flip the cosine term in the shader and go dark.
        angleDegrees: clampNumber(object.angleDegrees, 1, MAX_SPOT_ANGLE_DEGREES, 45),
        softness: clampNumber(object.softness, 0, 1, 0.35),
      };
    case 'directional':
      return {
        ...base,
        type: 'directional',
        direction: readDirection(object.direction),
      };
    case 'point':
    default:
      return {
        ...base,
        type: 'point',
        position: readVector(object.position, DEFAULT_POSITION),
        range: readRange(object.range),
      };
  }
}

function uniqueLights(lights: readonly CustomLight[]): CustomLight[] {
  const ids = new Set<string>();
  return lights.map((light, index) => {
    let id = light.id || `light-${index + 1}`;
    let suffix = 2;
    while (ids.has(id)) id = `${light.id || `light-${index + 1}`}-${suffix++}`;
    ids.add(id);
    return id === light.id ? light : { ...light, id };
  });
}

/**
 * Sanitize an unknown value at the persistence/import boundary. This keeps
 * malformed shared state from reaching Three.js while preserving as much of
 * a partially valid rig as possible.
 */
export function validateCustomLightingRig(value: unknown): CustomLightingRig {
  const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const sourceLights = Array.isArray(object.lights) ? object.lights.slice(0, MAX_CUSTOM_LIGHTS) : [];
  const lights = uniqueLights(sourceLights.map((light, index) => readLight(light, index)));
  return {
    version: CUSTOM_LIGHTING_VERSION,
    lights,
    ambient: clampNumber(object.ambient, 0, 1, DEFAULT_AMBIENT),
    exposure: clampNumber(object.exposure, 0.1, 4, DEFAULT_EXPOSURE),
    cameraRimLight: object.cameraRimLight === true,
  };
}

export function createDefaultCustomLightingRig(): CustomLightingRig {
  return {
    version: CUSTOM_LIGHTING_VERSION,
    ambient: DEFAULT_AMBIENT,
    exposure: DEFAULT_EXPOSURE,
    cameraRimLight: false,
    lights: [
      {
        id: 'key', name: 'Key light', type: 'spot', enabled: true, color: '#fff1df', intensity: 2.4,
        position: [1.2, 1.8, 2.4], target: [0, 0, 0], range: null, angleDegrees: 48, softness: 0.35,
      },
      {
        id: 'fill', name: 'Fill light', type: 'point', enabled: true, color: '#c6d8ff', intensity: 0.9,
        position: [-1.8, 0.2, 1.1], range: null,
      },
      {
        id: 'rim', name: 'Rim light', type: 'spot', enabled: true, color: '#bcd4ff', intensity: 2,
        position: [-1.1, 1.4, -2], target: [0, 0, 0], range: null, angleDegrees: 42, softness: 0.4,
      },
    ],
  };
}

export function customLightFrameScale(frame?: Pick<LightingFrame, 'dimensions'> | null): number {
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
export function buildCustomLight(light: CustomLight, frame?: Pick<LightingFrame, 'dimensions'> | null): CustomLightRuntime {
  const frameScale = customLightFrameScale(frame);
  const source = light.type === 'directional'
    ? vector(light.direction).multiplyScalar(-10 * frameScale)
    : framePositionToWorld(light.position, frame);
  if (light.type === 'point') {
    // Point and spot lights use inverse-square falloff. Their positions are
    // authored in normalized weapon units but rendered in model units, so
    // intensity must grow by scale squared to preserve the authored brightness
    // at the same normalized distance.
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
