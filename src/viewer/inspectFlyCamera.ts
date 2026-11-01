// Advanced Camera free-fly: keyboard and mouse motion bounded around the model.
import * as THREE from 'three';

const ADVANCED_LOOK_SPEED = 0.0022;
const ADVANCED_PITCH_LIMIT = THREE.MathUtils.degToRad(89);
const ADVANCED_SPEED_FACTOR = 2.7;
const ADVANCED_BOOST_MULTIPLIER = 2.5;
const ADVANCED_PRECISION_MULTIPLIER = 0.2;
const ADVANCED_RESPONSE = 8;
const ADVANCED_SOFT_BOUNDARY_START = 0.8;

/** Owner state the free-fly camera reads each frame. */
interface AdvancedFlyCameraHost {
  readonly camera: THREE.PerspectiveCamera;
  readonly model: THREE.Group;
  readonly getRadius: () => number;
  readonly onChange?: () => void;
}

export class AdvancedFlyCamera {
  private readonly host: AdvancedFlyCameraHost;
  private advancedPosition = new THREE.Vector3();
  private advancedStartPosition = new THREE.Vector3();
  private advancedVelocity = new THREE.Vector3();
  private advancedYaw = 0;
  private advancedPitch = 0;
  private advancedStartYaw = 0;
  private advancedStartPitch = 0;
  private advancedMaxDistance = 1;
  private pressedKeys = new Set<string>();
  private advancedPrecisionActive = false;

  constructor(host: AdvancedFlyCameraHost) {
    this.host = host;
  }

  // Starts free-fly from the inspect camera's current pose; the owner sets the boundary.
  begin(maxDistance: number) {
    this.advancedPosition.copy(this.host.camera.position);
    this.advancedStartPosition.copy(this.host.camera.position);
    const rotation = new THREE.Euler().setFromQuaternion(this.host.camera.quaternion, 'YXZ');
    this.advancedYaw = this.advancedStartYaw = rotation.y;
    this.advancedPitch = this.advancedStartPitch = rotation.x;
    this.advancedMaxDistance = maxDistance;
    this.advancedVelocity.set(0, 0, 0);
    this.advancedPrecisionActive = false;
  }

  resetToStart() {
    this.advancedPosition.copy(this.advancedStartPosition);
    this.advancedYaw = this.advancedStartYaw;
    this.advancedPitch = this.advancedStartPitch;
    this.advancedVelocity.set(0, 0, 0);
    this.applyAdvanced();
  }

  clearKeys() { this.pressedKeys.clear(); }

  press(code: string) { this.pressedKeys.add(code); }

  release(code: string) { this.pressedKeys.delete(code); }

  setPrecisionActive(active: boolean) { this.advancedPrecisionActive = active; }

  zeroVelocity() { this.advancedVelocity.set(0, 0, 0); }

  applyAdvancedLook(dx: number, dy: number) {
    this.advancedYaw -= dx * ADVANCED_LOOK_SPEED;
    this.advancedPitch = THREE.MathUtils.clamp(this.advancedPitch - dy * ADVANCED_LOOK_SPEED, -ADVANCED_PITCH_LIMIT, ADVANCED_PITCH_LIMIT);
    this.applyAdvanced();
  }

  updateAdvanced(dt: number): boolean {
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    this.host.camera.getWorldDirection(forward);
    right.setFromMatrixColumn(this.host.camera.matrixWorld, 0);
    const wish = new THREE.Vector3();
    if (this.pressedKeys.has('KeyW')) wish.add(forward);
    if (this.pressedKeys.has('KeyS')) wish.sub(forward);
    if (this.pressedKeys.has('KeyD')) wish.add(right);
    if (this.pressedKeys.has('KeyA')) wish.sub(right);
    if (this.pressedKeys.has('KeyE') || this.pressedKeys.has('Space')) wish.y += 1;
    if (this.pressedKeys.has('KeyQ')) wish.y -= 1;

    const center = this.host.model.getWorldPosition(new THREE.Vector3());
    const offset = this.advancedPosition.clone().sub(center);
    const maxDistance = this.advancedMaxDistance;
    const distance = offset.length();
    if (wish.lengthSq() > 0) {
      wish.normalize();
      // Near the edge, reduce only outward movement. The camera can always
      // still retreat, strafe, or return toward the weapon.
      const outward = distance > 1e-6 ? Math.max(0, wish.dot(offset.multiplyScalar(1 / distance))) : 0;
      const softStart = maxDistance * ADVANCED_SOFT_BOUNDARY_START;
      const softScale = distance <= softStart ? 1 : THREE.MathUtils.clamp((maxDistance - distance) / (maxDistance - softStart), 0, 1);
      const boosted = this.pressedKeys.has('ControlLeft') || this.pressedKeys.has('ControlRight');
      const precision = this.pressedKeys.has('ShiftLeft') || this.pressedKeys.has('ShiftRight');
      const speed = this.host.getRadius() * ADVANCED_SPEED_FACTOR
        * (boosted ? ADVANCED_BOOST_MULTIPLIER : 1)
        * (precision ? ADVANCED_PRECISION_MULTIPLIER : 1);
      wish.multiplyScalar(speed * (outward > 0 ? THREE.MathUtils.lerp(1, softScale, outward) : 1));
    }
    const precision = this.pressedKeys.has('ShiftLeft') || this.pressedKeys.has('ShiftRight');
    if (precision) {
      // Precision mode has no momentum: input maps directly to velocity and
      // releasing movement stops the camera on the same frame.
      this.advancedVelocity.copy(wish);
    } else if (this.advancedPrecisionActive && wish.lengthSq() === 0) {
      // Movement and Shift can both be released between animation frames. Do
      // not feed the final precision velocity into normal-mode momentum.
      this.advancedVelocity.set(0, 0, 0);
    } else {
      const response = 1 - Math.exp(-ADVANCED_RESPONSE * dt);
      this.advancedVelocity.lerp(wish, response);
    }
    this.advancedPrecisionActive = precision;
    if (wish.lengthSq() === 0 && this.advancedVelocity.lengthSq() < 1e-6) this.advancedVelocity.set(0, 0, 0);
    const next = this.advancedPosition.clone().addScaledVector(this.advancedVelocity, dt);
    const nextOffset = next.sub(center);
    if (nextOffset.length() > maxDistance) {
      nextOffset.setLength(maxDistance);
      this.advancedPosition.copy(center).add(nextOffset);
      const normal = nextOffset.normalize();
      const outwardVelocity = this.advancedVelocity.dot(normal);
      if (outwardVelocity > 0) this.advancedVelocity.addScaledVector(normal, -outwardVelocity);
    } else {
      this.advancedPosition.addScaledVector(this.advancedVelocity, dt);
    }
    const moving = this.advancedVelocity.lengthSq() > 1e-6 || this.pressedKeys.size > 0;
    if (moving) this.applyAdvanced();
    return moving;
  }

  private applyAdvanced() {
    this.host.camera.position.copy(this.advancedPosition);
    this.host.camera.rotation.set(this.advancedPitch, this.advancedYaw, 0, 'YXZ');
    this.host.camera.updateMatrixWorld();
    this.host.onChange?.();
  }
}
