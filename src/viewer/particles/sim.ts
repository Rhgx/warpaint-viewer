import * as THREE from 'three';
import type { EmitterConfig, ParsedConstraint, ParsedInit, ParsedOp, UnusualSystemDef } from './parse';
import { parseConstraints, parseEmitters, parseInitializers, parseOperators } from './parse';
import type { AttachmentAnchor, ParticleIndex, ParticleSheet } from './util';
import { colorFromArray, dotTexture, numOr, resolveParticleTexture, warnOnce } from './util';

// ---------------------------------------------------------------------------
// Control points
//
// One shared table per effect (Source children inherit the parent's control
// points), CP 0..5 anchored to the unusual_0..unusual_5 attachments, plus
// dynamic per-system overrides written by "Set child control points from
// particle positions" and "Set Control Point Positions".
// ---------------------------------------------------------------------------

export class ControlPoint {
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
attribute vec4 aUvRect;
uniform float uPointScale;
varying float vAlpha;
varying vec3 vColor;
varying float vFrame;
varying float vRotation;
varying vec4 vUvRect;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vFrame = aFrame;
  vRotation = aRotation;
  vUvRect = aUvRect;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  // Projection-aware size: projectionMatrix[1][1] is cot(fovY/2) in
  // perspective, so this tracks FOV changes exactly like the weapon mesh
  // does, and falls out correctly in orthographic mode too (w = 1,
  // projectionMatrix[1][1] = 2/(top-bottom)) instead of dividing by depth.
  gl_PointSize = aSize * uPointScale * projectionMatrix[1][1] / gl_Position.w;
}
`;

const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uFrames;
varying float vAlpha;
varying vec3 vColor;
varying float vFrame;
varying float vRotation;
varying vec4 vUvRect;
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
  // Sheets and strips never co-occur in the extracted data (a sheet-bearing
  // material always has exactly one strip frame), so this reduces to plain
  // (pc.x, raw) whenever a sheet is in play and uFrames is 1.
  float frame = clamp( floor( vFrame + 0.5 ), 0.0, uFrames - 1.0 );
  vec2 uv = vec2( pc.x, ( raw + ( uFrames - 1.0 - frame ) ) / uFrames );
  // Sprite-sheet cell (PARTICLE_ATTRIBUTE_SEQUENCE_NUMBER): crop into the
  // chosen cell instead of sampling the whole contact sheet. vUvRect is
  // (0,0,1,1) for materials with no sheet, so this is a no-op identity map.
  uv = mix( vUvRect.xy, vUvRect.zw, uv );
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
  // Sprite-sheet UV rect [x0,y0,x1,y1] chosen at spawn by a Sequence Random
  // initializer, or the full-texture default when the particle's material
  // has no sheet (or no such initializer at all).
  uvRect: [number, number, number, number];
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

export class SystemInstance {
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
  private uvRects!: Float32Array;

  // Set once the material's particle index entry resolves; null until then
  // and for every material with no embedded sprite-sheet resource (only
  // particle/smoke1/smoke1_additive.vmt has one among the extracted VTFs).
  private sheet: ParticleSheet | null = null;

  private inits: ParsedInit[];
  private ops: ParsedOp[];
  private constraints: ParsedConstraint[];
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
    particleIndex: ParticleIndex,
  ) {
    this.name = name;
    this.getCp = getCp;
    this.createDynamicCp = createDynamicCp;
    this.inits = parseInitializers(def.initializers);
    this.ops = parseOperators(def.operators);
    this.constraints = parseConstraints(def.constraints ?? []);
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
      uvRect: [0, 0, 1, 1],
    }));

    // A material confirmed absent from the game itself (index.json's `missing: true` - see
    // extract-effects.mjs KNOWN_MISSING_MATERIALS) means Source draws nothing for this system:
    // simulation still runs (particles above, and any operators that write child control points
    // still see live particle state), only the render side is skipped. Checked synchronously here
    // (particleIndex is already resolved by the time build() runs) so the THREE.Points object is
    // simply never created, rather than created and torn down once an async texture fetch reports
    // it missing.
    const materialRef = def.attributes.material;
    const materialMissing = typeof materialRef === 'string' && particleIndex[materialRef]?.missing === true;

    if (def.renderers.length > 0 && this.slotCount > 0 && !materialMissing) {
      const n = this.slotCount;
      this.positions = new Float32Array(n * 3);
      this.sizes = new Float32Array(n);
      this.alphas = new Float32Array(n);
      this.colors = new Float32Array(n * 3);
      this.frames = new Float32Array(n);
      this.rotations = new Float32Array(n);
      this.uvRects = new Float32Array(n * 4);
      // Default every slot to the full-texture rect so particles on
      // materials without a sheet (or before one resolves) sample normally.
      for (let i = 0; i < n; i++) {
        this.uvRects[i * 4 + 2] = 1;
        this.uvRects[i * 4 + 3] = 1;
      }
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
      this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
      this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
      this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));
      this.geometry.setAttribute('aFrame', new THREE.BufferAttribute(this.frames, 1));
      this.geometry.setAttribute('aRotation', new THREE.BufferAttribute(this.rotations, 1));
      this.geometry.setAttribute('aUvRect', new THREE.BufferAttribute(this.uvRects, 4));

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

      void resolveParticleTexture(def.attributes.material).then(({ texture, frames, additive, sheet }) => {
        if (this.disposed || !this.material) return;
        this.material.uniforms.uMap.value = texture;
        this.material.uniforms.uFrames.value = frames;
        if (additive) applyAdditiveBlending(this.material);
        else this.material.blending = THREE.NormalBlending;
        this.material.needsUpdate = true;
        // Sheets and strip animation never co-occur in the extracted data
        // (frames > 1 only happens for VTFs with no sheet resource, e.g.
        // comball_d), so storing this on the system is unambiguous - a
        // particle's uvRect selection and its vFrame strip row never both
        // need to be non-default at once.
        this.sheet = sheet;
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
    p.uvRect[0] = 0; p.uvRect[1] = 0; p.uvRect[2] = 1; p.uvRect[3] = 1;

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
        case 'sequence': {
          // C_INIT_RandomSequence: pick a uniform random integer sequence
          // index in [sequence_min, sequence_max], then look it up modulo
          // however many sequences the sheet actually has (some defs ask
          // for indices beyond a given sheet's count, e.g. 0..4 against
          // smoke1's 16). Every known sheet has frameCount 1 per sequence,
          // so there is no intra-sheet animation to advance over the
          // particle's life - the rect is fixed for its whole lifetime.
          const sheet = this.sheet;
          if (sheet && sheet.sequences.length > 0) {
            const r = init.sequenceRange!;
            const lo = Math.round(Math.min(r.min, r.max));
            const hi = Math.round(Math.max(r.min, r.max));
            const idx = lo + Math.floor(Math.random() * (hi - lo + 1));
            const seq = sheet.sequences[((idx % sheet.sequences.length) + sheet.sequences.length) % sheet.sequences.length];
            const uv = seq.frames[0];
            if (uv) {
              // uv is [x0,y0,x1,y1] straight from the VTF sheet resource, which uses
              // Source's top-left-origin convention (y0 near the image's top row, y1
              // near its bottom). loadParticleTexture() uploads with three's default
              // flipY=true, so the GL v the fragment shader ends up sampling runs the
              // other way (v=1 -> image top, v=0 -> image bottom; see the point-sprite
              // "raw = 1.0 - pc.y" math in PARTICLE_FRAGMENT, calibrated for that same
              // flip). Flip y here so the stored rect matches that GL-v convention
              // instead of re-deriving it in the shader: x is untouched (flipY only
              // mirrors rows, not columns).
              p.uvRect[0] = uv[0]; p.uvRect[1] = 1 - uv[3]; p.uvRect[2] = uv[2]; p.uvRect[3] = 1 - uv[1];
            }
          }
          break;
        }
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

    // Apply the path constraint once at spawn (age is 0 here) so a freshly
    // spawned particle snaps straight onto the path instead of flashing at
    // its initializer-chosen spawn point for one frame.
    this.applyConstraints(p);
  }

  private applyConstraints(p: SimParticle) {
    for (const c of this.constraints) {
      if (c.kind === 'pathBetweenCps') this.applyPathConstraint(p, c.path!);
    }
  }

  // C_OP_ConstrainDistanceToPath: clamps the particle to lie within
  // [minDistance, maxDistance] of a point that travels along the quadratic
  // path start -> mid -> end as the particle ages, reaching the end at
  // travelTime. With min = max = 0 (every case in our extracted data) this
  // hard-snaps the particle onto the path, which is the entire motion model
  // for the energy orb and the isotope/cool barrel systems.
  private applyPathConstraint(p: SimParticle, c: NonNullable<ParsedConstraint['path']>) {
    const start = this.getCp(c.startCp, this);
    const end = this.getCp(c.endCp, this);
    const b = THREE.MathUtils.clamp(p.age / c.travelTime, 0, 1);

    // Bulge is always 0 in the extracted data, so mid is a plain lerp with no
    // perpendicular offset; structure still routes through midPointPosition.
    tmpV1.copy(start.worldPos).lerp(end.worldPos, c.midPointPosition); // mid
    tmpV2.copy(start.worldPos).lerp(tmpV1, b); // lerp(start, mid, b)
    tmpV3.copy(tmpV1).lerp(end.worldPos, b); // lerp(mid, end, b)
    tmpV2.lerp(tmpV3, b); // pathPoint (quadratic bezier at t = b)

    let maxDist = c.maxDistance;
    if (c.maxDistanceMiddle >= 0 || c.maxDistanceEnd >= 0) {
      const mid = c.maxDistanceMiddle >= 0 ? c.maxDistanceMiddle : c.maxDistance;
      const endD = c.maxDistanceEnd >= 0 ? c.maxDistanceEnd : c.maxDistance;
      maxDist = b <= 0.5 ? lerp(c.maxDistance, mid, b / 0.5) : lerp(mid, endD, (b - 0.5) / 0.5);
    }

    tmpV3.subVectors(p.pos, tmpV2); // d = pos - pathPoint
    const dist = tmpV3.length();
    if (dist > maxDist) {
      if (dist < 1e-8) p.pos.copy(tmpV2);
      else p.pos.copy(tmpV2).addScaledVector(tmpV3, maxDist / dist);
    } else if (dist < c.minDistance) {
      if (dist < 1e-8) {
        // No direction to push out along; fall back to the start->end
        // tangent so a fully degenerate d doesn't leave the particle stuck
        // exactly on the path point when minDistance is positive.
        tmpV3.subVectors(end.worldPos, start.worldPos);
        if (tmpV3.lengthSq() < 1e-12) tmpV3.set(1, 0, 0);
        tmpV3.normalize();
      } else {
        tmpV3.multiplyScalar(1 / dist);
      }
      p.pos.copy(tmpV2).addScaledVector(tmpV3, c.minDistance);
    }
  }

  // Rigidly carries every alive particle in this system (and its children)
  // through a teleport: pos through the full transform, vel through its
  // rotation only. Used when the weapon's anchor jumps in a single frame
  // (view-angle presets, reset) so particles don't get left behind in the
  // old world position for a tick.
  applyRigidTransform(deltaM: THREE.Matrix4, deltaQuat: THREE.Quaternion) {
    for (const p of this.particles) {
      if (!p.alive) continue;
      p.pos.applyMatrix4(deltaM);
      p.vel.applyQuaternion(deltaQuat);
    }
    for (const child of this.children) child.applyRigidTransform(deltaM, deltaQuat);
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

      // Kill authority: both Lifespan Decay and Alpha Fade and Decay
      // (C_OP_FadeAndKill) die at the same instant, age > lifetime; no decay
      // op means immortal.
      let dead = false;
      if (this.hasKillOp) {
        for (const op of this.ops) {
          if ((op.kind === 'lifespanDecay' || op.kind === 'fadeAndKill') && p.age >= p.lifetime) dead = true;
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
            // C_OP_FadeAndKill: fade windows are fractions of lifetime
            // (lifeFrac = age/lifetime), matching loadout.tf's o =
            // currentTime/timeToLive. Between endFadeIn and startFadeOut the
            // op leaves alpha untouched (holds at 1); if startFadeOut is
            // authored as a value the particle's lifeFrac never reaches
            // (energy orb: 2.5 against a lifeFrac that tops out at 1), the
            // fade-out branch below simply never runs.
            const f = op.fadeAndKill!;
            if (lifeFrac <= f.startFadeIn) {
              // untouched
            } else if (lifeFrac < f.endFadeIn) {
              const t = THREE.MathUtils.clamp((lifeFrac - f.startFadeIn) / Math.max(1e-6, f.endFadeIn - f.startFadeIn), 0, 1);
              alphaScale *= lerp(f.startAlphaFactor, 1, smooth(t));
            } else if (lifeFrac < f.startFadeOut) {
              // untouched (holds at the post-fade-in value, 1)
            } else if (lifeFrac < f.endFadeOut) {
              const t = THREE.MathUtils.clamp((lifeFrac - f.startFadeOut) / Math.max(1e-6, f.endFadeOut - f.startFadeOut), 0, 1);
              alphaScale *= lerp(1, f.endAlphaFactor, smooth(t));
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

      // Constraints run after every position-affecting operator has ticked
      // for the frame, matching the SDK's constraint pass ordering.
      this.applyConstraints(p);

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
      (this.geometry.attributes.aUvRect as THREE.BufferAttribute).needsUpdate = true;
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
    this.uvRects[i * 4] = p.uvRect[0];
    this.uvRects[i * 4 + 1] = p.uvRect[1];
    this.uvRects[i * 4 + 2] = p.uvRect[2];
    this.uvRects[i * 4 + 3] = p.uvRect[3];
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
