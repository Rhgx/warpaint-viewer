// Applies one parsed initializer to a freshly spawned particle.
import * as THREE from 'three';

import type { ControlPoint } from './controlPoint';
import type { ParsedInit } from './parse';
import type { SystemInstance } from './sim';
import type { SimParticle } from './simShared';
import { lerp, lerpExp, randInUnitBall } from './math';
import { tmpV1, tmpV2, tmpV3 } from './simShared';

export function applyInitializer(init: ParsedInit, p: SimParticle, host: SystemInstance): ControlPoint | null {
  switch (init.kind) {
    case 'positionModel': {
      const config = init.positionModel;
      const anchorCp = host.getCp(config.cp, host);
      if (!host.hitboxes.length) {
        p.pos.copy(anchorCp.worldPos);
        return anchorCp;
      }
      const nonZeroBias = config.bias.some((value) => Math.abs(value) > 0.0001);
      const attempts = Math.max(config.tries, nonZeroBias ? 5 : 0) + 1;
      let bestGoodness = -Infinity;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const hitbox = host.hitboxes[Math.floor(Math.random() * host.hitboxes.length)];
        const min = 1 - config.bboxScale;
        const max = config.bboxScale;
        const u = min + Math.random() * (max - min);
        const v = min + Math.random() * (max - min);
        const w = min + Math.random() * (max - min);
        tmpV1.set(
          lerp(hitbox.min[0], hitbox.max[0], u),
          lerp(hitbox.min[1], hitbox.max[1], v),
          lerp(hitbox.min[2], hitbox.max[2], w),
        );
        const m = hitbox.transform;
        tmpV2.set(
          m[0] * tmpV1.x + m[1] * tmpV1.y + m[2] * tmpV1.z + m[3],
          m[4] * tmpV1.x + m[5] * tmpV1.y + m[6] * tmpV1.z + m[7],
          m[8] * tmpV1.x + m[9] * tmpV1.y + m[10] * tmpV1.z + m[11],
        );
        host.geometryToWorld(tmpV2);
        const goodness = Math.random() * 72
          + (tmpV2.x - anchorCp.worldPos.x) * config.bias[0]
          + (tmpV2.y - anchorCp.worldPos.y) * config.bias[1]
          + (tmpV2.z - anchorCp.worldPos.z) * config.bias[2];
        if (goodness > bestGoodness) {
          bestGoodness = goodness;
          p.pos.copy(tmpV2);
        }
      }
      return anchorCp;
    }
    case 'sphere': {
      // C_INIT_CreateWithinSphere: the energy orb (weapon_unusual_energyorb_*) spawns at unusual_1
      // with distance_bias (1,0,1) in local space, zeroing the attachment-local Y. Spawn offset and
      // the 111 u/s launch velocity thus lie in the barrel-and-up plane. Drag (0.3) stalls the
      // particle a dozen units along the barrel, which gives the in-game front-to-back stream.
      const s = init.sphere;
      const cp = host.getCp(s.cp, host);
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
      return cp;
    }
    case 'velocityRandom': {
      const s = init.sphere;
      const cp = host.getCp(s.cp, host);
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
      const o = init.offset;
      const cp = host.getCp(o.cp, host);
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
      p.lifetime = Math.max(0.001, lerpExp(init.range.min, init.range.max, init.range.exp));
      break;
    case 'alpha':
      p.alphaBase = lerpExp(init.range.min, init.range.max, init.range.exp) / 255;
      break;
    case 'radius':
      p.baseRadius = lerpExp(init.range.min, init.range.max, init.range.exp);
      break;
    case 'colorRandom':
      p.colorInit.copy(init.colors.c1).lerp(init.colors.c2, Math.random());
      break;
    case 'rotationRandom':
      p.rotationDeg = init.rotation.initial + lerpExp(init.rotation.offMin, init.rotation.offMax, init.rotation.exp);
      break;
    case 'yawFlip':
      if (Math.random() < init.flipPercent) p.rotationDeg += 180;
      break;
    case 'sequence': {
      // C_INIT_RandomSequence: pick a random index in [sequence_min, sequence_max] and wrap it
      // modulo the sheet's sequence count (some defs ask past it, e.g. 0..4 on smoke1's 16).
      // Every known sheet has one frame per sequence, so the rect stays fixed over a lifetime.
      const sheet = host.sheet;
      if (sheet && sheet.sequences.length > 0) {
        const r = init.sequenceRange;
        const lo = Math.round(Math.min(r.min, r.max));
        const hi = Math.round(Math.max(r.min, r.max));
        const idx = lo + Math.floor(Math.random() * (hi - lo + 1));
        const seq = sheet.sequences[((idx % sheet.sequences.length) + sheet.sequences.length) % sheet.sequences.length];
        const uv = seq.frames[0];
        if (uv) {
          // The VTF sheet rect is top-left origin, but the texture uploads with
          // flipY, so flip y here to match the GL v that the fragment shader samples.
          p.uvRect[0] = uv[0]; p.uvRect[1] = 1 - uv[3]; p.uvRect[2] = uv[2]; p.uvRect[3] = 1 - uv[1];
        }
      }
      break;
    }
    case 'remapScalar': {
      const r = init.remap;
      const span = Math.max(1e-6, r.inMax - r.inMin);
      const t = THREE.MathUtils.clamp((p.systemAgeAtSpawn - r.inMin) / span, 0, 1);
      const v = lerp(r.outMin, r.outMax, t);
      if (r.scalar) p.rotationDeg *= v;
      else p.rotationDeg += v;
      break;
    }
    case 'velocityNoise': {
      const n = init.noise;
      const cp = host.getCp(n.cp, host);
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
      const inh = init.inherit;
      p.vel.addScaledVector(host.getCp(inh.cp, host).vel, inh.scale);
      break;
    }
  }
  return null;
}
