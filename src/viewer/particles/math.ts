import * as THREE from 'three';

export function biasCurve(t: number, bias: number): number {
  if (bias <= 0 || bias >= 1 || bias === 0.5) return t;
  return t / ((1 / bias - 2) * (1 - t) + 1);
}

export function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpExp(a: number, b: number, exp: number): number {
  return lerp(a, b, Math.pow(Math.random(), Math.max(exp, 1e-6)));
}

export function randInUnitBall(out: THREE.Vector3): THREE.Vector3 {
  do {
    out.set(
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
      Math.random() * 2 - 1,
    );
  } while (out.lengthSq() > 1 || out.lengthSq() < 1e-12);
  return out;
}
