import * as THREE from 'three';
import { BSP_MAP_LIGHTING } from './mapLighting.generated';

export type AmbientCube = readonly [
  THREE.Vector3, THREE.Vector3, THREE.Vector3,
  THREE.Vector3, THREE.Vector3, THREE.Vector3,
];

export interface LightingPreset {
  id: string;
  label: string;
  build: (camera?: THREE.PerspectiveCamera) => THREE.Light[];
  // THREE world-axis order: +X, -X, +Y, -Y, +Z, -Z. Values are linear RGB.
  ambientCube: AmbientCube;
  background: number;
  backplate?: string;
  exposure?: number;
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
  // VRAD compiles Hammer's sRGB light color to linear, then scales it by
  // brightness / 250. This reproduces the intensity vectors in the BSP's
  // LUMP_WORLDLIGHTS_HDR (for example Sawmill 600 -> 2.4x).
  return light[3] / 250;
}

function compiledAmbientCube(sourceCube: readonly (readonly number[])[]): AmbientCube {
  const face = (sourceIndex: number) => new THREE.Vector3(...sourceCube[sourceIndex] as [number, number, number]);
  // The BSP stores Source axes. The shader receives THREE world normals:
  // THREE +X/-X = Source -Y/+Y, +Y/-Y = +Z/-Z, +Z/-Z = +X/-X.
  return [face(3), face(2), face(4), face(5), face(0), face(1)];
}

function sourceCameraBasis(angles: SourceVector) {
  const pitch = THREE.MathUtils.degToRad(angles[0]);
  const yaw = THREE.MathUtils.degToRad(angles[1]);
  const forward = new THREE.Vector3(
    Math.cos(pitch) * Math.cos(yaw),
    Math.cos(pitch) * Math.sin(yaw),
    -Math.sin(pitch),
  ).normalize();
  const right = new THREE.Vector3(Math.sin(yaw), -Math.cos(yaw), 0).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  return { forward, right, up };
}

function sourceVectorToCameraWorld(
  source: THREE.Vector3,
  captureAngles: SourceVector,
  camera?: THREE.PerspectiveCamera,
): THREE.Vector3 {
  const basis = sourceCameraBasis(captureAngles);
  const cameraLocal = new THREE.Vector3(
    source.dot(basis.right),
    source.dot(basis.up),
    -source.dot(basis.forward),
  );
  return camera ? cameraLocal.applyQuaternion(camera.quaternion) : cameraLocal;
}

function directional(color: THREE.ColorRepresentation, intensity: number, direction: THREE.Vector3) {
  const light = new THREE.DirectionalLight(color, intensity);
  // THREE shines from position to target, so place it opposite the Source ray.
  light.position.copy(direction).multiplyScalar(-10_000);
  light.target.position.set(0, 0, 0);
  return light;
}

function sourceEnvironmentLight(
  environment: { light: SourceLight | null; angles: SourceVector | null; pitch: number },
  captureAngles: SourceVector,
  camera?: THREE.PerspectiveCamera,
) {
  if (!environment.light) return [];
  const yaw = environment.angles?.[1] ?? 0;
  const sourceRay = new THREE.Vector3(
    Math.cos(THREE.MathUtils.degToRad(environment.pitch)) * Math.cos(THREE.MathUtils.degToRad(yaw)),
    Math.cos(THREE.MathUtils.degToRad(environment.pitch)) * Math.sin(THREE.MathUtils.degToRad(yaw)),
    Math.sin(THREE.MathUtils.degToRad(environment.pitch)),
  ).normalize();
  return [directional(
    sourceColor(environment.light),
    sourceLightIntensity(environment.light),
    sourceVectorToCameraWorld(sourceRay, captureAngles, camera),
  )];
}

function sourceLocalSpot(
  light: (typeof BSP_MAP_LIGHTING.indoors.localLights)[number],
  sampleOrigin: SourceVector,
  captureAngles: SourceVector,
  focusDistance: number,
  camera?: THREE.PerspectiveCamera,
): THREE.SpotLight {
  const raw = light.light as SourceLight;
  // The viewer can pan weapons much farther than a physical inspect camera.
  // Keep local fixtures angularly correct but outside every weapon's bounds,
  // avoiding light/model intersections and unstable inverse-square changes.
  const safeLightRadius = 1000;
  const spot = new THREE.SpotLight(
    sourceColor(raw),
    sourceLightIntensity(raw),
    0,
    THREE.MathUtils.degToRad(light.cone),
    Math.max(0, 1 - light.innerCone / Math.max(1, light.cone)),
    0,
  );
  const origin = light.origin as SourceVector;
  const cameraBasis = sourceCameraBasis(captureAngles);
  const focusOrigin = new THREE.Vector3(...sampleOrigin).addScaledVector(cameraBasis.forward, focusDistance);
  const sourceOffset = new THREE.Vector3(...origin).sub(focusOrigin);
  spot.position.copy(sourceVectorToCameraWorld(sourceOffset, captureAngles, camera).normalize().multiplyScalar(safeLightRadius));
  const sourceRay = new THREE.Vector3(
    Math.cos(THREE.MathUtils.degToRad(light.pitch)) * Math.cos(THREE.MathUtils.degToRad(light.angles?.[1] ?? 0)),
    Math.cos(THREE.MathUtils.degToRad(light.pitch)) * Math.sin(THREE.MathUtils.degToRad(light.angles?.[1] ?? 0)),
    Math.sin(THREE.MathUtils.degToRad(light.pitch)),
  ).normalize();
  const direction = sourceVectorToCameraWorld(sourceRay, captureAngles, camera);
  spot.target.position.copy(spot.position).add(direction.multiplyScalar(safeLightRadius * 2));
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

function ambientProbeBackground(sourceCube: readonly (readonly number[])[]): number {
  const average = [0, 1, 2].map((channel) => (
    sourceCube.reduce((sum, face) => sum + face[channel], 0) / sourceCube.length
  ));
  // Probe values are already linear; convert to the display color space used
  // by THREE.Color backgrounds. This gives the room its compiled warm-brown
  // ambience without inventing another hand-authored color.
  return new THREE.Color(average[0], average[1], average[2]).getHex(THREE.SRGBColorSpace);
}

const mapPreset = (id: keyof typeof BSP_MAP_LIGHTING): LightingPreset => {
  const source = BSP_MAP_LIGHTING[id];
  const isLocal = source.localLights.length > 0 && source.sampleOrigin;
  return {
    id,
    label: source.label,
    background: isLocal
      ? ambientProbeBackground(source.ambientProbe.cube)
      : fogBackground(source.fog?.color ?? null),
    // Actual in-map captures are baked into blurred 2D backplates. Lighting
    // still comes exclusively from the BSP data above.
    backplate: `/data/env/backplates/${id}.webp`,
    // Source SDK 2013's default mat_autoexposure_max. An isolated weapon
    // against sky converges near this end of TF2's 0.5-2.0 HDR range.
    exposure: 2,
    ambientCube: compiledAmbientCube(source.ambientProbe.cube),
    build: (camera) => isLocal
      ? source.localLights.map((light) => sourceLocalSpot(
        light as (typeof BSP_MAP_LIGHTING.indoors.localLights)[number],
        source.sampleOrigin as SourceVector,
        source.captureAngles as SourceVector,
        source.focusDistance,
        camera,
      ))
      : sourceEnvironmentLight(
        source.environment as { light: SourceLight; angles: SourceVector; pitch: number },
        source.captureAngles as SourceVector,
        camera,
      ),
  };
};

export const LIGHTING_PRESETS: LightingPreset[] = [
  {
    id: 'inspect',
    label: 'Inspect',
    background: 0x1c1f24,
    exposure: 1,
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
