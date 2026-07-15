import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// A gun-ish shape built from boxes, used when a weapon GLB is missing. Each box
// face carries standard 0..1 UVs so the composited paint is visible across the
// model. Returns a single merged BufferGeometry (positions, normals, uv, index).
export function createPlaceholderWeaponGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, rot = 0) => {
    g.rotateZ(rot);
    g.translate(x, y, z);
    parts.push(g);
  };

  // Receiver / body
  add(new THREE.BoxGeometry(2.4, 0.5, 0.35), 0, 0, 0);
  // Barrel
  add(new THREE.BoxGeometry(1.8, 0.22, 0.22), 1.9, 0.06, 0);
  // Grip (angled down/back)
  add(new THREE.BoxGeometry(0.35, 1.0, 0.3), -0.7, -0.65, 0, -0.35);
  // Magazine
  add(new THREE.BoxGeometry(0.3, 0.8, 0.28), 0.15, -0.6, 0, 0.12);
  // Stock
  add(new THREE.BoxGeometry(1.0, 0.45, 0.3), -1.6, 0.02, 0);
  // Sight
  add(new THREE.BoxGeometry(0.25, 0.2, 0.12), 0.3, 0.38, 0);

  const merged = mergeGeometries(parts, false);
  if (!merged) throw new Error('failed to merge placeholder geometry');
  merged.computeVertexNormals();
  merged.computeBoundingBox();
  return merged;
}
