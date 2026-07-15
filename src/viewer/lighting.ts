import * as THREE from 'three';

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
}

const cube = (
  px: [number, number, number], nx = px,
  py = px, ny = px, pz = px, nz = px,
): AmbientCube => [px, nx, py, ny, pz, nz].map((v) => new THREE.Vector3(...v)) as unknown as AmbientCube;

function directional(color: number, intensity: number, x: number, y: number, z: number) {
  const light = new THREE.DirectionalLight(color, intensity);
  // Source LightDesc_t::m_Direction is the light's propagation direction;
  // CommitPixelShaderLighting places directional lights at -direction * 1e4.
  // THREE shines from position toward target, so position = -direction mapped
  // through Source (X fwd, Y left, Z up) -> THREE (X right, Y up, Z fwd).
  light.position.set(y, -z, -x);
  light.target.position.set(0, 0, 0);
  return light;
}

function inspectionLights(): THREE.Light[] {
  // Resource/UI/econ/InspectionPanel.res from tf2_misc_dir.vpk.
  const key = directional(0xffffff, 1, 0, 0, -1);

  const spot = new THREE.SpotLight(0xffffff, 1 / 4.5, 1000, Math.PI / 2, 0.36, 0);
  spot.color.setRGB(1, 0.9, 0.9);
  // Source world (X forward, Y left, Z up) -> THREE world (X right, Y up,
  // Z forward): (-Y, Z, X).
  spot.position.set(0, 100, 0);
  spot.target.position.set(0, 50, 100);

  const point = new THREE.PointLight(0xffffff, 1 / 15, 1000, 0);
  point.color.setRGB(0.7, 0.8, 1);
  point.position.set(50, -200, 15);
  return [key, spot, point];
}

export const LIGHTING_PRESETS: LightingPreset[] = [
  {
    id: 'inspect',
    label: 'Inspect (TF2 item panel)',
    background: 0x1c1f24,
    // CPotteryWheelPanel::CreateDefaultLights uses 0.4 on every cube face.
    ambientCube: cube([0.4, 0.4, 0.4]),
    build: inspectionLights,
  },
  {
    id: 'daylight',
    label: 'Daylight (Badlands)',
    background: 0x9fb8d6,
    ambientCube: cube([0.28, 0.34, 0.44], [0.25, 0.30, 0.39], [0.42, 0.48, 0.58], [0.16, 0.13, 0.10], [0.30, 0.36, 0.46], [0.24, 0.27, 0.33]),
    build: () => [directional(0xfff2d6, 1.05, -2, -2.4, -1)],
  },
  {
    id: 'overcast',
    label: 'Overcast (Sawmill)',
    background: 0x8f959b,
    ambientCube: cube([0.34, 0.35, 0.37], [0.32, 0.33, 0.35], [0.42, 0.43, 0.45], [0.22, 0.23, 0.24], [0.34, 0.35, 0.37], [0.30, 0.31, 0.33]),
    build: () => [directional(0xd8dade, 0.32, -0.6, -1.8, -0.5)],
  },
  {
    id: 'indoors',
    label: 'Indoors (2fort intel)',
    background: 0x2b2620,
    ambientCube: cube([0.15, 0.13, 0.10], [0.11, 0.10, 0.08], [0.30, 0.23, 0.15], [0.06, 0.06, 0.05], [0.14, 0.12, 0.09], [0.09, 0.10, 0.08]),
    build: () => [directional(0xffd9a0, 0.9, -0.8, -1.2, -0.9), directional(0x557a66, 0.2, 1, -0.2, 0.8)],
  },
  {
    id: 'night',
    label: 'Night (Halloween)',
    background: 0x0c0f18,
    ambientCube: cube([0.05, 0.07, 0.13], [0.04, 0.05, 0.10], [0.10, 0.13, 0.24], [0.015, 0.018, 0.03], [0.06, 0.08, 0.15], [0.03, 0.04, 0.08]),
    build: () => [directional(0x9fb4ff, 0.78, 1, -1.8, -0.6), directional(0xff3fae, 0.34, -1.4, -0.3, 1.2)],
  },
];

export function getPreset(id: string): LightingPreset {
  return LIGHTING_PRESETS.find((p) => p.id === id) ?? LIGHTING_PRESETS[0];
}
