import * as THREE from 'three';
import type { ParsedConstraint } from './parse';
import type { ControlPoint } from './controlPoint';
import { lerp } from './math';

interface ConstrainedParticle {
  age: number;
  pos: THREE.Vector3;
}

const tmpMid = new THREE.Vector3();
const tmpPath = new THREE.Vector3();
const tmpDirection = new THREE.Vector3();

export function applyParticleConstraints(
  particle: ConstrainedParticle,
  constraints: readonly ParsedConstraint[],
  getControlPoint: (index: number) => ControlPoint,
) {
  for (const constraint of constraints) {
    if (constraint.kind === 'pathBetweenCps') {
      applyPathConstraint(
        particle,
        constraint.path!,
        getControlPoint,
      );
    }
  }
}

function applyPathConstraint(
  particle: ConstrainedParticle,
  constraint: NonNullable<ParsedConstraint['path']>,
  getControlPoint: (index: number) => ControlPoint,
) {
  const start = getControlPoint(constraint.startCp);
  const end = getControlPoint(constraint.endCp);
  const progress = THREE.MathUtils.clamp(
    particle.age / constraint.travelTime,
    0,
    1,
  );

  tmpMid
    .copy(start.worldPos)
    .lerp(end.worldPos, constraint.midPointPosition);
  tmpPath.copy(start.worldPos).lerp(tmpMid, progress);
  tmpDirection.copy(tmpMid).lerp(end.worldPos, progress);
  tmpPath.lerp(tmpDirection, progress);

  let maxDistance = constraint.maxDistance;
  if (
    constraint.maxDistanceMiddle >= 0 ||
    constraint.maxDistanceEnd >= 0
  ) {
    const middle =
      constraint.maxDistanceMiddle >= 0
        ? constraint.maxDistanceMiddle
        : constraint.maxDistance;
    const endDistance =
      constraint.maxDistanceEnd >= 0
        ? constraint.maxDistanceEnd
        : constraint.maxDistance;
    maxDistance =
      progress <= 0.5
        ? lerp(constraint.maxDistance, middle, progress / 0.5)
        : lerp(middle, endDistance, (progress - 0.5) / 0.5);
  }

  tmpDirection.subVectors(particle.pos, tmpPath);
  const distance = tmpDirection.length();
  if (distance > maxDistance) {
    if (distance < 1e-8) particle.pos.copy(tmpPath);
    else
      particle.pos
        .copy(tmpPath)
        .addScaledVector(tmpDirection, maxDistance / distance);
  } else if (distance < constraint.minDistance) {
    if (distance < 1e-8) {
      tmpDirection.subVectors(end.worldPos, start.worldPos);
      if (tmpDirection.lengthSq() < 1e-12) tmpDirection.set(1, 0, 0);
      tmpDirection.normalize();
    } else {
      tmpDirection.multiplyScalar(1 / distance);
    }
    particle.pos
      .copy(tmpPath)
      .addScaledVector(tmpDirection, constraint.minDistance);
  }
}
