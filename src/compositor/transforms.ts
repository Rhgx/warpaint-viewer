import * as THREE from 'three';

/**
 * Matches Source's F * R * S * T texture transform order about the UV origin.
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
  const tx = scale * (c * translateU - s * translateV);
  const ty = scale * (s * translateU + c * translateV);
  return new THREE.Matrix3().set(
    fx * c * scale, fx * -s * scale, fx * tx + (flipU ? 1 : 0),
    fy * s * scale, fy * c * scale, fy * ty + (flipV ? 1 : 0),
    0, 0, 1,
  );
}
