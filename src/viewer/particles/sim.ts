import * as THREE from 'three';

import type { EmitterConfig, ParsedConstraint, ParsedInit, ParsedOp, UnusualSystemDef } from './parse';
import type { HitboxJson } from './util';
import { parseConstraints, parseEmitters, parseInitializers, parseOperators } from './parse';
import type { ParticleIndex, ParticleSheet } from './util';
import { colorFromArray, numOr, resolveParticleTexture, warnOnce } from './util';
import { ControlPoint } from './controlPoint';
import { applyAdditiveBlending } from './particleRenderer';
import { applyParticleConstraints } from './constraints';
import { biasCurve, lerp, smooth } from './math';
import { releaseParticleMaterial, takeParticleMaterial } from './particleMaterialPool';
import type { SimParticle } from './simShared';
import { applyInitializer } from './simInitializers';
import { DEG2RAD, tmpC1, tmpV1, tmpV2 } from './simShared';

export { ControlPoint } from './controlPoint';
export { setParticlePointScale } from './particleRenderer';

const MAX_PARTICLES_CAP = 512;

interface ParticleAttributes {
  readonly position: THREE.BufferAttribute;
  readonly size: THREE.BufferAttribute;
  readonly alpha: THREE.BufferAttribute;
  readonly color: THREE.BufferAttribute;
  readonly frame: THREE.BufferAttribute;
  readonly rotation: THREE.BufferAttribute;
  readonly uvRect: THREE.BufferAttribute;
}

export class SystemInstance {
  readonly name: string;
  readonly children: SystemInstance[] = [];
  points: THREE.Points | null = null;
  // Dynamic CP overrides over the effect's shared anchored table, written by the parent's
  // Set-child-control-points op or this system's own Set Control Point Positions op.
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
  // Handles to the geometry's per-particle attributes, flagged for upload each frame.
  private attributes: ParticleAttributes | null = null;

  // Set once the material's index entry resolves; null for materials without an embedded
  // sprite sheet (only particle/smoke1/smoke1_additive.vmt has one among the extracted VTFs).
  sheet: ParticleSheet | null = null;

  private inits: ParsedInit[];
  private ops: ParsedOp[];
  private constraints: ParsedConstraint[];
  private emitters: EmitterConfig[];
  private hasKillOp: boolean;
  private particles: SimParticle[];
  // Reused by setChildCps. Kept sorted by spawnIndex and bounded to the prefix an operator
  // can address, which avoids per-frame filter/sort allocations.
  private oldestAliveScratch: SimParticle[] = [];
  private slotCount: number;
  private uvRectsDirty = false;

  private defaultRadius: number;
  private defaultColor: THREE.Color;
  private defaultAlpha: number;
  private safeRadius: number;
  hitboxes: HitboxJson[];
  geometryToWorld: (point: THREE.Vector3) => THREE.Vector3;

  private systemAge = 0;
  private spawnCounter = 0;
  private emitAccumulators: number[];
  private instantsFired: boolean[];
  private disposed = false;

  getCp: (index: number, forSystem: SystemInstance) => ControlPoint;
  private createDynamicCp: (index: number) => ControlPoint;

  constructor(
    name: string,
    def: UnusualSystemDef,
    modelRadius: number,
    getCp: (index: number, forSystem: SystemInstance) => ControlPoint,
    createDynamicCp: (index: number) => ControlPoint,
    particleIndex: ParticleIndex,
    hitboxes: HitboxJson[],
    geometryToWorld: (point: THREE.Vector3) => THREE.Vector3,
  ) {
    this.name = name;
    this.getCp = getCp;
    this.createDynamicCp = createDynamicCp;
    this.hitboxes = hitboxes;
    this.geometryToWorld = geometryToWorld;
    this.inits = parseInitializers(def.initializers);
    this.ops = parseOperators(def.operators);
    this.constraints = parseConstraints(def.constraints ?? []);
    this.emitters = parseEmitters(def.emitters);
    // Source particles only die through decay operators. Systems without one (cool's controller
    // chain, the swirls) hold their population forever once emitted.
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

    // Missing materials (index.json `missing`) draw nothing, but the simulation still runs for
    // operators that write child CPs, so only the Points object is skipped.
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
      const attributes: ParticleAttributes = {
        position: new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage),
        size: new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage),
        alpha: new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage),
        color: new THREE.BufferAttribute(this.colors, 3).setUsage(THREE.DynamicDrawUsage),
        frame: new THREE.BufferAttribute(this.frames, 1).setUsage(THREE.DynamicDrawUsage),
        rotation: new THREE.BufferAttribute(this.rotations, 1).setUsage(THREE.DynamicDrawUsage),
        uvRect: new THREE.BufferAttribute(this.uvRects, 4),
      };
      this.geometry = new THREE.BufferGeometry();
      this.geometry.setAttribute('position', attributes.position);
      this.geometry.setAttribute('aSize', attributes.size);
      this.geometry.setAttribute('aAlpha', attributes.alpha);
      this.geometry.setAttribute('aColor', attributes.color);
      this.geometry.setAttribute('aFrame', attributes.frame);
      this.geometry.setAttribute('aRotation', attributes.rotation);
      this.geometry.setAttribute('aUvRect', attributes.uvRect);
      this.attributes = attributes;

      this.material = takeParticleMaterial();

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
        // Sheets and strip animation never co-occur in the extracted data, so one
        // `sheet` field on the system is unambiguous.
        this.sheet = sheet;
      });
    }
  }

  private findDeadSlot(): number {
    for (let i = 0; i < this.particles.length; i++) if (!this.particles[i].alive) return i;
    return -1;
  }

  private spawnParticle(p: SimParticle, slotIndex: number) {
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
      const anchor = applyInitializer(init, p, this);
      if (anchor) anchorCp = anchor;
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

    // Apply the path constraint once at spawn so the particle snaps onto the path instead of
    // flashing at its initializer's spawn point for a frame.
    this.applyConstraints(p);

    if (this.points) {
      const uvOffset = slotIndex * 4;
      this.uvRects[uvOffset] = p.uvRect[0];
      this.uvRects[uvOffset + 1] = p.uvRect[1];
      this.uvRects[uvOffset + 2] = p.uvRect[2];
      this.uvRects[uvOffset + 3] = p.uvRect[3];
      this.uvRectsDirty = true;
    }
  }

  private applyConstraints(p: SimParticle) {
    applyParticleConstraints(
      p,
      this.constraints,
      (index) => this.getCp(index, this),
    );
  }

  // Carries every alive particle (and children) through a teleport: pos through the full
  // transform, vel through its rotation only, so none is left at the old position for a tick.
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
            this.spawnParticle(this.particles[idx], idx);
          }
        }
      } else {
        if (em.duration > 0 && this.systemAge > em.startTime + em.duration) continue;
        this.emitAccumulators[e] += em.rate * dt;
        while (this.emitAccumulators[e] >= 1) {
          this.emitAccumulators[e] -= 1;
          const idx = this.findDeadSlot();
          if (idx < 0) { this.emitAccumulators[e] %= 1; break; }
          this.spawnParticle(this.particles[idx], idx);
        }
      }
    }

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p.alive) {
        this.writeVertex(i, p, 0, 0, tmpC1.set(0, 0, 0), 0);
        continue;
      }
      p.age += dt;

      // Lifespan Decay and Alpha Fade and Decay (C_OP_FadeAndKill) both kill at
      // age >= lifetime. A system with neither is immortal.
      if (this.hasKillOp && p.age >= p.lifetime) {
        p.alive = false;
        this.writeVertex(i, p, 0, 0, tmpC1.set(0, 0, 0), 0);
        continue;
      }

      const lifeFrac = THREE.MathUtils.clamp(p.age / p.lifetime, 0, 1);
      let alphaScale = 1;
      let radiusMult = 1;
      const frameColor = tmpC1.copy(p.colorInit);

      for (const op of this.ops) {
        switch (op.kind) {
          case 'movement': {
            const m = op.movement;
            p.vel.addScaledVector(m.gravity, dt);
            // Movement Basic drag is a per-tick factor at a 30 Hz reference (vel *= 1 - drag each tick),
            // not a per-second coefficient.
            p.vel.multiplyScalar(Math.pow(Math.max(0, 1 - m.drag), dt * 30));
            p.pos.addScaledVector(p.vel, dt);
            break;
          }
          case 'fadeAndKill': {
            // C_OP_FadeAndKill: fade windows are lifetime fractions. A fade-out authored above 1 is
            // never reached, so the branch below never runs.
            const f = op.fadeAndKill;
            if (lifeFrac <= f.startFadeIn) {
              // Alpha stays at 1 before the fade-in.
            } else if (lifeFrac < f.endFadeIn) {
              const t = THREE.MathUtils.clamp((lifeFrac - f.startFadeIn) / Math.max(1e-6, f.endFadeIn - f.startFadeIn), 0, 1);
              alphaScale *= lerp(f.startAlphaFactor, 1, smooth(t));
            } else if (lifeFrac < f.startFadeOut) {
              // Holds at the post-fade-in value, 1.
            } else if (lifeFrac < f.endFadeOut) {
              const t = THREE.MathUtils.clamp((lifeFrac - f.startFadeOut) / Math.max(1e-6, f.endFadeOut - f.startFadeOut), 0, 1);
              alphaScale *= lerp(1, f.endAlphaFactor, smooth(t));
            }
            break;
          }
          case 'fadeIn': {
            const f = op.fade;
            const t = lerp(f.min, f.max, p.rndFadeIn);
            const T = f.proportional ? t * p.lifetime : t;
            if (T > 0 && p.age < T) alphaScale *= THREE.MathUtils.clamp(p.age / T, 0, 1);
            break;
          }
          case 'fadeOut': {
            const f = op.fade;
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
            const r = op.radiusScale;
            const span = Math.max(1e-4, r.endTime - r.startTime);
            let t = THREE.MathUtils.clamp((lifeFrac - r.startTime) / span, 0, 1);
            t = biasCurve(t, r.bias);
            if (r.ease) t = smooth(t);
            radiusMult *= lerp(r.start, r.end, t);
            break;
          }
          case 'colorFade': {
            const c = op.colorFade;
            const span = Math.max(1e-4, c.end - c.start);
            let t = THREE.MathUtils.clamp((lifeFrac - c.start) / span, 0, 1);
            if (c.ease) t = smooth(t);
            frameColor.lerp(c.color, t);
            break;
          }
          case 'spin': {
            const s = op.spin;
            if (s.stopTime <= 0 || p.age < s.stopTime) p.rotationDeg += s.rate * dt;
            else p.rotationDeg += s.rateMin * dt;
            break;
          }
          case 'lock': {
            // C_OP_PositionLock: particles follow the control point's frame-to-frame motion, fading off
            // between the start and end windows. This keeps the effect glued to the weapon.
            const l = op.lock;
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
            const r = op.rotAxis;
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
            // Approximates C_OP_OscillateVector as a sinusoidal wobble. Field 4 is ROTATION, the only
            // scalar target in these files; field 0 would be position.
            const o = op.oscillate;
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
            // C_OP_MaintainSequentialPath: distributes the population along the segment between two CPs
            // and advances it over time so the stream flows start to end. The period uses the lifetime as
            // the traversal time, an approximation of the SDK's sequential assignment counter.
            const m = op.maintainPath;
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

      this.writeVertex(i, p, p.baseRadius * radiusMult, p.alphaBase * alphaScale, frameColor, p.rotationDeg * DEG2RAD);
    }

    // Control-point-writing operators run against the post-tick particle
    // state, feeding the children that tick right after this system.
    for (const op of this.ops) {
      if (op.kind === 'setChildCps') {
        const s = op.setChildCps;
        const needed = s.firstParticle + s.count;
        const alive = this.oldestAliveScratch;
        alive.length = 0;
        for (const particle of this.particles) {
          if (!particle.alive) continue;
          let insertAt = alive.length;
          while (insertAt > 0 && alive[insertAt - 1].spawnIndex > particle.spawnIndex) insertAt--;
          if (insertAt >= needed) continue;
          alive.splice(insertAt, 0, particle);
          if (alive.length > needed) alive.pop();
        }
        for (let k = 0; k < s.count; k++) {
          const src = alive[s.firstParticle + k];
          if (!src) break;
          for (const child of this.children) {
            let cp = child.cpOverrides.get(s.firstCp + k);
            if (!cp) {
              // Inherit the anchored CP's orientation. The SDK only writes positions here unless
              // 'Set cp orientation' is on, so the frame keeps its previous value.
              cp = this.createDynamicCp(s.firstCp + k);
              cp.worldPos.copy(src.pos);
              cp.prime();
              child.cpOverrides.set(s.firstCp + k, cp);
            }
            cp.worldPos.copy(src.pos);
          }
        }
      } else if (op.kind === 'setCpPositions') {
        const s = op.setCpPositions;
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

    if (this.attributes) {
      this.attributes.position.needsUpdate = true;
      this.attributes.size.needsUpdate = true;
      this.attributes.alpha.needsUpdate = true;
      this.attributes.color.needsUpdate = true;
      this.attributes.frame.needsUpdate = true;
      this.attributes.rotation.needsUpdate = true;
      if (this.uvRectsDirty) {
        this.attributes.uvRect.needsUpdate = true;
        this.uvRectsDirty = false;
      }
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

  dispose() {
    this.disposed = true;
    this.geometry?.dispose();
    if (this.material) releaseParticleMaterial(this.material);
    for (const child of this.children) child.dispose();
    // Sprite textures are cached at module level and shared across effects;
    // they are intentionally not disposed here.
  }
}
