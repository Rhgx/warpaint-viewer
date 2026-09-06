import { MAX_CUSTOM_LIGHTS } from '../../viewer/customLighting';
import type { CustomLight, CustomLightingRig, CustomLightType, FrameVector } from '../../viewer/customLighting';

/**
 * Pure helpers shared by the stage lighting panel and the inspector summary.
 * Kept free of JSX so both component files can import it without tripping the
 * react/only-export-components rule.
 */

/** Roles seed a light with a usable position and tint; bare types start neutral. */
export type LightTemplate = 'key' | 'fill' | 'rim' | CustomLightType;

/** One name per type across the whole UI: the badge, the picker and the menu. */
export const TYPE_OPTIONS = [
  { value: 'point', label: 'Point' },
  { value: 'spot', label: 'Spot' },
  { value: 'directional', label: 'Sun' },
];

export const TYPE_LABELS: Record<CustomLightType, string> = {
  point: 'Point',
  spot: 'Spot',
  directional: 'Sun',
};

export const ROLE_TEMPLATES: readonly { value: LightTemplate; label: string }[] = [
  { value: 'key', label: 'Key' },
  { value: 'fill', label: 'Fill' },
  { value: 'rim', label: 'Rim' },
];

export const TYPE_TEMPLATES: readonly { value: LightTemplate; label: string; type: CustomLightType }[] = [
  { value: 'point', label: 'Point', type: 'point' },
  { value: 'spot', label: 'Spot', type: 'spot' },
  { value: 'directional', label: 'Sun', type: 'directional' },
];

/** Axis order is shared by the vector fields and the viewport gizmo arrows. */
export const AXES = ['X', 'Y', 'Z'] as const;

/** A finite range to fall back to when the user turns off "no cutoff". */
export const DEFAULT_FINITE_RANGE = 6;

function cloneVector(vector: FrameVector): FrameVector {
  return [vector[0], vector[1], vector[2]];
}

export function clampScalar(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Trim float noise so a slider drag does not print 1.2000000000000002. */
export function formatScalar(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

export function nextLightId(lights: readonly CustomLight[], base: string): string {
  const used = new Set(lights.map((light) => light.id));
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index++) {
    const candidate = `${base}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** Keep list names distinct: "Key light", then "Key light 2". */
export function uniqueLightName(lights: readonly CustomLight[], base: string): string {
  const used = new Set(lights.map((light) => light.name));
  if (!used.has(base)) return base;
  for (let index = 2; index < 100; index++) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/** Duplicating a duplicate reads as "Key light copy 2", not "copy copy". */
function duplicateLightName(lights: readonly CustomLight[], name: string): string {
  return uniqueLightName(lights, `${name.replace(/ copy( \d+)?$/, '')} copy`);
}

export function deleteLightFromRig(
  rig: CustomLightingRig,
  id: string,
): { rig: CustomLightingRig; selectedLightId: string | null } | null {
  const index = rig.lights.findIndex((light) => light.id === id);
  if (index < 0) return null;
  const lights = rig.lights.filter((light) => light.id !== id);
  return {
    rig: { ...rig, lights },
    selectedLightId: lights[Math.min(index, lights.length - 1)]?.id ?? null,
  };
}

export function duplicateLightInRig(
  rig: CustomLightingRig,
  id: string,
): { rig: CustomLightingRig; selectedLightId: string } | null {
  if (rig.lights.length >= MAX_CUSTOM_LIGHTS) return null;
  const light = rig.lights.find((entry) => entry.id === id);
  if (!light) return null;
  const copyId = nextLightId(rig.lights, `${light.id}-copy`);
  const name = duplicateLightName(rig.lights, light.name);
  const copy: CustomLight = light.type === 'directional'
    ? { ...light, id: copyId, name, direction: cloneVector(light.direction) }
    : {
        ...light,
        id: copyId,
        name,
        position: [light.position[0] + 0.4, light.position[1], light.position[2]],
        ...(light.type === 'spot' ? { target: cloneVector(light.target) } : {}),
      };
  return { rig: { ...rig, lights: [...rig.lights, copy] }, selectedLightId: copyId };
}

export function templateLight(template: LightTemplate, id: string): CustomLight {
  const base = { id, name: 'Light', enabled: true, color: '#ffffff', intensity: 1 } as const;
  if (template === 'key') {
    return {
      ...base,
      name: 'Key light',
      type: 'spot',
      color: '#fff1e2',
      intensity: 2.4,
      position: [1.2, 1.8, 2.4],
      target: [0, 0, 0],
      range: null,
      angleDegrees: 48,
      softness: 0.35,
    };
  }
  if (template === 'fill') {
    return {
      ...base,
      name: 'Fill light',
      type: 'point',
      color: '#c6d8ff',
      intensity: 0.9,
      position: [-1.8, 0.2, 1.1],
      range: null,
    };
  }
  if (template === 'rim') {
    return {
      ...base,
      name: 'Rim light',
      type: 'spot',
      color: '#bcd4ff',
      intensity: 2,
      position: [-1.1, 1.4, -2],
      target: [0, 0, 0],
      range: null,
      angleDegrees: 42,
      softness: 0.4,
    };
  }
  if (template === 'spot') {
    return {
      ...base,
      name: 'Spot light',
      type: 'spot',
      intensity: 2,
      position: [0, 1.4, 2.2],
      target: [0, 0, 0],
      range: null,
      angleDegrees: 45,
      softness: 0.35,
    };
  }
  if (template === 'directional') {
    return { ...base, name: 'Sun light', type: 'directional', direction: [-0.4, -0.7, -0.6] };
  }
  return { ...base, name: 'Point light', type: 'point', position: [0, 1.4, 2.2], range: null };
}

export function changeLightType(light: CustomLight, type: CustomLightType): CustomLight {
  if (type === light.type) return light;
  const base = {
    id: light.id,
    name: light.name,
    enabled: light.enabled,
    color: light.color,
    intensity: light.intensity,
  } as const;
  if (type === 'directional') {
    return { ...base, type, direction: 'direction' in light ? cloneVector(light.direction) : [-0.4, -0.7, -0.6] };
  }
  const position = 'position' in light ? cloneVector(light.position) : [0, 1.4, 2.2] as FrameVector;
  const range = 'range' in light ? light.range : null;
  if (type === 'spot') {
    return {
      ...base,
      type,
      position,
      target: 'target' in light ? cloneVector(light.target) : [0, 0, 0],
      range,
      angleDegrees: 'angleDegrees' in light ? light.angleDegrees : 45,
      softness: 'softness' in light ? light.softness : 0.35,
    };
  }
  return { ...base, type, position, range };
}
