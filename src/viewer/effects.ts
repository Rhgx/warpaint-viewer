import * as THREE from 'three';
import { SHEEN_PRESETS, UNUSUAL_PRESETS, VIEW_ANGLES, getSheen } from './presets';
import type { SheenPreset, UnusualPreset, ViewAnglePreset } from './presets';

// Preset data (SHEEN_PRESETS, UNUSUAL_PRESETS, VIEW_ANGLES, getSheen) lives in
// ./presets, which has no three.js import: src/ui/** imports it directly so
// the controls bar doesn't have to pull this whole (three.js-heavy) module
// into the eagerly-loaded chunk just to build its selects.
export { SHEEN_PRESETS, UNUSUAL_PRESETS, VIEW_ANGLES, getSheen };
export type { SheenPreset, UnusualPreset, ViewAnglePreset };

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

// ---------------------------------------------------------------------------
// Unusual weapon effects
//
// A CPU port of the four weapon_unusual_* particle systems
// (attribute_controlled_attached_particles 701-704), driven by their
// extracted PCF definitions. Semantics follow the Source particle library
// (public/particles/particles.h attribute model, Alien Swarm SDK operator
// lineage): particles simulate in WORLD space while control points follow
// the weapon's attachments (PATTACH_POINT_FOLLOW in
// CEconEntity::UpdateSingleParticleSystem), which is what makes the effects
// lag and swirl when the weapon moves.
// ---------------------------------------------------------------------------

export interface UnusualEffect {
  object: THREE.Object3D;
  // Re-anchors control points from the weapon's current world transform
  // (centerGroup.matrixWorld); called by the Viewer every frame before
  // update(dt).
  updateAnchor(matrix: THREE.Matrix4): void;
  update(dt: number): void;
  dispose(): void;
}

const EFFECT_PCF_KEY: Record<string, string> = {
  hot: 'weapon_unusual_hot',
  isotope: 'weapon_unusual_isotope',
  cool: 'weapon_unusual_cool',
  energy_orb: 'weapon_unusual_energyorb',
};

interface UnusualFunctionEntry {
  functionName: string;
  params: Record<string, unknown>;
}

interface UnusualSystemDef {
  attributes: Record<string, unknown>;
  children: string[];
  initializers: UnusualFunctionEntry[];
  operators: UnusualFunctionEntry[];
  emitters: UnusualFunctionEntry[];
  renderers: UnusualFunctionEntry[];
}

interface UnusualDef {
  roots: string[];
  systems: Record<string, UnusualSystemDef>;
}

type UnusualsJson = Record<string, UnusualDef>;

interface ParticleIndexEntry {
  file: string;
  frames: number;
  width: number;
  height: number;
  additive: boolean;
  shader: string | null;
}

type ParticleIndex = Record<string, ParticleIndexEntry>;

// Per-weapon attachment control points, in GEOMETRY space (the same space as
// the glb vertex positions: raw, uncentered). v2 entries carry the attachment
// orientation ({pos, quat}); v1 entries are bare [x, y, z] positions and get
// the fixed Source-to-glb axis convention as their frame.
type AttachmentEntryJson = [number, number, number] | { pos: [number, number, number]; quat: [number, number, number, number] };
type AttachmentsJson = Record<string, Record<string, AttachmentEntryJson>>;

// Fetched once per session and shared across every effect instance/rebuild.
let unusualsJsonPromise: Promise<UnusualsJson> | null = null;
function loadUnusualsJson(): Promise<UnusualsJson> {
  if (!unusualsJsonPromise) {
    const base = import.meta.env.BASE_URL;
    unusualsJsonPromise = fetch(`${base}data/effects/unusuals.json`).then((r) => {
      if (!r.ok) throw new Error(`unusuals.json fetch failed: ${r.status}`);
      return r.json() as Promise<UnusualsJson>;
    });
  }
  return unusualsJsonPromise;
}

let attachmentsJsonPromise: Promise<AttachmentsJson> | null = null;
function loadAttachmentsJson(): Promise<AttachmentsJson> {
  if (!attachmentsJsonPromise) {
    const base = import.meta.env.BASE_URL;
    attachmentsJsonPromise = fetch(`${base}data/effects/attachments.json`).then((r) => {
      if (!r.ok) throw new Error(`attachments.json fetch failed: ${r.status}`);
      return r.json() as Promise<AttachmentsJson>;
    });
  }
  return attachmentsJsonPromise;
}

let particleIndexPromise: Promise<ParticleIndex> | null = null;
function loadParticleIndex(): Promise<ParticleIndex> {
  if (!particleIndexPromise) {
    const base = import.meta.env.BASE_URL;
    particleIndexPromise = fetch(`${base}data/effects/particles/index.json`).then((r) => {
      if (!r.ok) throw new Error(`particles index.json fetch failed: ${r.status}`);
      return r.json() as Promise<ParticleIndex>;
    });
  }
  return particleIndexPromise;
}

const particleTextureCache = new Map<string, Promise<THREE.Texture>>();
function loadParticleTexture(file: string): Promise<THREE.Texture> {
  let promise = particleTextureCache.get(file);
  if (!promise) {
    const base = import.meta.env.BASE_URL;
    promise = new THREE.TextureLoader().loadAsync(`${base}data/effects/particles/${file}`).then((t) => {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = THREE.ClampToEdgeWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      return t;
    });
    particleTextureCache.set(file, promise);
  }
  return promise;
}

let sharedDotTexture: THREE.Texture | null = null;
function dotTexture(): THREE.Texture {
  if (sharedDotTexture) return sharedDotTexture;
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.7)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  sharedDotTexture = new THREE.CanvasTexture(c);
  sharedDotTexture.colorSpace = THREE.SRGBColorSpace;
  return sharedDotTexture;
}

async function resolveParticleTexture(
  materialRef: unknown,
): Promise<{ texture: THREE.Texture; frames: number; additive: boolean }> {
  if (typeof materialRef === 'string') {
    try {
      const index = await loadParticleIndex();
      const entry = index[materialRef];
      if (entry) {
        const texture = await loadParticleTexture(entry.file);
        const additive = typeof entry.additive === 'boolean' ? entry.additive : true;
        return { texture, frames: Math.max(1, entry.frames), additive };
      }
    } catch {
      // fall through to the generated fallback dot
    }
  }
  return { texture: dotTexture(), frames: 1, additive: true };
}

// System selection: the game (items_game use_suffix_name) spawns the system
// named weapon_unusual_<effect>_<weapon> directly, not the authoring
// _unusual_parent_* container (which holds BOTH the world-model subtree and
// the _vm viewmodel subtree, and would render doubled if instantiated whole).
function selectSystemName(
  systems: Record<string, UnusualSystemDef>,
  effectId: string,
  weaponKey: string,
): string | null {
  const base = `weapon_unusual_${effectId === 'energy_orb' ? 'energyorb' : effectId}`;
  const weapon = weaponKey.replace(/^c_/, '');
  const worldName = `${base}_${weapon}`;
  if (systems[worldName]) return worldName;
  const vmName = `${worldName}_vm`;
  if (systems[vmName]) return vmName;
  const prefix = `${base}_`;
  const candidates = Object.keys(systems).filter((k) => k.startsWith(prefix));
  if (!candidates.length) return null;
  const nonVm = candidates.filter((k) => !k.endsWith('_vm'));
  const pool = (nonVm.length ? nonVm : candidates).slice().sort();
  const chosen = pool[0];
  console.warn(
    `[warpaint-viewer] no exact unusual system for "${effectId}"/"${weaponKey}" ` +
    `(tried "${worldName}", "${vmName}"); falling back to "${chosen}"`,
  );
  return chosen;
}

function normalizeParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) out[k.trim().toLowerCase().replace(/\s+/g, '_')] = v;
  return out;
}

function normName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function numOr(v: unknown, def: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

function boolOr(v: unknown, def: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return def;
}

function arrOr3(v: unknown, def: [number, number, number]): [number, number, number] {
  if (Array.isArray(v) && v.length >= 3 && v.every((n) => typeof n === 'number')) {
    return [v[0], v[1], v[2]];
  }
  return def;
}

function colorFromArray(v: unknown): THREE.Color | null {
  if (!Array.isArray(v) || v.length < 3) return null;
  return new THREE.Color().setRGB(v[0] / 255, v[1] / 255, v[2] / 255, THREE.SRGBColorSpace);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// RandomFloatExp equivalent: biases the blend factor by an exponent the way
// the SDK's random ranges do.
function lerpExp(a: number, b: number, exp: number): number {
  return lerp(a, b, Math.pow(Math.random(), Math.max(exp, 1e-6)));
}

function randInUnitBall(out: THREE.Vector3): THREE.Vector3 {
  do {
    out.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  } while (out.lengthSq() > 1 || out.lengthSq() < 1e-12);
  return out;
}

// Source WORLD-space vectors (gravity, non-local bias directions) are Z-up;
// the scene is Y-up, so (x, y, z) -> (x, z, y), matching the original gravity
// mapping in this file.
function swizzleSourceWorld(v: [number, number, number]): THREE.Vector3 {
  return new THREE.Vector3(v[0], v[2], v[1]);
}

// Fixed attachment frame used when attachments.json still carries bare [x,y,z]
// positions (format v1): Source attachment-local +X (forward) maps to glb +Z,
// +Y (left) to glb -X, +Z (up) to glb +Y. This is the same convention the old
// mapAttachmentLocal swizzle encoded, expressed as a rotation so all CP-local
// math can go through one quaternion path.
const DEFAULT_ATTACHMENT_QUAT = new THREE.Quaternion().setFromRotationMatrix(
  new THREE.Matrix4().set(
    0, -1, 0, 0,
    0, 0, 1, 0,
    1, 0, 0, 0,
    0, 0, 0, 1,
  ),
);

interface AttachmentAnchor {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
}

function parseAttachmentEntry(entry: AttachmentEntryJson | undefined): AttachmentAnchor | null {
  if (!entry) return null;
  if (Array.isArray(entry)) {
    return { pos: new THREE.Vector3(entry[0], entry[1], entry[2]), quat: DEFAULT_ATTACHMENT_QUAT.clone() };
  }
  const p = entry.pos;
  const q = entry.quat;
  if (!Array.isArray(p) || p.length < 3) return null;
  const quat = Array.isArray(q) && q.length >= 4
    ? new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize()
    : DEFAULT_ATTACHMENT_QUAT.clone();
  return { pos: new THREE.Vector3(p[0], p[1], p[2]), quat };
}

// ---------------------------------------------------------------------------
// Control points
//
// One shared table per effect (Source children inherit the parent's control
// points), CP 0..5 anchored to the unusual_0..unusual_5 attachments, plus
// dynamic per-system overrides written by "Set child control points from
// particle positions" and "Set Control Point Positions".
// ---------------------------------------------------------------------------

class ControlPoint {
  // Geometry-space anchor; null for dynamic CPs driven by operators.
  anchor: AttachmentAnchor | null;
  worldPos = new THREE.Vector3();
  worldQuat = new THREE.Quaternion();
  prevPos = new THREE.Vector3();
  prevQuat = new THREE.Quaternion();
  deltaPos = new THREE.Vector3();
  deltaQuat = new THREE.Quaternion();
  vel = new THREE.Vector3();
  private initialized = false;

  constructor(anchor: AttachmentAnchor | null) {
    this.anchor = anchor;
    if (anchor) {
      this.worldPos.copy(anchor.pos);
      this.worldQuat.copy(anchor.quat);
    }
  }

  setFromAnchorMatrix(matrix: THREE.Matrix4, matrixQuat: THREE.Quaternion) {
    if (!this.anchor) return;
    this.worldPos.copy(this.anchor.pos).applyMatrix4(matrix);
    this.worldQuat.copy(matrixQuat).multiply(this.anchor.quat);
  }

  // Called once per frame before any system ticks: derives the frame-to-frame
  // motion that PATTACH_POINT_FOLLOW gives the game's control points.
  beginFrame(dt: number) {
    if (!this.initialized) {
      this.prevPos.copy(this.worldPos);
      this.prevQuat.copy(this.worldQuat);
      this.initialized = true;
    }
    this.deltaPos.subVectors(this.worldPos, this.prevPos);
    this.deltaQuat.copy(this.prevQuat).invert().premultiply(this.worldQuat);
    this.vel.copy(this.deltaPos).divideScalar(Math.max(dt, 1e-5));
  }

  endFrame() {
    this.prevPos.copy(this.worldPos);
    this.prevQuat.copy(this.worldQuat);
  }

  // Dynamic CPs are created mid-frame (after beginFrame already ran for the
  // registered set); prime the prev-frame state so the first Movement Lock
  // pass sees zero motion instead of a garbage delta from the origin.
  prime() {
    this.prevPos.copy(this.worldPos);
    this.prevQuat.copy(this.worldQuat);
    this.deltaPos.set(0, 0, 0);
    this.deltaQuat.identity();
    this.vel.set(0, 0, 0);
    this.initialized = true;
  }
}

// ---------------------------------------------------------------------------
// Parsed system configuration
// ---------------------------------------------------------------------------

interface SphereInit {
  cp: number;
  distMin: number;
  distMax: number;
  bias: [number, number, number];
  biasAbs: [number, number, number];
  localBias: boolean;
  speedMin: number;
  speedMax: number;
  speedExp: number;
  localSpeedMin: [number, number, number] | null;
  localSpeedMax: [number, number, number] | null;
}

interface ParsedInit {
  kind: 'sphere' | 'offset' | 'lifetime' | 'alpha' | 'radius' | 'colorRandom' | 'rotationRandom'
      | 'yawFlip' | 'remapScalar' | 'velocityNoise' | 'velocityInherit' | 'velocityRandom';
  sphere?: SphereInit;
  offset?: { cp: number; min: [number, number, number]; max: [number, number, number]; local: boolean };
  range?: { min: number; max: number; exp: number };
  colors?: { c1: THREE.Color; c2: THREE.Color };
  rotation?: { initial: number; offMin: number; offMax: number; exp: number };
  flipPercent?: number;
  remap?: { inMin: number; inMax: number; outMin: number; outMax: number; scalar: boolean };
  noise?: { min: [number, number, number]; max: [number, number, number]; local: boolean; cp: number };
  inherit?: { cp: number; scale: number };
}

interface ParsedOp {
  kind: 'movement' | 'lifespanDecay' | 'fadeAndKill' | 'fadeIn' | 'fadeOut' | 'radiusScale'
      | 'colorFade' | 'spin' | 'lock' | 'rotAxis' | 'oscillate' | 'maintainPath'
      | 'setChildCps' | 'setCpPositions';
  movement?: { gravity: THREE.Vector3; drag: number };
  fadeAndKill?: { startFadeIn: number; endFadeIn: number; startFadeOut: number; endFadeOut: number; startAlpha: number; endAlpha: number };
  fade?: { min: number; max: number; proportional: boolean; ease: boolean };
  radiusScale?: { start: number; end: number; startTime: number; endTime: number; bias: number; ease: boolean };
  colorFade?: { color: THREE.Color; start: number; end: number; ease: boolean };
  spin?: { rate: number; stopTime: number; rateMin: number };
  lock?: { cp: number; startMin: number; startMax: number; endMin: number; endMax: number; lockRot: boolean };
  rotAxis?: { axis: [number, number, number]; rate: number; cp: number; local: boolean };
  oscillate?: { field: number; rateMin: [number, number, number]; rateMax: [number, number, number]; freqMin: [number, number, number]; freqMax: [number, number, number]; multiplier: number; startPhase: number };
  maintainPath?: { startCp: number; endCp: number; count: number; cohesion: number };
  setChildCps?: { firstCp: number; count: number; firstParticle: number };
  setCpPositions?: { entries: Array<{ cp: number; location: [number, number, number] }>; worldSpace: boolean; offsetFromCp: number };
}

interface EmitterConfig {
  mode: 'continuous' | 'instant';
  rate: number;
  duration: number;
  startTime: number;
  count: number;
}

const warnedOnce = new Set<string>();
function warnOnce(key: string, msg: string) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(`[warpaint-viewer] ${msg}`);
}

function parseInitializers(list: UnusualFunctionEntry[]): ParsedInit[] {
  const out: ParsedInit[] = [];
  for (const entry of list) {
    const p = normalizeParams(entry.params);
    switch (normName(entry.functionName)) {
      case 'positionwithinsphererandom':
        out.push({
          kind: 'sphere',
          sphere: {
            cp: numOr(p.control_point_number, 0),
            distMin: numOr(p.distance_min, 0),
            distMax: numOr(p.distance_max, numOr(p.distance_min, 0)),
            bias: arrOr3(p.distance_bias, [1, 1, 1]),
            biasAbs: arrOr3(p.distance_bias_absolute_value, [0, 0, 0]),
            localBias: boolOr(p.bias_in_local_system, false),
            speedMin: numOr(p.speed_min, 0),
            speedMax: numOr(p.speed_max, numOr(p.speed_min, 0)),
            speedExp: numOr(p.speed_random_exponent, 1),
            localSpeedMin: Array.isArray(p.speed_in_local_coordinate_system_min)
              ? arrOr3(p.speed_in_local_coordinate_system_min, [0, 0, 0]) : null,
            localSpeedMax: Array.isArray(p.speed_in_local_coordinate_system_max)
              ? arrOr3(p.speed_in_local_coordinate_system_max, [0, 0, 0]) : null,
          },
        });
        break;
      case 'positionmodifyoffsetrandom':
        out.push({
          kind: 'offset',
          offset: {
            cp: numOr(p.control_point_number, 0),
            min: arrOr3(p.offset_min, [0, 0, 0]),
            max: arrOr3(p.offset_max, [0, 0, 0]),
            local: boolOr(p['offset_in_local_space_0/1'], false),
          },
        });
        break;
      case 'lifetimerandom':
        out.push({ kind: 'lifetime', range: { min: numOr(p.lifetime_min, 1), max: numOr(p.lifetime_max, numOr(p.lifetime_min, 1)), exp: numOr(p.lifetime_random_exponent, 1) } });
        break;
      case 'alpharandom':
        out.push({ kind: 'alpha', range: { min: numOr(p.alpha_min, 255), max: numOr(p.alpha_max, 255), exp: numOr(p.alpha_random_exponent, 1) } });
        break;
      case 'radiusrandom':
        out.push({ kind: 'radius', range: { min: numOr(p.radius_min, 1), max: numOr(p.radius_max, numOr(p.radius_min, 1)), exp: numOr(p.radius_random_exponent, 1) } });
        break;
      case 'colorrandom': {
        const c1 = colorFromArray(p.color1);
        const c2 = colorFromArray(p.color2);
        if (c1 && c2) out.push({ kind: 'colorRandom', colors: { c1, c2 } });
        break;
      }
      case 'rotationrandom':
        out.push({ kind: 'rotationRandom', rotation: { initial: numOr(p.rotation_initial, 0), offMin: numOr(p.rotation_offset_min, 0), offMax: numOr(p.rotation_offset_max, 0), exp: numOr(p.rotation_random_exponent, 1) } });
        break;
      case 'rotationyawrandom':
        // YAW (attribute 12) only affects oriented sprite renderers; the
        // screen-aligned Points path ignores it like frame 0 of
        // render_animated_sprites with orientation 0 would.
        break;
      case 'rotationyawfliprandom':
        // Yaw flip mirrors the sprite; approximate with a 180 degree roll.
        out.push({ kind: 'yawFlip', flipPercent: numOr(p.flip_percentage, 0.5) });
        break;
      case 'sequencerandom':
        // None of the extracted VTFs carry sheet resources (verified against
        // the VTF resource dictionaries), so sequences have nothing to select.
        break;
      case 'remapinitialscalar': {
        const inField = numOr(p.input_field, -1);
        const outField = numOr(p.output_field, -1);
        // The only combination in these files: CREATION_TIME (8) remapped
        // onto ROTATION (4), in degrees (particles.h attribute ids).
        if (inField === 8 && outField === 4) {
          out.push({
            kind: 'remapScalar',
            remap: {
              inMin: numOr(p.input_minimum, 0),
              inMax: numOr(p.input_maximum, 1),
              outMin: numOr(p.output_minimum, 0),
              outMax: numOr(p.output_maximum, 0),
              scalar: boolOr(p.output_is_scalar_of_initial_random_range, false),
            },
          });
        } else {
          warnOnce(`remap-${inField}-${outField}`, `remap initial scalar with unhandled fields ${inField} -> ${outField}`);
        }
        break;
      }
      case 'velocitynoise':
        // The SDK samples curl noise; a per-particle random draw inside the
        // same output box keeps the population statistics without the noise
        // field itself.
        out.push({
          kind: 'velocityNoise',
          noise: {
            min: arrOr3(p.output_minimum, [0, 0, 0]),
            max: arrOr3(p.output_maximum, [0, 0, 0]),
            local: boolOr(p['apply_velocity_in_local_space_(0/1)'], false),
            cp: numOr(p.control_point_number, 0),
          },
        });
        break;
      case 'velocityinheritfromcontrolpoint':
        out.push({ kind: 'velocityInherit', inherit: { cp: numOr(p.control_point_number, 0), scale: numOr(p.velocity_scale, 1) } });
        break;
      case 'velocityrandom':
        out.push({
          kind: 'velocityRandom',
          sphere: {
            cp: numOr(p.control_point_number, 0),
            distMin: 0, distMax: 0, bias: [1, 1, 1], biasAbs: [0, 0, 0], localBias: false,
            speedMin: numOr(p.random_speed_min, 0),
            speedMax: numOr(p.random_speed_max, numOr(p.random_speed_min, 0)),
            speedExp: 1,
            localSpeedMin: Array.isArray(p.speed_in_local_coordinate_system_min)
              ? arrOr3(p.speed_in_local_coordinate_system_min, [0, 0, 0]) : null,
            localSpeedMax: Array.isArray(p.speed_in_local_coordinate_system_max)
              ? arrOr3(p.speed_in_local_coordinate_system_max, [0, 0, 0]) : null,
          },
        });
        break;
      default:
        break;
    }
  }
  return out;
}

function parseOperators(list: UnusualFunctionEntry[]): ParsedOp[] {
  const out: ParsedOp[] = [];
  for (const entry of list) {
    const p = normalizeParams(entry.params);
    switch (normName(entry.functionName)) {
      case 'movementbasic': {
        const g = arrOr3(p.gravity, [0, 0, 0]);
        out.push({ kind: 'movement', movement: { gravity: swizzleSourceWorld(g), drag: numOr(p.drag, 0) } });
        break;
      }
      case 'lifespandecay':
        out.push({ kind: 'lifespanDecay' });
        break;
      case 'alphafadeanddecay':
      case 'fadeandkill':
        // C_OP_FadeAndKill: absolute-seconds fade windows over particle age;
        // the particle is removed at end_fade_out_time regardless of the
        // lifetime attribute (energy orb lives 3.0s off a 2.1s lifetime).
        out.push({
          kind: 'fadeAndKill',
          fadeAndKill: {
            startFadeIn: numOr(p.start_fade_in_time, 0),
            endFadeIn: numOr(p.end_fade_in_time, numOr(p.fade_in_time, 0)),
            startFadeOut: numOr(p.start_fade_out_time, Number.POSITIVE_INFINITY),
            endFadeOut: numOr(p.end_fade_out_time, Number.POSITIVE_INFINITY),
            startAlpha: numOr(p.start_alpha, 0),
            endAlpha: numOr(p.end_alpha, 0),
          },
        });
        break;
      case 'alphafadeinrandom':
        out.push({
          kind: 'fadeIn',
          fade: {
            min: numOr(p.fade_in_time_min, 0),
            max: numOr(p.fade_in_time_max, numOr(p.fade_in_time_min, 0)),
            proportional: boolOr(p['proportional_0/1'], true),
            ease: false,
          },
        });
        break;
      case 'alphafadeoutrandom':
        out.push({
          kind: 'fadeOut',
          fade: {
            min: numOr(p.fade_out_time_min, 0),
            max: numOr(p.fade_out_time_max, numOr(p.fade_out_time_min, 0)),
            proportional: boolOr(p['proportional_0/1'], true),
            ease: boolOr(p.ease_in_and_out, false),
          },
        });
        break;
      case 'radiusscale':
        out.push({
          kind: 'radiusScale',
          radiusScale: {
            start: numOr(p.radius_start_scale, 1),
            end: numOr(p.radius_end_scale, 1),
            startTime: numOr(p.start_time, 0),
            endTime: numOr(p.end_time, 1),
            bias: numOr(p.scale_bias, 0.5),
            ease: boolOr(p.ease_in_and_out, false),
          },
        });
        break;
      case 'colorfade': {
        const c = colorFromArray(p.color_fade);
        if (c) {
          out.push({
            kind: 'colorFade',
            colorFade: { color: c, start: numOr(p.fade_start_time, 0), end: numOr(p.fade_end_time, 1), ease: boolOr(p.ease_in_and_out, false) },
          });
        }
        break;
      }
      case 'rotationspinroll':
        out.push({ kind: 'spin', spin: { rate: numOr(p.spin_rate_degrees, 0), stopTime: numOr(p.spin_stop_time, 0), rateMin: numOr(p.spin_rate_min, 0) } });
        break;
      case 'movementlocktocontrolpoint':
        out.push({
          kind: 'lock',
          lock: {
            cp: numOr(p.control_point_number, 0),
            startMin: numOr(p.start_fadeout_min, 1),
            startMax: numOr(p.start_fadeout_max, numOr(p.start_fadeout_min, 1)),
            endMin: numOr(p.end_fadeout_min, 1),
            endMax: numOr(p.end_fadeout_max, numOr(p.end_fadeout_min, 1)),
            lockRot: boolOr(p.lock_rotation, false),
          },
        });
        break;
      case 'movementrotateparticlearoundaxis':
        out.push({
          kind: 'rotAxis',
          rotAxis: {
            axis: arrOr3(p.rotation_axis, [0, 0, 1]),
            rate: numOr(p.rotation_rate, 0),
            cp: numOr(p.control_point, 0),
            local: boolOr(p.use_local_space, false),
          },
        });
        break;
      case 'oscillatevector':
        out.push({
          kind: 'oscillate',
          oscillate: {
            field: numOr(p.oscillation_field, 0),
            rateMin: arrOr3(p.oscillation_rate_min, [0, 0, 0]),
            rateMax: arrOr3(p.oscillation_rate_max, [0, 0, 0]),
            freqMin: arrOr3(p.oscillation_frequency_min, [1, 1, 1]),
            freqMax: arrOr3(p.oscillation_frequency_max, [1, 1, 1]),
            multiplier: numOr(p.oscillation_multiplier, 1),
            startPhase: numOr(p.oscillation_start_phase, 0),
          },
        });
        break;
      case 'movementmaintainpositionalongpath':
        out.push({
          kind: 'maintainPath',
          maintainPath: {
            startCp: numOr(p.start_control_point_number, 0),
            endCp: numOr(p.end_control_point_number, 0),
            count: Math.max(1, Math.round(numOr(p.particles_to_map_from_start_to_end, 1))),
            cohesion: numOr(p.cohesion_strength, 1),
          },
        });
        break;
      case 'setchildcontrolpointsfromparticlepositions':
        out.push({
          kind: 'setChildCps',
          setChildCps: {
            firstCp: numOr(p.first_control_point_to_set, 0),
            count: Math.max(1, Math.round(numOr(p['#_of_control_points_to_set'], 1))),
            firstParticle: Math.max(0, Math.round(numOr(p.first_particle_to_copy, 0))),
          },
        });
        break;
      case 'setcontrolpointpositions': {
        const entries: Array<{ cp: number; location: [number, number, number] }> = [];
        for (const ord of ['first', 'second', 'third', 'fourth']) {
          const cp = p[`${ord}_control_point_number`];
          const loc = p[`${ord}_control_point_location`];
          if (typeof cp === 'number' && Array.isArray(loc)) {
            entries.push({ cp, location: arrOr3(loc, [0, 0, 0]) });
          }
        }
        out.push({
          kind: 'setCpPositions',
          setCpPositions: {
            entries,
            worldSpace: boolOr(p.set_positions_in_world_space, false),
            offsetFromCp: numOr(p.control_point_to_offset_positions_from, 0),
          },
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function parseEmitters(list: UnusualFunctionEntry[]): EmitterConfig[] {
  const out: EmitterConfig[] = [];
  for (const entry of list) {
    const p = normalizeParams(entry.params);
    const name = normName(entry.functionName);
    if (name === 'emitcontinuously') {
      out.push({
        mode: 'continuous',
        rate: Math.max(0, numOr(p.emission_rate, 0)),
        duration: numOr(p.emission_duration, 0),
        startTime: numOr(p.emission_start_time, 0),
        count: 0,
      });
    } else if (name === 'emitinstantaneously') {
      out.push({
        mode: 'instant',
        rate: 0,
        duration: 0,
        startTime: numOr(p.emission_start_time, 0),
        count: Math.max(0, Math.round(numOr(p.num_to_emit, 0))),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

// Shared by every particle system's ShaderMaterial: refreshed by the Viewer
// on resize so gl_PointSize approximates screen-space size the way three's
// own PointsMaterial sizeAttenuation does (size * (height*0.5) / -mvPosition.z).
const sheenPointScale = { value: 600 };
export function setParticlePointScale(pixelHeight: number) {
  sheenPointScale.value = Math.max(1, pixelHeight) * 0.5;
}

const PARTICLE_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute float aFrame;
attribute float aRotation;
uniform float uPointScale;
varying float vAlpha;
varying vec3 vColor;
varying float vFrame;
varying float vRotation;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vFrame = aFrame;
  vRotation = aRotation;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_PointSize = aSize * ( uPointScale / -mvPosition.z );
  gl_Position = projectionMatrix * mvPosition;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uFrames;
varying float vAlpha;
varying vec3 vColor;
varying float vFrame;
varying float vRotation;
void main() {
  // Sprite roll (PARTICLE_ATTRIBUTE_ROTATION): rotate the point sprite's UV
  // around its center; texels that rotate outside the quad are dropped.
  vec2 pc = gl_PointCoord - 0.5;
  float cr = cos( vRotation );
  float sr = sin( vRotation );
  pc = vec2( cr * pc.x - sr * pc.y, sr * pc.x + cr * pc.y ) + 0.5;
  if ( pc.x < 0.0 || pc.x > 1.0 || pc.y < 0.0 || pc.y > 1.0 ) discard;
  float raw = 1.0 - pc.y;
  // Animated sprites (multi-frame VTF strips): each particle plays its own
  // frame, matching render_animated_sprites rather than freezing on frame 0.
  float frame = clamp( floor( vFrame + 0.5 ), 0.0, uFrames - 1.0 );
  vec2 uv = vec2( pc.x, ( raw + ( uFrames - 1.0 - frame ) ) / uFrames );
  vec4 tex = texture2D( uMap, uv );
  float a = tex.a * vAlpha;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( tex.rgb * vColor, a );
  #include <colorspace_fragment>
}
`;

// Source's $additive is SRC_ALPHA/ONE on color only; the game renders into an
// opaque scene so backbuffer alpha never matters there. Here the canvas is
// transparent over a CSS backplate, so the additive pass must leave the
// destination alpha untouched: otherwise a full-alpha additive texture (most
// of them decode to alpha=255 everywhere) occludes the backplate as a black
// square.
function applyAdditiveBlending(material: THREE.ShaderMaterial) {
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
}

const MAX_PARTICLES_CAP = 512;
const DEG2RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

interface SimParticle {
  alive: boolean;
  age: number;
  lifetime: number;
  systemAgeAtSpawn: number;
  spawnIndex: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  baseRadius: number;
  alphaBase: number;
  rotationDeg: number;
  colorInit: THREE.Color;
  // Per-particle randomness frozen at spawn so the fade/lock windows do not
  // reshuffle every tick (the SDK derives these from the particle id).
  rndFadeIn: number;
  rndFadeOut: number;
  rndLockStart: number;
  rndLockEnd: number;
  rndPhase: number;
}

const tmpV1 = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpC1 = new THREE.Color();

function biasCurve(t: number, bias: number): number {
  if (bias <= 0 || bias >= 1 || bias === 0.5) return t;
  return t / ((1 / bias - 2) * (1 - t) + 1);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

class SystemInstance {
  readonly name: string;
  readonly children: SystemInstance[] = [];
  points: THREE.Points | null = null;
  // Dynamic CP overrides layered over the effect's shared anchored table
  // (written into this system by its PARENT's Set-child-control-points op,
  // or by its own Set Control Point Positions op).
  readonly cpOverrides = new Map<number, ControlPoint>();

  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private positions!: Float32Array;
  private sizes!: Float32Array;
  private alphas!: Float32Array;
  private colors!: Float32Array;
  private frames!: Float32Array;
  private rotations!: Float32Array;

  private inits: ParsedInit[];
  private ops: ParsedOp[];
  private emitters: EmitterConfig[];
  private hasKillOp: boolean;
  private particles: SimParticle[];
  private slotCount: number;

  private defaultRadius: number;
  private defaultColor: THREE.Color;
  private defaultAlpha: number;
  private safeRadius: number;

  private systemAge = 0;
  private spawnCounter = 0;
  private emitAccumulators: number[];
  private instantsFired: boolean[];
  private disposed = false;

  private getCp: (index: number, forSystem: SystemInstance) => ControlPoint;
  private createDynamicCp: (index: number) => ControlPoint;

  constructor(
    name: string,
    def: UnusualSystemDef,
    modelRadius: number,
    getCp: (index: number, forSystem: SystemInstance) => ControlPoint,
    createDynamicCp: (index: number) => ControlPoint,
  ) {
    this.name = name;
    this.getCp = getCp;
    this.createDynamicCp = createDynamicCp;
    this.inits = parseInitializers(def.initializers);
    this.ops = parseOperators(def.operators);
    this.emitters = parseEmitters(def.emitters);
    // Source particles only die through decay operators; systems without one
    // (cool's pos_control/postest controller chain, the swirls themselves)
    // hold their population forever once emitted.
    this.hasKillOp = this.ops.some((o) => o.kind === 'lifespanDecay' || o.kind === 'fadeAndKill');

    this.defaultRadius = numOr(def.attributes.radius, 5);
    this.defaultColor = colorFromArray(def.attributes.color) ?? new THREE.Color(1, 1, 1);
    this.defaultAlpha = Array.isArray(def.attributes.color) ? numOr(def.attributes.color[3], 255) / 255 : 1;
    this.safeRadius = Math.max(1, modelRadius) * 2.5;

    const wantsParticles = def.renderers.length > 0 || this.emitters.length > 0 || this.inits.length > 0;
    this.slotCount = wantsParticles
      ? Math.min(Math.max(1, Math.round(numOr(def.attributes.max_particles, 32))), MAX_PARTICLES_CAP)
      : 0;
    this.emitAccumulators = this.emitters.map(() => 0);
    this.instantsFired = this.emitters.map(() => false);

    this.particles = Array.from({ length: this.slotCount }, () => ({
      alive: false,
      age: 0,
      lifetime: 0,
      systemAgeAtSpawn: 0,
      spawnIndex: 0,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      baseRadius: this.defaultRadius,
      alphaBase: this.defaultAlpha,
      rotationDeg: 0,
      colorInit: this.defaultColor.clone(),
      rndFadeIn: 0,
      rndFadeOut: 0,
      rndLockStart: 0,
      rndLockEnd: 0,
      rndPhase: 0,
    }));

    if (def.renderers.length > 0 && this.slotCount > 0) {
      const n = this.slotCount;
      this.positions = new Float32Array(n * 3);
      this.sizes = new Float32Array(n);
      this.alphas = new Float32Array(n);
      this.colors = new Float32Array(n * 3);
      this.frames = new Float32Array(n);
      this.rotations = new Float32Array(n);
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
      this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
      this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
      this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
      this.geometry.setAttribute('aFrame', new THREE.BufferAttribute(this.frames, 1));
      this.geometry.setAttribute('aRotation', new THREE.BufferAttribute(this.rotations, 1));

      this.material = new THREE.ShaderMaterial({
        uniforms: {
          uMap: { value: dotTexture() },
          uFrames: { value: 1 },
          uPointScale: sheenPointScale,
        },
        vertexShader: PARTICLE_VERTEX,
        fragmentShader: PARTICLE_FRAGMENT,
        transparent: true,
        depthWrite: false,
        depthTest: true,
      });
      applyAdditiveBlending(this.material);

      this.points = new THREE.Points(this.geometry, this.material);
      this.points.name = name;
      this.points.frustumCulled = false;
      this.points.renderOrder = 2;

      void resolveParticleTexture(def.attributes.material).then(({ texture, frames, additive }) => {
        if (this.disposed || !this.material) return;
        this.material.uniforms.uMap.value = texture;
        this.material.uniforms.uFrames.value = frames;
        if (additive) applyAdditiveBlending(this.material);
        else this.material.blending = THREE.NormalBlending;
        this.material.needsUpdate = true;
      });
    }
  }

  private findDeadSlot(): number {
    for (let i = 0; i < this.particles.length; i++) if (!this.particles[i].alive) return i;
    return -1;
  }

  private spawnParticle(p: SimParticle) {
    p.alive = true;
    p.age = 0;
    p.lifetime = 1;
    p.systemAgeAtSpawn = this.systemAge;
    p.spawnIndex = this.spawnCounter++;
    p.pos.set(0, 0, 0);
    p.vel.set(0, 0, 0);
    p.baseRadius = this.defaultRadius;
    p.alphaBase = this.defaultAlpha;
    p.rotationDeg = 0;
    p.colorInit.copy(this.defaultColor);
    p.rndFadeIn = Math.random();
    p.rndFadeOut = Math.random();
    p.rndLockStart = Math.random();
    p.rndLockEnd = Math.random();
    p.rndPhase = Math.random();

    let anchorCp: ControlPoint | null = null;

    for (const init of this.inits) {
      switch (init.kind) {
        case 'sphere': {
          // C_INIT_CreateWithinSphere. Expected frame for the energy orb
          // (weapon_unusual_energyorb_*): CP1 anchors at unusual_1 near the
          // muzzle; distance_bias (1,0,1) with "bias in local system" zeroes
          // the attachment-local Y (Source "left"), so both the spawn offset
          // direction and the 111 u/s launch velocity live in the plane
          // spanned by the barrel axis and up. With Movement Basic's 0.3
          // drag the particle darts roughly a dozen units along the barrel
          // and stalls, which is the in-game front-to-back streaming look.
          const s = init.sphere!;
          const cp = this.getCp(s.cp, this);
          anchorCp = cp;
          const d = randInUnitBall(tmpV1);
          if (s.biasAbs[0] !== 0) d.x = Math.abs(d.x);
          if (s.biasAbs[1] !== 0) d.y = Math.abs(d.y);
          if (s.biasAbs[2] !== 0) d.z = Math.abs(d.z);
          d.set(d.x * s.bias[0], d.y * s.bias[1], d.z * s.bias[2]);
          if (d.lengthSq() < 1e-12) d.set(1, 0, 0);
          d.normalize();
          const dWorld = s.localBias
            ? tmpV2.copy(d).applyQuaternion(cp.worldQuat)
            : tmpV2.set(d.x, d.z, d.y); // Source world Z-up -> scene Y-up
          const dist = lerpExp(s.distMin, s.distMax, 1);
          p.pos.copy(cp.worldPos).addScaledVector(dWorld, dist);
          p.vel.addScaledVector(dWorld, lerpExp(s.speedMin, s.speedMax, s.speedExp));
          if (s.localSpeedMin && s.localSpeedMax) {
            tmpV3.set(
              lerp(s.localSpeedMin[0], s.localSpeedMax[0], Math.random()),
              lerp(s.localSpeedMin[1], s.localSpeedMax[1], Math.random()),
              lerp(s.localSpeedMin[2], s.localSpeedMax[2], Math.random()),
            ).applyQuaternion(cp.worldQuat);
            p.vel.add(tmpV3);
          }
          break;
        }
        case 'velocityRandom': {
          const s = init.sphere!;
          const cp = this.getCp(s.cp, this);
          const d = randInUnitBall(tmpV1).normalize();
          p.vel.addScaledVector(tmpV2.set(d.x, d.z, d.y), lerpExp(s.speedMin, s.speedMax, s.speedExp));
          if (s.localSpeedMin && s.localSpeedMax) {
            tmpV3.set(
              lerp(s.localSpeedMin[0], s.localSpeedMax[0], Math.random()),
              lerp(s.localSpeedMin[1], s.localSpeedMax[1], Math.random()),
              lerp(s.localSpeedMin[2], s.localSpeedMax[2], Math.random()),
            ).applyQuaternion(cp.worldQuat);
            p.vel.add(tmpV3);
          }
          break;
        }
        case 'offset': {
          const o = init.offset!;
          const cp = this.getCp(o.cp, this);
          tmpV1.set(
            lerp(o.min[0], o.max[0], Math.random()),
            lerp(o.min[1], o.max[1], Math.random()),
            lerp(o.min[2], o.max[2], Math.random()),
          );
          if (o.local) tmpV1.applyQuaternion(cp.worldQuat);
          else tmpV1.set(tmpV1.x, tmpV1.z, tmpV1.y);
          p.pos.add(tmpV1);
          break;
        }
        case 'lifetime':
          p.lifetime = Math.max(0.001, lerpExp(init.range!.min, init.range!.max, init.range!.exp));
          break;
        case 'alpha':
          p.alphaBase = lerpExp(init.range!.min, init.range!.max, init.range!.exp) / 255;
          break;
        case 'radius':
          p.baseRadius = lerpExp(init.range!.min, init.range!.max, init.range!.exp);
          break;
        case 'colorRandom':
          p.colorInit.copy(init.colors!.c1).lerp(init.colors!.c2, Math.random());
          break;
        case 'rotationRandom':
          p.rotationDeg = init.rotation!.initial + lerpExp(init.rotation!.offMin, init.rotation!.offMax, init.rotation!.exp);
          break;
        case 'yawFlip':
          if (Math.random() < (init.flipPercent ?? 0.5)) p.rotationDeg += 180;
          break;
        case 'remapScalar': {
          const r = init.remap!;
          const span = Math.max(1e-6, r.inMax - r.inMin);
          const t = THREE.MathUtils.clamp((p.systemAgeAtSpawn - r.inMin) / span, 0, 1);
          const v = lerp(r.outMin, r.outMax, t);
          if (r.scalar) p.rotationDeg *= v;
          else p.rotationDeg += v;
          break;
        }
        case 'velocityNoise': {
          const n = init.noise!;
          const cp = this.getCp(n.cp, this);
          tmpV1.set(
            lerp(n.min[0], n.max[0], Math.random()),
            lerp(n.min[1], n.max[1], Math.random()),
            lerp(n.min[2], n.max[2], Math.random()),
          );
          if (n.local) tmpV1.applyQuaternion(cp.worldQuat);
          else tmpV1.set(tmpV1.x, tmpV1.z, tmpV1.y);
          p.vel.add(tmpV1);
          break;
        }
        case 'velocityInherit': {
          const inh = init.inherit!;
          p.vel.addScaledVector(this.getCp(inh.cp, this).vel, inh.scale);
          break;
        }
      }
    }

    // Position initializers are all CP-relative; systems with no position
    // initializer at all (bare emitters) start at CP0.
    if (!anchorCp && p.pos.lengthSq() === 0) {
      const cp0 = this.getCp(0, this);
      p.pos.add(cp0.worldPos);
      anchorCp = cp0;
    }

    // Sanity clamp relative to the spawning control point, never the absolute
    // position (the control point itself may sit far from the model origin).
    if (anchorCp) {
      tmpV1.subVectors(p.pos, anchorCp.worldPos);
      if (tmpV1.length() > this.safeRadius) {
        tmpV1.setLength(this.safeRadius);
        p.pos.copy(anchorCp.worldPos).add(tmpV1);
      }
    }
  }

  update(dt: number) {
    if (this.disposed) return;
    this.systemAge += dt;

    for (let e = 0; e < this.emitters.length; e++) {
      const em = this.emitters[e];
      if (this.systemAge < em.startTime) continue;
      if (em.mode === 'instant') {
        if (!this.instantsFired[e]) {
          this.instantsFired[e] = true;
          for (let i = 0; i < em.count; i++) {
            const idx = this.findDeadSlot();
            if (idx < 0) break;
            this.spawnParticle(this.particles[idx]);
          }
        }
      } else {
        if (em.duration > 0 && this.systemAge > em.startTime + em.duration) continue;
        this.emitAccumulators[e] += em.rate * dt;
        while (this.emitAccumulators[e] >= 1) {
          this.emitAccumulators[e] -= 1;
          const idx = this.findDeadSlot();
          if (idx < 0) { this.emitAccumulators[e] %= 1; break; }
          this.spawnParticle(this.particles[idx]);
        }
      }
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.alive) {
        if (this.points) this.writeVertex(i, p, 0, 0, tmpC1.set(0, 0, 0), 0);
        continue;
      }
      p.age += dt;

      // Kill authority: Lifespan Decay at the lifetime attribute, Alpha Fade
      // and Decay at its end_fade_out_time; no decay op means immortal.
      let dead = false;
      if (this.hasKillOp) {
        for (const op of this.ops) {
          if (op.kind === 'lifespanDecay' && p.age >= p.lifetime) dead = true;
          else if (op.kind === 'fadeAndKill' && p.age >= op.fadeAndKill!.endFadeOut) dead = true;
        }
      }
      if (dead) {
        p.alive = false;
        if (this.points) this.writeVertex(i, p, 0, 0, tmpC1.set(0, 0, 0), 0);
        continue;
      }

      const lifeFrac = THREE.MathUtils.clamp(p.age / p.lifetime, 0, 1);
      let alphaScale = 1;
      let radiusMult = 1;
      const frameColor = tmpC1.copy(p.colorInit);

      for (const op of this.ops) {
        switch (op.kind) {
          case 'movement': {
            const m = op.movement!;
            p.vel.addScaledVector(m.gravity, dt);
            // Source's Movement Basic drag is a per-simulation-tick damping
            // factor at a 30 Hz reference (vel *= 1 - drag each tick), not a
            // per-second coefficient.
            p.vel.multiplyScalar(Math.pow(Math.max(0, 1 - m.drag), dt * 30));
            p.pos.addScaledVector(p.vel, dt);
            break;
          }
          case 'fadeAndKill': {
            const f = op.fadeAndKill!;
            if (p.age < f.startFadeIn) alphaScale *= f.startAlpha;
            else if (p.age < f.endFadeIn) {
              const t = (p.age - f.startFadeIn) / Math.max(1e-6, f.endFadeIn - f.startFadeIn);
              alphaScale *= lerp(f.startAlpha, 1, t);
            } else if (p.age > f.startFadeOut) {
              const t = THREE.MathUtils.clamp((p.age - f.startFadeOut) / Math.max(1e-6, f.endFadeOut - f.startFadeOut), 0, 1);
              alphaScale *= lerp(1, f.endAlpha, t);
            }
            break;
          }
          case 'fadeIn': {
            const f = op.fade!;
            const t = lerp(f.min, f.max, p.rndFadeIn);
            const T = f.proportional ? t * p.lifetime : t;
            if (T > 0 && p.age < T) alphaScale *= THREE.MathUtils.clamp(p.age / T, 0, 1);
            break;
          }
          case 'fadeOut': {
            const f = op.fade!;
            const t = lerp(f.min, f.max, p.rndFadeOut);
            const T = f.proportional ? t * p.lifetime : t;
            if (T > 0) {
              const fadeStart = p.lifetime - T;
              if (p.age > fadeStart) {
                let k = THREE.MathUtils.clamp(1 - (p.age - fadeStart) / T, 0, 1);
                if (f.ease) k = smooth(k);
                alphaScale *= k;
              }
            }
            break;
          }
          case 'radiusScale': {
            const r = op.radiusScale!;
            const span = Math.max(1e-4, r.endTime - r.startTime);
            let t = THREE.MathUtils.clamp((lifeFrac - r.startTime) / span, 0, 1);
            t = biasCurve(t, r.bias);
            if (r.ease) t = smooth(t);
            radiusMult *= lerp(r.start, r.end, t);
            break;
          }
          case 'colorFade': {
            const c = op.colorFade!;
            const span = Math.max(1e-4, c.end - c.start);
            let t = THREE.MathUtils.clamp((lifeFrac - c.start) / span, 0, 1);
            if (c.ease) t = smooth(t);
            frameColor.lerp(c.color, t);
            break;
          }
          case 'spin': {
            const s = op.spin!;
            if (s.stopTime <= 0 || p.age < s.stopTime) p.rotationDeg += s.rate * dt;
            else p.rotationDeg += s.rateMin * dt;
            break;
          }
          case 'lock': {
            // C_OP_PositionLock: rigidly carries particles with the control
            // point's frame-to-frame motion, fading off between the start and
            // end windows (fractions of lifetime). This is what keeps the
            // effect glued to the weapon while it is dragged around.
            const l = op.lock!;
            const cp = this.getCp(l.cp, this);
            const start = lerp(l.startMin, l.startMax, p.rndLockStart) * p.lifetime;
            const end = lerp(l.endMin, l.endMax, p.rndLockEnd) * p.lifetime;
            let s = 1;
            if (end > start && p.age > start) {
              s = THREE.MathUtils.clamp(1 - (p.age - start) / Math.max(1e-6, end - start), 0, 1);
            }
            if (s > 0) {
              if (l.lockRot) {
                tmpV1.subVectors(p.pos, cp.prevPos).applyQuaternion(cp.deltaQuat).add(cp.worldPos);
                p.pos.lerp(tmpV1, s);
                if (s >= 1) p.vel.applyQuaternion(cp.deltaQuat);
              } else {
                p.pos.addScaledVector(cp.deltaPos, s);
              }
            }
            break;
          }
          case 'rotAxis': {
            const r = op.rotAxis!;
            const cp = this.getCp(r.cp, this);
            const axis = r.local
              ? tmpV1.set(r.axis[0], r.axis[1], r.axis[2]).applyQuaternion(cp.worldQuat)
              : tmpV1.set(r.axis[0], r.axis[2], r.axis[1]);
            axis.normalize();
            tmpV2.subVectors(p.pos, cp.worldPos).applyAxisAngle(axis, r.rate * DEG2RAD * dt);
            p.pos.copy(cp.worldPos).add(tmpV2);
            break;
          }
          case 'oscillate': {
            // Approximation of C_OP_OscillateVector: sinusoidal wobble on the
            // target field. Field 4 is ROTATION (the only scalar target in
            // these files); field 0 would be position.
            const o = op.oscillate!;
            const phase = (o.startPhase + p.rndPhase) * Math.PI * 2;
            if (o.field === 4) {
              const rate = lerp(o.rateMin[0], o.rateMax[0], p.rndPhase);
              const freq = lerp(o.freqMin[0], o.freqMax[0], p.rndPhase);
              p.rotationDeg += Math.sin(phase + p.age * freq * Math.PI * 2) * rate * o.multiplier * dt;
            } else if (o.field === 0) {
              for (let axis = 0; axis < 3; axis++) {
                const rate = lerp(o.rateMin[axis], o.rateMax[axis], p.rndPhase);
                const freq = lerp(o.freqMin[axis], o.freqMax[axis], p.rndPhase);
                const v = Math.sin(phase + p.age * freq * Math.PI * 2) * rate * o.multiplier * dt;
                if (axis === 0) p.pos.x += v;
                else if (axis === 1) p.pos.z += v; // Source Y -> scene Z
                else p.pos.y += v;
              }
            } else {
              warnOnce(`osc-${o.field}`, `Oscillate Vector field ${o.field} not represented`);
            }
            break;
          }
          case 'maintainPath': {
            // C_OP_MaintainSequentialPath: distributes the population along
            // the segment between two control points and advances it over
            // time so the stream FLOWS from start to end (cool's water swirl
            // rides this between the CPs its parent chain writes). The flow
            // period uses the particle lifetime as the traversal time, an
            // approximation of the SDK's sequential assignment counter.
            const m = op.maintainPath!;
            const a = this.getCp(m.startCp, this);
            const b = this.getCp(m.endCp, this);
            const base = (p.spawnIndex % m.count) / m.count;
            const flow = p.age / Math.max(0.5, p.lifetime);
            const tPath = (base + flow) % 1;
            tmpV1.copy(a.worldPos).lerp(b.worldPos, tPath);
            p.pos.lerp(tmpV1, THREE.MathUtils.clamp(m.cohesion, 0, 1));
            break;
          }
          default:
            break;
        }
      }

      if (this.points) {
        this.writeVertex(i, p, p.baseRadius * radiusMult, p.alphaBase * alphaScale, frameColor, p.rotationDeg * DEG2RAD);
      }
    }

    // Control-point-writing operators run against the post-tick particle
    // state, feeding the children that tick right after this system.
    for (const op of this.ops) {
      if (op.kind === 'setChildCps') {
        const s = op.setChildCps!;
        const alive = this.particles.filter((p) => p.alive).sort((a, b) => a.spawnIndex - b.spawnIndex);
        for (let k = 0; k < s.count; k++) {
          const src = alive[s.firstParticle + k];
          if (!src) break;
          for (const child of this.children) {
            let cp = child.cpOverrides.get(s.firstCp + k);
            if (!cp) {
              // Inherit the anchored CP's orientation (the SDK only writes
              // positions here unless "Set cp orientation" is on, so the
              // frame stays whatever the control point had before).
              cp = this.createDynamicCp(s.firstCp + k);
              cp.worldPos.copy(src.pos);
              cp.prime();
              child.cpOverrides.set(s.firstCp + k, cp);
            }
            cp.worldPos.copy(src.pos);
          }
        }
      } else if (op.kind === 'setCpPositions') {
        const s = op.setCpPositions!;
        const ref = this.getCp(s.offsetFromCp, this);
        for (const e of s.entries) {
          let cp = this.cpOverrides.get(e.cp);
          if (!cp) {
            cp = this.createDynamicCp(e.cp);
            this.cpOverrides.set(e.cp, cp);
          }
          tmpV1.set(e.location[0], e.location[1], e.location[2]);
          if (!s.worldSpace) tmpV1.applyQuaternion(ref.worldQuat);
          cp.worldPos.copy(ref.worldPos).add(tmpV1);
          cp.worldQuat.copy(ref.worldQuat);
        }
      }
    }

    if (this.geometry) {
      this.geometry.attributes.position.needsUpdate = true;
      (this.geometry.attributes.aSize as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.attributes.aAlpha as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.attributes.aColor as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.attributes.aFrame as THREE.BufferAttribute).needsUpdate = true;
      (this.geometry.attributes.aRotation as THREE.BufferAttribute).needsUpdate = true;
    }

    for (const child of this.children) child.update(dt);
  }

  private writeVertex(i: number, p: SimParticle, radius: number, alpha: number, color: THREE.Color, rotationRad: number) {
    if (!this.positions) return;
    this.positions[i * 3] = p.pos.x;
    this.positions[i * 3 + 1] = p.pos.y;
    this.positions[i * 3 + 2] = p.pos.z;
    this.sizes[i] = radius * 2;
    this.alphas[i] = alpha;
    this.colors[i * 3] = color.r;
    this.colors[i * 3 + 1] = color.g;
    this.colors[i * 3 + 2] = color.b;
    // One playthrough of the sprite animation per particle lifetime.
    const frameCount = this.material ? (this.material.uniforms.uFrames.value as number) : 1;
    this.frames[i] = p.lifetime > 0 ? Math.min(frameCount - 1, (p.age / p.lifetime) * frameCount) : 0;
    this.rotations[i] = rotationRad;
  }

  countAlive(): number {
    let n = 0;
    for (const p of this.particles) if (p.alive) n++;
    return n;
  }

  dispose() {
    this.disposed = true;
    this.geometry?.dispose();
    this.material?.dispose();
    for (const child of this.children) child.dispose();
    // Sprite textures are cached at module level and shared across effects;
    // they are intentionally not disposed here.
  }
}

// createUnusualEffect returns immediately (a Group that starts empty) and
// populates itself once the (module-cached) PCF JSON, attachment data, and
// any per-system sprite textures resolve. modelCenter is the model's
// bounding-box center in GEOMETRY space (raw, uncentered), used as a fallback
// control point for weapons/systems with no matching attachment entry. The
// returned Group must sit at the SCENE ROOT with an identity transform:
// particles simulate in world space, and updateAnchor() re-derives the
// control points from the weapon's current world matrix every frame.
export function createUnusualEffect(
  id: string,
  radius: number,
  weaponKey: string,
  modelCenter: THREE.Vector3,
): UnusualEffect | null {
  if (id === 'none') return null;
  const pcfKey = EFFECT_PCF_KEY[id];
  if (!pcfKey) return null;

  const group = new THREE.Group();
  let root: SystemInstance | null = null;
  let disposed = false;

  const fallbackAnchor: AttachmentAnchor = { pos: modelCenter.clone(), quat: DEFAULT_ATTACHMENT_QUAT.clone() };
  const anchoredCps = new Map<number, ControlPoint>();
  const dynamicCps: ControlPoint[] = [];
  const anchorMatrix = new THREE.Matrix4();
  const anchorQuat = new THREE.Quaternion();
  let anchorDirty = true;

  Promise.all([loadUnusualsJson(), loadAttachmentsJson()])
    .then(([json, attachments]) => {
      if (disposed) return;
      const def = json[pcfKey];
      if (!def) return;
      const systemName = selectSystemName(def.systems, id, weaponKey);
      if (!systemName) return;
      const weaponAttachments = attachments[weaponKey] ?? {};

      const anchoredCp = (index: number): ControlPoint => {
        let cp = anchoredCps.get(index);
        if (!cp) {
          const anchor = parseAttachmentEntry(weaponAttachments[`unusual_${index}`])
            ?? parseAttachmentEntry(weaponAttachments.unusual_0)
            ?? { pos: fallbackAnchor.pos.clone(), quat: fallbackAnchor.quat.clone() };
          cp = new ControlPoint(anchor);
          cp.setFromAnchorMatrix(anchorMatrix, anchorQuat);
          // Anchored CPs are created lazily on first use, which happens
          // mid-tick (after this frame's beginFrame pass): prime the
          // prev-frame state so same-tick Movement Lock sees zero motion.
          cp.prime();
          anchoredCps.set(index, cp);
        }
        return cp;
      };
      const getCp = (index: number, forSystem: SystemInstance): ControlPoint => {
        return forSystem.cpOverrides.get(index) ?? anchoredCp(index);
      };
      const createDynamicCp = (index: number): ControlPoint => {
        const src = anchoredCp(index);
        const cp = new ControlPoint(null);
        cp.worldPos.copy(src.worldPos);
        cp.worldQuat.copy(src.worldQuat);
        cp.prime();
        dynamicCps.push(cp);
        return cp;
      };

      const build = (name: string, visited: Set<string>): SystemInstance | null => {
        if (visited.has(name)) return null;
        visited.add(name);
        const sysDef = def.systems[name];
        if (!sysDef) return null;
        const instance = new SystemInstance(name, sysDef, radius, getCp, createDynamicCp);
        for (const childName of sysDef.children) {
          const child = build(childName, visited);
          if (child) instance.children.push(child);
        }
        return instance;
      };

      const built = build(systemName, new Set());
      if (!built || disposed) {
        built?.dispose();
        return;
      }
      root = built;
      const attach = (sys: SystemInstance) => {
        if (sys.points) group.add(sys.points);
        for (const child of sys.children) attach(child);
      };
      attach(root);
    })
    .catch((err) => {
      console.warn('[warpaint-viewer] unusual effect data failed to load:', err);
    });

  return {
    object: group,
    updateAnchor(matrix: THREE.Matrix4) {
      anchorMatrix.copy(matrix);
      anchorQuat.setFromRotationMatrix(matrix);
      anchorDirty = true;
    },
    update(dt: number) {
      if (disposed || !root) return;
      if (anchorDirty) {
        for (const cp of anchoredCps.values()) cp.setFromAnchorMatrix(anchorMatrix, anchorQuat);
        anchorDirty = false;
      }
      for (const cp of anchoredCps.values()) cp.beginFrame(dt);
      for (const cp of dynamicCps) cp.beginFrame(dt);
      root.update(dt);
      for (const cp of anchoredCps.values()) cp.endFrame();
      for (const cp of dynamicCps) cp.endFrame();
    },
    dispose() {
      disposed = true;
      root?.dispose();
      root = null;
    },
  };
}
