import * as THREE from 'three';
import { BSP_MAP_LIGHTING } from './mapLighting.generated';

export type AmbientCube = readonly [
  THREE.Vector3, THREE.Vector3, THREE.Vector3,
  THREE.Vector3, THREE.Vector3, THREE.Vector3,
];

export interface LightingPreset {
  id: string;
  label: string;
  build: () => THREE.Light[];
  // Source order: +X, -X, +Y, -Y, +Z, -Z. Values are linear RGB.
  ambientCube: AmbientCube;
  background: number;
  skybox?: string;
  backgroundBlur?: number;
}

type SourceLight = readonly [number, number, number, number];
type SourceVector = readonly [number, number, number];

const cube = (
  px: [number, number, number], nx = px,
  py = px, ny = px, pz = px, nz = px,
): AmbientCube => [px, nx, py, ny, pz, nz].map((value) => new THREE.Vector3(...value)) as unknown as AmbientCube;

function sourceColor([r, g, b]: readonly number[]): THREE.Color {
  return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
}

function sourceLightIntensity(light: SourceLight): number {
  // Hammer brightness is an authoring value rather than a physical unit. 600
  // is the neutral bridge into the viewer: it keeps the raw ratios between
  // maps and makes Sawmill's 600-unit sun a three.js intensity of exactly 1.
  return light[3] / 600;
}

function sourceAmbientCube(light: SourceLight): AmbientCube {
  // Source's light_environment ambient is omnidirectional. Preserve its color
  // and brightness, normalizing 500 (Sawmill's authored value) to 1 before it
  // enters the TF2 ambient-cube shader.
  const scale = light[3] / 500;
  const value: [number, number, number] = [
    (light[0] / 255) * scale,
    (light[1] / 255) * scale,
    (light[2] / 255) * scale,
  ];
  return cube(value);
}

function sourceDirection(pitch: number, yaw: number): THREE.Vector3 {
  const p = THREE.MathUtils.degToRad(pitch);
  const y = THREE.MathUtils.degToRad(yaw);
  // Hammer light_environment uses negative pitch for downward travel. Convert
  // Source (X forward, Y left, Z up) to THREE (X right, Y up, Z forward).
  const source = new THREE.Vector3(Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), Math.sin(p));
  return new THREE.Vector3(-source.y, source.z, source.x).normalize();
}

function directional(color: THREE.ColorRepresentation, intensity: number, direction: THREE.Vector3) {
  const light = new THREE.DirectionalLight(color, intensity);
  // THREE shines from position to target, so place it opposite the Source ray.
  light.position.copy(direction).multiplyScalar(-10_000);
  light.target.position.set(0, 0, 0);
  return light;
}

function sourceEnvironmentLight(environment: { light: SourceLight | null; angles: SourceVector | null; pitch: number }) {
  if (!environment.light) return [];
  const yaw = environment.angles?.[1] ?? 0;
  return [directional(sourceColor(environment.light), sourceLightIntensity(environment.light), sourceDirection(environment.pitch, yaw))];
}

function sourceLocalSpot(
  light: (typeof BSP_MAP_LIGHTING.indoors.localLights)[number],
  sampleOrigin: SourceVector,
): THREE.SpotLight {
  const raw = light.light as SourceLight;
  const spot = new THREE.SpotLight(
    sourceColor(raw),
    sourceLightIntensity(raw),
    light.zeroPercentDistance > 0 ? light.zeroPercentDistance / 200 : 1000,
    THREE.MathUtils.degToRad(light.cone),
    Math.max(0, 1 - light.innerCone / Math.max(1, light.cone)),
    2,
  );
  const origin = light.origin as SourceVector;
  // Keep the exact map-space relationship while fitting Source units into the
  // small object-preview scene.
  spot.position.set(
    -(origin[1] - sampleOrigin[1]) / 200,
    (origin[2] - sampleOrigin[2]) / 200,
    (origin[0] - sampleOrigin[0]) / 200,
  );
  const direction = sourceDirection(light.pitch, light.angles?.[1] ?? 0);
  spot.target.position.copy(spot.position).add(direction.multiplyScalar(10));
  return spot;
}

function inspectionLights(): THREE.Light[] {
  // Resource/UI/econ/InspectionPanel.res from tf2_misc_dir.vpk.
  const key = directional(0xffffff, 1, new THREE.Vector3(0, -1, 0));

  const spot = new THREE.SpotLight(0xffffff, 1 / 4.5, 1000, Math.PI / 2, 0.36, 0);
  spot.color.setRGB(1, 0.9, 0.9);
  spot.position.set(0, 100, 0);
  spot.target.position.set(0, 50, 100);

  const point = new THREE.PointLight(0xffffff, 1 / 15, 1000, 0);
  point.color.setRGB(0.7, 0.8, 1);
  point.position.set(50, -200, 15);
  return [key, spot, point];
}

function fogBackground(color: readonly number[] | null): number {
  if (!color) return 0x1c1f24;
  return (color[0] << 16) | (color[1] << 8) | color[2];
}

const mapPreset = (id: keyof typeof BSP_MAP_LIGHTING): LightingPreset => {
  const source = BSP_MAP_LIGHTING[id];
  const isLocal = source.localLights.length > 0 && source.sampleOrigin;
  return {
    id,
    label: source.label,
    background: fogBackground(source.fog?.color ?? null),
    skybox: source.skybox,
    backgroundBlur: 0.48,
    ambientCube: sourceAmbientCube(source.environment.ambient as SourceLight),
    build: () => isLocal
      ? source.localLights.map((light) => sourceLocalSpot(light as (typeof BSP_MAP_LIGHTING.indoors.localLights)[number], source.sampleOrigin as SourceVector))
      : sourceEnvironmentLight(source.environment as { light: SourceLight; angles: SourceVector; pitch: number }),
  };
};

export const LIGHTING_PRESETS: LightingPreset[] = [
  {
    id: 'inspect',
    label: 'Inspect',
    background: 0x1c1f24,
    // CPotteryWheelPanel::CreateDefaultLights uses 0.4 on every cube face.
    ambientCube: cube([0.4, 0.4, 0.4]),
    build: inspectionLights,
  },
  mapPreset('daylight'),
  mapPreset('overcast'),
  mapPreset('indoors'),
  mapPreset('night'),
];

export function getPreset(id: string): LightingPreset {
  return LIGHTING_PRESETS.find((preset) => preset.id === id) ?? LIGHTING_PRESETS[0];
}
