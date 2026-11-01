import * as THREE from 'three';

import type { WeaponEntry } from '../data/types';
import type { RestBone, WeaponPart } from './poseRigs';
import type { MeshSubset } from './showcaseTypes';

// Weapon orientation and mesh helpers: rest pose, posed vertices, bone feet and part subsets.
type Axis = 0 | 1 | 2;
const AXIS_VECTORS = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

/** Weapons whose thinnest axis is not the side to show: the crossbow is widest across its limbs but reads best in profile. */
const FACE_AXIS_OVERRIDES: Record<string, Axis> = { c_crusaders_crossbow: 0 };

/** Weapons that rest standing rather than lying: the Back Scratcher hangs like a rake, tines toward the viewer. */
const RESTING_ROLL: Record<string, number> = { c_back_scratcher: -90 };

/** Weapons whose working end rests pointing right, where every other weapon's points left. */
export const FACES_RIGHT = new Set(['c_powerjack']);

/** The roll a weapon rests at; a piece taken out of one lies flat. */
export function restingRoll(weaponKey: string, part: string | null): number {
  return part ? 0 : RESTING_ROLL[weaponKey] ?? 0;
}

/** Rest orientation: the longest axis runs left to right and the thinnest faces the camera; the icon camera picks which face. */
export function baseOrientation(weapon: WeaponEntry, size: THREE.Vector3): THREE.Quaternion {
  const extents = [size.x, size.y, size.z];
  const byLength = ([0, 1, 2] as Axis[]).sort((a, b) => extents[b] - extents[a]);
  const longAxis = byLength[0];
  let viewAxis = FACE_AXIS_OVERRIDES[weapon.key] ?? byLength[2];
  const forward = weapon.iconCamera?.forward;
  if (!(weapon.key in FACE_AXIS_OVERRIDES) && forward && extents[byLength[2]] > extents[byLength[1]] * 0.85) {
    // Nearly as wide as it is tall (a fish, a round blade), so thickness says
    // little about which side is the face; the icon looks at the right one.
    viewAxis = Math.abs(forward[byLength[1]]) > Math.abs(forward[byLength[2]]) ? byLength[1] : byLength[2];
  }
  if (viewAxis === longAxis) viewAxis = byLength[2];
  const upAxis = ([0, 1, 2] as Axis[]).find((axis) => axis !== longAxis && axis !== viewAxis)!;
  const side = (weapon.iconCamera?.position[viewAxis] ?? 1) >= 0 ? 1 : -1;
  const view = AXIS_VECTORS[viewAxis].clone().multiplyScalar(side);
  const long = AXIS_VECTORS[longAxis].clone();
  // Pick the long direction that keeps the remaining axis pointing up.
  if (new THREE.Vector3().crossVectors(view, long).dot(AXIS_VECTORS[upAxis]) < 0) long.negate();
  const up = new THREE.Vector3().crossVectors(view, long);
  const basis = new THREE.Matrix4().makeBasis(long, up, view);
  return new THREE.Quaternion().setFromRotationMatrix(basis).invert();
}

/** Skinned vertex positions in the space `toLocal` maps to, with one combined matrix per bone for speed. */
export function posedPositions(mesh: THREE.Mesh, toLocal: THREE.Matrix4, used: Uint32Array | null = null): Float32Array {
  const position = mesh.geometry.getAttribute('position');
  const count = used ? used.length : position.count;
  const out = new Float32Array(count * 3);
  if (!(mesh instanceof THREE.SkinnedMesh)) {
    const e = toLocal.elements;
    for (let slot = 0; slot < count; slot += 1) {
      const index = used ? used[slot] : slot;
      const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
      out[slot * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
      out[slot * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
      out[slot * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    }
    return out;
  }
  const { bones, boneInverses } = mesh.skeleton;
  const head = toLocal.clone().multiply(mesh.bindMatrixInverse);
  const finals = bones.map((bone, index) => head.clone().multiply(bone.matrixWorld).multiply(boneInverses[index]).multiply(mesh.bindMatrix).elements);
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  for (let slot = 0; slot < count; slot += 1) {
    const index = used ? used[slot] : slot;
    const x = position.getX(index), y = position.getY(index), z = position.getZ(index);
    let ox = 0, oy = 0, oz = 0;
    for (let k = 0; k < 4; k += 1) {
      const weight = skinWeight.getComponent(index, k);
      if (!weight) continue;
      const bone = skinIndex.getComponent(index, k);
      const e = finals[bone];
      ox += weight * (e[0] * x + e[4] * y + e[8] * z + e[12]);
      oy += weight * (e[1] * x + e[5] * y + e[9] * z + e[13]);
      oz += weight * (e[2] * x + e[6] * y + e[10] * z + e[14]);
    }
    out[slot * 3] = ox;
    out[slot * 3 + 1] = oy;
    out[slot * 3 + 2] = oz;
  }
  return out;
}

/** Per bone, the foot of the part riding on it: the middle of its lowest edge in the rest pose, in the bone's space. */
export function findPartBases(mesh: THREE.SkinnedMesh, bones: Map<string, RestBone>): void {
  const owner = dominantBones(mesh);
  const position = mesh.geometry.getAttribute('position');
  const point = new THREE.Vector3();
  const lowest = new Map<string, number>();
  owner.forEach((name, vertex) => {
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    lowest.set(name, Math.min(lowest.get(name) ?? Infinity, point.y));
  });
  const feet = new Map<string, { sum: THREE.Vector3; count: number }>();
  owner.forEach((name, vertex) => {
    point.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
    if (point.y > (lowest.get(name) ?? Infinity) + 0.3) return;
    const foot = feet.get(name) ?? { sum: new THREE.Vector3(), count: 0 };
    foot.sum.add(point);
    foot.count += 1;
    feet.set(name, foot);
  });
  mesh.skeleton.bones.forEach((bone, index) => {
    const rest = bones.get(bone.name);
    const foot = feet.get(bone.name);
    if (!rest || !foot || rest.base) return;
    rest.base = foot.sum.divideScalar(foot.count).applyMatrix4(mesh.skeleton.boneInverses[index]);
  });
}

/** The bone with the most weight on each vertex, by name. */
const dominantBoneCache = new WeakMap<THREE.BufferGeometry, string[]>();
export function dominantBones(mesh: THREE.SkinnedMesh): string[] {
  const cached = dominantBoneCache.get(mesh.geometry);
  if (cached) return cached;
  const skinIndex = mesh.geometry.getAttribute('skinIndex');
  const skinWeight = mesh.geometry.getAttribute('skinWeight');
  const names = mesh.skeleton.bones.map((bone) => bone.name);
  const out: string[] = [];
  for (let index = 0; index < skinIndex.count; index += 1) {
    let best = 0;
    for (let k = 1; k < 4; k += 1) if (skinWeight.getComponent(index, k) > skinWeight.getComponent(index, best)) best = k;
    out.push(names[skinIndex.getComponent(index, best)] ?? '');
  }
  dominantBoneCache.set(mesh.geometry, out);
  return out;
}

/** Triangles with most corners on the given parts, or off them when `keep` is false, as an index into the vertices used. */
export function partSubset(mesh: THREE.SkinnedMesh, parts: readonly WeaponPart[], keep: boolean): MeshSubset {
  const owner = dominantBones(mesh);
  const inPart = (vertex: number) => parts.some((part) => part.bones.includes(owner[vertex]));
  const source = mesh.geometry.getIndex();
  const count = source ? source.count : owner.length;
  const kept: number[] = [];
  for (let corner = 0; corner + 2 < count; corner += 3) {
    const a = source ? source.getX(corner) : corner;
    const b = source ? source.getX(corner + 1) : corner + 1;
    const c = source ? source.getX(corner + 2) : corner + 2;
    const inside = Number(inPart(a)) + Number(inPart(b)) + Number(inPart(c)) >= 2;
    if (inside === keep) kept.push(a, b, c);
  }
  const index = new Uint32Array(kept);
  const remap = new Map<number, number>();
  const used: number[] = [];
  const compact = new Uint32Array(index.length);
  index.forEach((vertex, corner) => {
    let slot = remap.get(vertex);
    if (slot === undefined) {
      slot = used.length;
      remap.set(vertex, slot);
      used.push(vertex);
    }
    compact[corner] = slot;
  });
  return { used: new Uint32Array(used), index: compact, drawIndex: index };
}
