import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Killstreak sheens
//
// TF2 renders a killstreak sheen as a second render pass over the weapon
// (materialsystem/stdshaders/weapon_sheen_pass_ps2x.fxc), driven by
// CProxyAnimatedWeaponSheen (game/client/tf/c_tf_player.cpp). The pass
// reflects a small cubemap through the model's smooth normal, masked by an
// animated sweep texture whose UV comes from the model's raw (uncentered)
// local-space position.
// ---------------------------------------------------------------------------

// tf_sheen_framerate (25 fps over 60 mask frames), and MAX_SHEEN_WAIT (5s)
// with no killstreak owner driving the proxy, which is the inspect case.
export const SHEEN_FRAMERATE = 25;
export const SHEEN_MASK_FRAMES = 60;
export const SHEEN_SWEEP_SECONDS = SHEEN_MASK_FRAMES / SHEEN_FRAMERATE;
export const SHEEN_PAUSE_SECONDS = 5;

export interface SheenAssets {
  maskTexture: THREE.Texture;
  cubeTexture: THREE.CubeTexture;
  maskFrames: number;
}

// Loaded lazily by the Viewer the first time a sheen is enabled, and kept for
// that Viewer's lifetime (not a module-level cache: each Viewer disposes its
// own copy).
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
  // weapon_sheen_pass_helper.cpp only enables sRGB reads on these samplers
  // for HDR_TYPE_NONE; TF2 runs HDR by default and samples both raw. Decoding
  // them to linear here quarters the mask contribution and makes the sweep
  // nearly invisible, so sample raw like the game does.
  maskTexture.colorSpace = THREE.NoColorSpace;
  maskTexture.wrapS = THREE.ClampToEdgeWrapping;
  maskTexture.wrapT = THREE.ClampToEdgeWrapping;
  maskTexture.needsUpdate = true;
  cubeTexture.colorSpace = THREE.NoColorSpace;
  cubeTexture.needsUpdate = true;
  return { maskTexture, cubeTexture, maskFrames: json.maskFrames };
}

const SHEEN_VERTEX = /* glsl */ `
varying vec3 vSheenModelPos;
varying vec3 vSheenWorldNormal;
varying vec3 vSheenWorldViewVector;
void main() {
  vSheenModelPos = position;
  vSheenWorldNormal = mat3( modelMatrix ) * normal;
  vec4 sheenWorldPos = modelMatrix * vec4( position, 1.0 );
  vSheenWorldViewVector = sheenWorldPos.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * sheenWorldPos;
}
`;

// Port of weapon_sheen_pass_ps2x.fxc's g_flEffectIndex == 0 path (BUMPMAP=0),
// the path used by warpaint weapons: a plain reflection vector off the
// smooth geometric normal, masked by an animated sweep texture whose UV
// comes from the model's raw local-space position.
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

  // The mask band is a vertical streak that travels along U over the
  // animation, so U must follow the weapon's longest axis for the sweep to
  // run front to back (the SDK's axis table assumes Source's Z-up models).
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

// CProxyAnimatedWeaponSheen::InitParams equivalent for Y-up glTF models: the
// mask band travels along the mask's U axis, so U (scaleX/offsetX) maps to
// the model's longest raw-space axis (the weapon's length) and V to the
// second-longest, instead of the SDK's Z-up axis-pair table.
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
