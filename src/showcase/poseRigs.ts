// Posable weapon features for showcase items. A rigged weapon loads its first-person viewmodel GLB,
// which carries the world model's mesh skinned to bones, and these controls drive those bones.

import * as THREE from 'three';

export interface PoseControl {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: '°' | '%';
  defaultValue: number;
  /** Values the control settles on when it gets close, such as each barrel or chamber of a spin. */
  snap?: number;
  /** Bone of the moving part, where its drag handle sits on the board. */
  handle?: string;
}

export interface RestBone {
  bone: THREE.Bone;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  /** Inverse of the bone's rest orientation in model space, to turn model axes into its own. */
  modelInverse: THREE.Quaternion;
  /** Where the part this bone carries meets the weapon (its lowest edge), in the bone's own space. */
  base: THREE.Vector3 | null;
}

interface PoseRig {
  controls: PoseControl[];
  apply(bones: ReadonlyMap<string, RestBone>, values: Readonly<Record<string, number>>): void;
}

/** A piece of a weapon that can be taken out and placed on the board by itself, painted like the weapon. */
export interface WeaponPart {
  id: string;
  label: string;
  bones: readonly string[];
  /** Pieces that only show in the reload animation, floating beside the weapon; never drawn on it. */
  loose?: boolean;
}

const AXIS_X = new THREE.Vector3(1, 0, 0);
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);
const turn = new THREE.Quaternion();
const localAxis = new THREE.Vector3();

function rotateFromRest(rest: RestBone | undefined, axis: THREE.Vector3, degrees: number): void {
  if (!rest) return;
  turn.setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees));
  rest.bone.quaternion.copy(rest.quaternion).multiply(turn);
}

/** Turn a bone around an axis of the weapon (X across, Y up, Z along the barrel), pivoting on the bone. */
function rotateAboutModel(rest: RestBone | undefined, axis: THREE.Vector3, degrees: number): void {
  if (!rest) return;
  rotateFromRest(rest, localAxis.copy(axis).applyQuaternion(rest.modelInverse), degrees);
}

const pivotTurn = new THREE.Vector3();

/** Like rotateAboutModel, but hinged where the part meets the weapon, since the bone's origin can sit inside the gun. */
function foldAboutBase(rest: RestBone | undefined, axis: THREE.Vector3, degrees: number): void {
  if (!rest) return;
  rotateAboutModel(rest, axis, degrees);
  if (!rest.base) return;
  // Keep the foot in place: shift by base - turn(base), expressed in the parent.
  pivotTurn.copy(rest.base).applyQuaternion(turn).negate().add(rest.base).applyQuaternion(rest.quaternion);
  rest.bone.position.copy(rest.position).add(pivotTurn);
}

function slideFromRest(rest: RestBone | undefined, axis: THREE.Vector3, distance: number): void {
  if (!rest) return;
  rest.bone.position.copy(rest.position).addScaledVector(axis, distance);
}

const percent = (values: Readonly<Record<string, number>>, id: string) => (values[id] ?? 0) / 100;

const pumpRig = (travel: number): PoseRig => ({
  controls: [{ id: 'pump', label: 'Pump', min: 0, max: 100, step: 1, unit: '%', defaultValue: 0, handle: 'weapon_bone_1' }],
  apply(bones, values) {
    slideFromRest(bones.get('weapon_bone_1'), AXIS_Z, -travel * percent(values, 'pump'));
  },
});

/** A barrel that tips down on a hinge under its back end, like a break-action launcher. */
const breakOpenControl = (bone: string): PoseControl => ({ id: 'open', label: 'Break open', min: 0, max: 100, step: 1, unit: '%', defaultValue: 0, handle: bone });
const breakOpen = (bones: ReadonlyMap<string, RestBone>, bone: string, degrees: number, values: Readonly<Record<string, number>>) => {
  rotateAboutModel(bones.get(bone), AXIS_X, degrees * percent(values, 'open'));
};

/** One full turn, settling on each barrel or chamber. */
const spinControl = (label: string, count: number, handle: string): PoseControl => ({
  id: 'spin', label, min: 0, max: 360, step: 1, unit: '°', defaultValue: 0, snap: 360 / count, handle,
});

const breakActionRig = (bone: string, degrees: number): PoseRig => ({
  controls: [breakOpenControl(bone)],
  apply(bones, values) {
    breakOpen(bones, bone, degrees, values);
  },
});

/** Flare guns: the barrel tips down, and the hammer, cocked at rest, drops forward. */
const flareGunRig: PoseRig = {
  controls: [
    breakOpenControl('weapon_bone_2'),
    { id: 'hammer', label: 'Drop hammer', min: 0, max: 100, step: 1, unit: '%', defaultValue: 0, handle: 'weapon_bone_4' },
  ],
  apply(bones, values) {
    breakOpen(bones, 'weapon_bone_2', 45, values);
    rotateAboutModel(bones.get('weapon_bone_4'), AXIS_X, -35 * percent(values, 'hammer'));
  },
};

/** Flip-up sights fold back toward the stock and lie along the barrel. */
const SIGHT_FOLD = -85;

const HOSE_JOINTS = ['joint_hose02', 'joint_hose03', 'joint_hose04', 'joint_hose05'];
/** Valve's case boards show the Medi Gun with its lever folded back toward the hose, as far as it goes. */
const LEVER_DOWN = -20;
const FISH_JOINTS = ['jiggle1', 'jiggle2', 'jiggle3'];

const SPIN_RIG: PoseRig = {
  controls: [spinControl('Barrel spin', 6, 'barrel')],
  apply(bones, values) {
    rotateFromRest(bones.get('barrel'), AXIS_Z, values.spin ?? 0);
  },
};

export const POSE_RIGS: Record<string, PoseRig> = {
  c_medigun: {
    controls: [
      { id: 'drop', label: 'Hose drop', min: -45, max: 90, step: 1, unit: '°', defaultValue: 35, handle: 'joint_hose02' },
      { id: 'curl', label: 'Hose curl', min: -40, max: 40, step: 1, unit: '°', defaultValue: 18, handle: 'joint_hose05' },
      { id: 'swing', label: 'Hose swing', min: -30, max: 30, step: 1, unit: '°', defaultValue: 0 },
      // The lever's mesh rides on vm_weapon_bone_L, which hangs off joint_lever at the same hinge.
      // Past -20 it sinks into the rear hose coupling; forward it stays clear up to 90.
      { id: 'lever', label: 'Lever', min: -20, max: 90, step: 1, unit: '°', defaultValue: 0, handle: 'vm_weapon_bone_L' },
    ],
    apply(bones, values) {
      // The hose chain runs along each joint's local X, so a turn about local Z
      // bends it within the gun's side plane and local Y swings it sideways.
      const first = bones.get('joint_hose01');
      rotateFromRest(first, AXIS_Z, -(values.drop ?? 0));
      if (first) first.bone.quaternion.multiply(turn.setFromAxisAngle(AXIS_Y, THREE.MathUtils.degToRad(values.swing ?? 0)));
      for (const name of HOSE_JOINTS) rotateFromRest(bones.get(name), AXIS_Z, -(values.curl ?? 0));
      rotateAboutModel(bones.get('joint_lever'), AXIS_X, values.lever ?? 0);
    },
  },
  c_shotgun: pumpRig(3.2),
  c_trenchgun: pumpRig(3.2),
  c_reserve_shooter: pumpRig(3),
  c_russian_riot: pumpRig(3.2),
  c_tele_shotgun: pumpRig(3.2),
  c_scattergun: {
    // The lever rests closed against the grip, so it only swings down and forward.
    controls: [{ id: 'lever', label: 'Lever', min: 0, max: 100, step: 1, unit: '%', defaultValue: 0, handle: 'weapon_bone_1' }],
    apply(bones, values) {
      rotateFromRest(bones.get('weapon_bone_1'), AXIS_X, -38 * percent(values, 'lever'));
    },
  },
  c_minigun: SPIN_RIG,
  c_gatling_gun: SPIN_RIG,
  c_grenadelauncher: {
    controls: [
      breakOpenControl('weapon_bone_1'),
      spinControl('Drum', 6, 'procedural_chamber'),
      { id: 'sight', label: 'Fold sight', min: 0, max: 100, step: 1, unit: '%', defaultValue: 0, handle: 'weapon_bone_3' },
    ],
    apply(bones, values) {
      breakOpen(bones, 'weapon_bone_1', 40, values);
      rotateAboutModel(bones.get('procedural_chamber'), AXIS_Z, values.spin ?? 0);
      foldAboutBase(bones.get('weapon_bone_3'), AXIS_X, SIGHT_FOLD * percent(values, 'sight'));
    },
  },
  c_lochnload: breakActionRig('weapon_bone_1', 40),
  c_quadball: breakActionRig('weapon_bone_1', 40),
  c_demo_cannon: {
    controls: [
      breakOpenControl('weapon_bone_1'),
      { id: 'sight', label: 'Fold sight', min: 0, max: 100, step: 1, unit: '%', defaultValue: 0, handle: 'weapon_bone_3' },
    ],
    apply(bones, values) {
      breakOpen(bones, 'weapon_bone_1', 40, values);
      foldAboutBase(bones.get('weapon_bone_3'), AXIS_X, SIGHT_FOLD * percent(values, 'sight'));
    },
  },
  c_detonator: flareGunRig,
  c_scorch_shot: flareGunRig,
  c_soda_popper: breakActionRig('weapon_bone_1', 40),
  c_shortstop: breakActionRig('vm_weapon_bone_3', 35),
  c_holymackerel: {
    controls: [{ id: 'bend', label: 'Bend', min: -60, max: 60, step: 1, unit: '°', defaultValue: 0, handle: 'jiggle3' }],
    apply(bones, values) {
      // Spread the bend along the body so the fish curves instead of kinking.
      for (const name of FISH_JOINTS) rotateAboutModel(bones.get(name), AXIS_Z, (values.bend ?? 0) / FISH_JOINTS.length);
    },
  },
  c_riding_crop: {
    controls: [{ id: 'bend', label: 'Tip bend', min: -60, max: 60, step: 1, unit: '°', defaultValue: 0, handle: 'jb3' }],
    apply(bones, values) {
      rotateAboutModel(bones.get('jb3'), AXIS_Z, values.bend ?? 0);
    },
  },
  c_sniperrifle: {
    controls: [{ id: 'cap', label: 'Close lens cap', min: 0, max: 100, step: 1, unit: '%', defaultValue: 0, handle: 'vm_weapon_bone_2' }],
    apply(bones, values) {
      rotateAboutModel(bones.get('vm_weapon_bone_2'), AXIS_X, 205 * percent(values, 'cap'));
    },
  },
  c_rocketlauncher: {
    controls: [{ id: 'sight', label: 'Fold sight', min: 0, max: 100, step: 1, unit: '%', defaultValue: 0, handle: 'vm_weapon_bone_2' }],
    apply(bones, values) {
      rotateAboutModel(bones.get('vm_weapon_bone_1'), AXIS_X, -80 * percent(values, 'sight'));
    },
  },
};

const SHELL: WeaponPart = { id: 'shell', label: 'Shell', bones: ['vm_weapon_bone'] };
const SPARE_GRENADE: WeaponPart = { id: 'grenade', label: 'Spare grenade', bones: ['weapon_bone_4'], loose: true };

/** Pieces allowed past the board's edge, which still keep other weapons apart. `pose` arcs them off the bottom. */
export const HANGING_PARTS: Record<string, { bones: readonly string[]; pose: Record<string, number> }> = {
  c_medigun: {
    bones: ['joint_hose01', ...HOSE_JOINTS],
    pose: { drop: 30, curl: 15, swing: 0, lever: LEVER_DOWN },
  },
};

export const WEAPON_PARTS: Record<string, readonly WeaponPart[]> = {
  c_grenadelauncher: [SPARE_GRENADE],
  c_demo_cannon: [{ id: 'cannonball', label: 'Cannonball', bones: ['weapon_bone_4'] }],
  c_quadball: [{ id: 'grenade', label: 'Grenade', bones: ['weapon_bone_4'] }],
  c_shortstop: [{ id: 'shells', label: 'Shells', bones: ['vm_weapon_bone_1', 'vm_weapon_bone_2'] }],
  c_lochnload: [SPARE_GRENADE],
  c_shotgun: [SHELL],
  c_russian_riot: [SHELL],
  c_tele_shotgun: [SHELL],
  c_smg: [{ id: 'magazine', label: 'Magazine', bones: ['weapon_bone_1'] }],
  c_soda_popper: [
    { id: 'can_left', label: 'Left can', bones: ['weapon_bone_4'] },
    { id: 'can_right', label: 'Right can', bones: ['weapon_bone_3'] },
  ],
};

/** Weapons that load their skinned viewmodel because something on them moves or comes off. */
export const isRigged = (weaponKey: string) => weaponKey in POSE_RIGS || weaponKey in WEAPON_PARTS;

export function partOf(weaponKey: string, partId: string | null): WeaponPart | null {
  return partId ? WEAPON_PARTS[weaponKey]?.find((part) => part.id === partId) ?? null : null;
}

export function defaultPose(weaponKey: string): Record<string, number> {
  const rig = POSE_RIGS[weaponKey];
  return rig ? Object.fromEntries(rig.controls.map((control) => [control.id, control.defaultValue])) : {};
}

export function snapPose(control: PoseControl, value: number): number {
  if (!control.snap) return value;
  const nearest = Math.round(value / control.snap) * control.snap;
  return Math.abs(nearest - value) <= Math.min(5, control.snap / 4) ? nearest : value;
}

/** Snap points inside the control's range, drawn as ticks on its slider. */
export function snapMarks(control: PoseControl): number[] | undefined {
  if (!control.snap) return undefined;
  const marks: number[] = [];
  for (let value = Math.ceil(control.min / control.snap) * control.snap; value <= control.max; value += control.snap) marks.push(value);
  return marks;
}
