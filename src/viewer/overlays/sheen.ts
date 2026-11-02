import * as THREE from 'three';

// Killstreak sheens: TF2 draws the sheen as a second pass over the weapon
// (weapon_sheen_pass_ps2x.fxc), driven by CProxyAnimatedWeaponSheen. It reflects a
// small cubemap through the smooth normal, masked by an animated sweep whose UV
// comes from the raw, uncentered local-space position.

// Timings match tf_sheen_framerate (25 fps, 60 mask frames) and MAX_SHEEN_WAIT (5 s),
// as with no killstreak owner driving the proxy (the inspect case).
export const SHEEN_FRAMERATE = 25;
export const SHEEN_MASK_FRAMES = 60;
export const SHEEN_SWEEP_SECONDS = SHEEN_MASK_FRAMES / SHEEN_FRAMERATE;
export const SHEEN_PAUSE_SECONDS = 5;

// Ms from the sheen clock to the next mask frame change while sweeping. Uses the same
// frame index as the overlay's animation step, so pacing renders never change an image.
export function msUntilNextSheenFrame(elapsedSeconds: number): number {
  const tInCycle = elapsedSeconds % (SHEEN_SWEEP_SECONDS + SHEEN_PAUSE_SECONDS);
  const nextFrame = Math.floor(SHEEN_FRAMERATE * tInCycle) + 1;
  return (nextFrame / SHEEN_FRAMERATE - tInCycle) * 1000;
}

export interface SheenAssets {
  maskTexture: THREE.Texture;
  cubeTexture: THREE.CubeTexture;
  maskFrames: number;
}

// Loaded lazily per Viewer and kept for its lifetime. Not a module-level cache,
// because each Viewer disposes its own copy.
export async function loadSheenAssets(): Promise<SheenAssets> {
  const base = import.meta.env.BASE_URL;
  const [json, maskTexture, cubeTexture] = await Promise.all([
    fetch(`${base}data/effects/sheen/sheen.json`).then((r) => {
      if (!r.ok) throw new Error(`sheen.json fetch failed: ${r.status}`);
      return r.json() as Promise<{ maskFrames: number; maskWidth: number; maskHeight: number }>;
    }),
    new THREE.TextureLoader().loadAsync(`${base}data/effects/sheen/mask_strip.png`),
    new THREE.CubeTextureLoader().setPath(`${base}data/effects/sheen/cubemap/`).loadAsync([
      'px.png', 'nx.png', 'py.png', 'ny.png', 'pz.png', 'nz.png',
    ]),
  ]);
  // TF2 samples these raw (sRGB reads only apply to HDR_TYPE_NONE). Decoding here
  // quarters the mask contribution and makes the sweep nearly invisible.
  maskTexture.colorSpace = THREE.NoColorSpace;
  maskTexture.wrapS = THREE.ClampToEdgeWrapping;
  maskTexture.wrapT = THREE.ClampToEdgeWrapping;
  maskTexture.needsUpdate = true;
  cubeTexture.colorSpace = THREE.NoColorSpace;
  cubeTexture.needsUpdate = true;
  return { maskTexture, cubeTexture, maskFrames: json.maskFrames };
}

// gl_Position uses three's chunks: the pass sits exactly on the weapon, and a
// hand-written transform rounds differently and fights the depth test.
const SHEEN_VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
uniform mat4 uSheenModelTransform;
varying vec3 vSheenModelPos;
varying vec3 vSheenWorldNormal;
varying vec3 vSheenWorldViewVector;
void main() {
  #include <skinbase_vertex>
  #include <beginnormal_vertex>
  #include <skinnormal_vertex>
  vSheenModelPos = ( uSheenModelTransform * vec4( position, 1.0 ) ).xyz;
  vSheenWorldNormal = mat3( modelMatrix ) * objectNormal;
  #include <begin_vertex>
  #include <skinning_vertex>
  vSheenWorldViewVector = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz - cameraPosition;
  #include <project_vertex>
}
`;

// Port of weapon_sheen_pass_ps2x.fxc's g_flEffectIndex == 0 (BUMPMAP=0) path, the
// one warpaint weapons use: reflection off the smooth normal, masked by the sweep.
const SHEEN_FRAGMENT = /* glsl */ `
uniform samplerCube uSheenMap;
uniform sampler2D uSheenMaskFrame;
uniform float uMaskFrames;
uniform float uFrame;
uniform vec4 uTint;
uniform vec2 uMaskScale;
uniform vec2 uMaskOffset;
uniform int uSweepAxis;
uniform int uSideAxis;
varying vec3 vSheenModelPos;
varying vec3 vSheenWorldNormal;
varying vec3 vSheenWorldViewVector;
float sheenAxisCoord( vec3 p, int axis ) {
  if ( axis == 0 ) return p.x;
  if ( axis == 1 ) return p.y;
  return p.z;
}
void main() {
  vec3 vEyeDir = -normalize( vSheenWorldViewVector );
  vec3 n = normalize( vSheenWorldNormal );
  vec3 vReflect = 2.0 * n * dot( n, vEyeDir ) - vEyeDir;
  vec3 envMapColor = textureCube( uSheenMap, vReflect ).rgb * uTint.rgb * 10.0;

  // The mask band travels along U, so U must follow the weapon's longest axis for
  // the sweep to run front to back (the SDK's axis table assumes Z-up models).
  vec2 t = vec2(
    sheenAxisCoord( vSheenModelPos, uSweepAxis ),
    sheenAxisCoord( vSheenModelPos, uSideAxis )
  );
  t -= uMaskOffset;
  t /= max( uMaskScale, vec2( 0.0001 ) );
  t.y = 1.0 - t.y;

  // Frame 0 sits at the top of the strip; three's default flipY places v=1 at
  // the top of the uploaded image, so band k occupies v in
  // [1-(k+1)/N, 1-k/N] -- matches repeat.y = 1/N, offset.y = 1-(k+1)/N.
  vec2 stripUv = vec2( t.x, ( t.y + ( uMaskFrames - 1.0 - uFrame ) ) / uMaskFrames );
  vec4 maskTexel = texture2D( uSheenMaskFrame, stripUv );

  float alpha = max( max( envMapColor.r, envMapColor.g ), envMapColor.b );
  gl_FragColor = vec4( envMapColor * maskTexel.rgb, alpha * maskTexel.r * uTint.a );
  #include <colorspace_fragment>
}
`;

export function createSheenMaterial(assets: SheenAssets, side: THREE.Side): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSheenModelTransform: { value: new THREE.Matrix4() },
      uSheenMap: { value: assets.cubeTexture },
      uSheenMaskFrame: { value: assets.maskTexture },
      uMaskFrames: { value: assets.maskFrames },
      uFrame: { value: 0 },
      uTint: { value: new THREE.Vector4(0, 0, 0, 1) },
      uMaskScale: { value: new THREE.Vector2(1, 1) },
      uMaskOffset: { value: new THREE.Vector2(0, 0) },
      uSweepAxis: { value: 0 },
      uSideAxis: { value: 1 },
    },
    vertexShader: SHEEN_VERTEX,
    fragmentShader: SHEEN_FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    depthFunc: THREE.LessEqualDepth,
    blending: THREE.NormalBlending,
    side,
  });
}

// CProxyAnimatedWeaponSheen::InitParams equivalent for Y-up glTF models: U maps to
// the longest raw-space axis (the weapon's length) and V to the second-longest,
// instead of the SDK's Z-up axis-pair table.
export interface SheenFrameData {
  scaleX: number;
  offsetX: number;
  scaleY: number;
  offsetY: number;
  sweepAxis: 0 | 1 | 2;
  sideAxis: 0 | 1 | 2;
}

export function computeSheenFrameData(min: THREE.Vector3, max: THREE.Vector3): SheenFrameData {
  const extents = [max.x - min.x, max.y - min.y, max.z - min.z];
  let sweepAxis: 0 | 1 | 2 = 0;
  if (extents[1] > extents[sweepAxis]) sweepAxis = 1;
  if (extents[2] > extents[sweepAxis]) sweepAxis = 2;
  const rest = ([0, 1, 2] as const).filter((axis) => axis !== sweepAxis);
  const sideAxis = extents[rest[0]] >= extents[rest[1]] ? rest[0] : rest[1];
  return {
    scaleX: extents[sweepAxis],
    offsetX: min.getComponent(sweepAxis),
    scaleY: extents[sideAxis],
    offsetY: min.getComponent(sideAxis),
    sweepAxis,
    sideAxis,
  };
}
