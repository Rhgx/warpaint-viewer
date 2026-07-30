import * as THREE from 'three';
import type { AttachmentAnchor } from './util';

export class ControlPoint {
  anchor: AttachmentAnchor | null;
  worldPos = new THREE.Vector3();
  worldQuat = new THREE.Quaternion();
  prevPos = new THREE.Vector3();
  prevQuat = new THREE.Quaternion();
  deltaPos = new THREE.Vector3();
  deltaQuat = new THREE.Quaternion();
  vel = new THREE.Vector3();
  private initialized = false;

  constructor(anchor: AttachmentAnchor | null) {
    this.anchor = anchor;
    if (anchor) {
      this.worldPos.copy(anchor.pos);
      this.worldQuat.copy(anchor.quat);
    }
  }

  setFromAnchorMatrix(matrix: THREE.Matrix4, matrixQuat: THREE.Quaternion) {
    if (!this.anchor) return;
    this.worldPos.copy(this.anchor.pos).applyMatrix4(matrix);
    this.worldQuat.copy(matrixQuat).multiply(this.anchor.quat);
  }

  beginFrame(dt: number) {
    if (!this.initialized) {
      this.prevPos.copy(this.worldPos);
      this.prevQuat.copy(this.worldQuat);
      this.initialized = true;
    }
    this.deltaPos.subVectors(this.worldPos, this.prevPos);
    this.deltaQuat.copy(this.prevQuat).invert().premultiply(this.worldQuat);
    this.vel.copy(this.deltaPos).divideScalar(Math.max(dt, 1e-5));
  }

  endFrame() {
    this.prevPos.copy(this.worldPos);
    this.prevQuat.copy(this.worldQuat);
  }

  prime() {
    this.prevPos.copy(this.worldPos);
    this.prevQuat.copy(this.worldQuat);
    this.deltaPos.set(0, 0, 0);
    this.deltaQuat.identity();
    this.vel.set(0, 0, 0);
    this.initialized = true;
  }
}
