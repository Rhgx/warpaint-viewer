import * as THREE from 'three';
import { textureUvMatrix } from '../../compositor/compositor';

export interface CheckResult {
  name: string;
  pass: boolean;
  got: number[];
  expected: number[];
}

export function compositorTransformChecks(): CheckResult[] {
  const transformed = new THREE.Vector2(0.1, 0.2).applyMatrix3(
    textureUvMatrix(90, 0.25, 0.5, 2, false, false),
  );
  const flipped = new THREE.Vector2(0.1, 0.2).applyMatrix3(
    textureUvMatrix(45, 0, 0, 1, true, false),
  );
  return [
    {
      name: 'Texture transform uses Source R * S * T order',
      pass: Math.abs(transformed.x + 1.4) < 1e-6 && Math.abs(transformed.y - 0.7) < 1e-6,
      got: [transformed.x, transformed.y],
      expected: [-1.4, 0.7],
    },
    {
      name: 'Texture flip applies after rotation',
      pass: Math.abs(flipped.x - 1.070710678) < 1e-6
        && Math.abs(flipped.y - 0.212132034) < 1e-6,
      got: [flipped.x, flipped.y],
      expected: [1.070710678, 0.212132034],
    },
  ];
}
