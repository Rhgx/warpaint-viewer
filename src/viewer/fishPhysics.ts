import * as THREE from 'three';

export interface FishJiggleSettings {
  name: string;
  length: number;
  tipMass: number;
  yawStiffness: number;
  yawDamping: number;
  pitchStiffness: number;
  pitchDamping: number;
  angleLimit: number;
}

/** Holy Mackerel's flexible, length-constrained bones. No other procedural bone types. */
export class FishBonePhysics {
  private states: {
    bone: THREE.Bone; settings: FishJiggleSettings; initialized: boolean;
    tip: THREE.Vector3; velocity: THREE.Vector3; correction: THREE.Quaternion;
  }[];
  private base = new THREE.Vector3();
  private left = new THREE.Vector3();
  private up = new THREE.Vector3();
  private forward = new THREE.Vector3();
  private goalTip = new THREE.Vector3();
  private error = new THREE.Vector3();
  private direction = new THREE.Vector3();
  private acceleration = new THREE.Vector3();
  private goalRotation = new THREE.Quaternion();
  private rotation = new THREE.Quaternion();
  private identityRotation = new THREE.Quaternion();
  private matrix = new THREE.Matrix4();

  constructor(bones: Map<string, THREE.Bone>, settings: FishJiggleSettings[]) {
    this.states = settings.map(setting => {
      const bone = bones.get(setting.name);
      if (!bone) throw new Error(`Missing fish bone: ${setting.name}`);
      return { bone, settings: setting, initialized: false,
        tip: new THREE.Vector3(), velocity: new THREE.Vector3(), correction: new THREE.Quaternion() };
    });
  }

  reset(): void { for (const state of this.states) state.initialized = false; }

  update(delta: number): void {
    for (const state of this.states) {
      const { bone, settings: s } = state;
      this.base.setFromMatrixPosition(bone.matrixWorld);
      this.left.setFromMatrixColumn(bone.matrixWorld, 0).normalize();
      this.up.setFromMatrixColumn(bone.matrixWorld, 1).normalize();
      this.forward.setFromMatrixColumn(bone.matrixWorld, 2).normalize();
      this.goalRotation.setFromRotationMatrix(bone.matrixWorld);
      this.goalTip.copy(this.base).addScaledVector(this.forward, s.length);
      if (!state.initialized || delta > 0.25) {
        state.tip.copy(this.goalTip); state.velocity.set(0, 0, 0); state.correction.identity();
        state.initialized = true;
      } else if (delta > 0) {
        // Source uses local +Z as the tip axis and tipMass as downward acceleration.
        // Reference: https://github.com/ValveSoftware/source-sdk-2013/blob/master/src/public/jigglebones.cpp
        const steps = Math.ceil(delta * 120);
        const step = delta / steps;
        for (let i = 0; i < steps; i++) {
          this.error.copy(this.goalTip).sub(state.tip);
          this.acceleration.set(0, -s.tipMass, 0)
            .addScaledVector(this.left, s.yawStiffness * this.error.dot(this.left) - s.yawDamping * state.velocity.dot(this.left))
            .addScaledVector(this.up, s.pitchStiffness * this.error.dot(this.up) - s.pitchDamping * state.velocity.dot(this.up));
          state.velocity.addScaledVector(this.acceleration, step);
          state.tip.addScaledVector(state.velocity, step);
          this.direction.copy(state.tip).sub(this.base).normalize();
          if (this.direction.lengthSq() === 0) this.direction.copy(this.forward);
          const angle = this.forward.angleTo(this.direction);
          if (angle > s.angleLimit) {
            this.rotation.setFromUnitVectors(this.forward, this.direction);
            this.rotation.slerp(this.identityRotation, 1 - s.angleLimit / angle);
            this.direction.copy(this.forward).applyQuaternion(this.rotation);
          }
          state.tip.copy(this.base).addScaledVector(this.direction, s.length);
          state.velocity.addScaledVector(this.direction, -state.velocity.dot(this.direction));
        }
        this.left.crossVectors(this.up, this.direction).normalize();
        this.up.crossVectors(this.direction, this.left).normalize();
        this.matrix.makeBasis(this.left, this.up, this.direction);
        this.rotation.setFromRotationMatrix(this.matrix);
        state.correction.copy(this.goalRotation).invert().multiply(this.rotation);
      }
      // Retain the frozen local bend while paused, including when viewmodel offsets change.
      bone.matrixWorld.multiply(this.matrix.makeRotationFromQuaternion(state.correction));
      this.updateChildren(bone);
    }
  }

  private updateChildren(parent: THREE.Object3D): void {
    for (const child of parent.children) {
      child.matrixWorld.multiplyMatrices(parent.matrixWorld, child.matrix);
      this.updateChildren(child);
    }
  }
}
