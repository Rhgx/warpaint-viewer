import * as THREE from 'three';

/**
 * Matches Source's R * S * T texture transform order about the UV origin.
 */
export function textureUvMatrix(
  rotationDeg: number,
  translateU: number,
  translateV: number,
  scale: number,
  flipU: boolean,
  flipV: boolean,
): THREE.Matrix3 {
  const rad = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const fx = flipU ? -1 : 1;
  const fy = flipV ? -1 : 1;
  const sx = fx * scale;
  const sy = fy * scale;
  return new THREE.Matrix3().set(
    c * sx, -s * sy, c * sx * translateU - s * sy * translateV,
    s * sx, c * sy, s * sx * translateU + c * sy * translateV,
    0, 0, 1,
  );
}
