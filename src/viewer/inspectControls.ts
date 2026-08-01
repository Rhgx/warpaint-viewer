import * as THREE from 'three';

// Controls modeled on TF2's in-game item inspect view
// (tf_item_inspection_panel.cpp / CEmbeddedItemModelPanel): dragging rotates the
// MODEL while the camera stays fixed. Extended for the web viewer:
//   left-drag          rotate model (yaw from horizontal, pitch from vertical,
//                      pitch clamped so it can never flip upside down)
//   scroll wheel       smooth dolly toward/away from the model
//   right/middle drag  pan the model in the view plane (limited)
//   double-click       reset rotation, zoom and pan to the framed default
// Rotation carries a short inertia tail that decays in well under a second and
// can never become a continuous spin (unlike the game's auto-spin, which is
// intentionally not implemented; the model stays still unless the user acts).
// Advanced Camera temporarily freezes that inspect pose and drives the camera
// as a bounded, TF2-inspired free-fly view.

const ROTATE_SPEED = 0.0085; // radians per pixel
const ADVANCED_LOOK_SPEED = 0.0022;
const PITCH_LIMIT = THREE.MathUtils.degToRad(80);
const ADVANCED_PITCH_LIMIT = THREE.MathUtils.degToRad(89);
const INERTIA_HALF_LIFE = 0.09; // seconds; velocity halves every 90 ms
const INERTIA_CUTOFF = 0.02; // rad/s below which inertia stops
const ZOOM_STEP = 1.15; // per wheel notch
const ZOOM_SMOOTHING = 12; // 1/s, exponential approach rate
const PAN_LIMIT_FACTOR = 1.2; // max pan offset as a multiple of model radius
const ADVANCED_SPEED_FACTOR = 2.7;
const ADVANCED_BOOST_MULTIPLIER = 2.5;
const ADVANCED_PRECISION_MULTIPLIER = 0.2;
const ADVANCED_RESPONSE = 8;
const ADVANCED_BOUNDARY_FACTOR = 12;
const ADVANCED_SOFT_BOUNDARY_START = 0.8;

export type CameraMode = 'inspect' | 'advanced';

export class InspectControls {
  private dom: HTMLElement;
  private camera: THREE.PerspectiveCamera;
  private model: THREE.Group;
  private onChange: (() => void) | undefined;
  private onModeChange: ((mode: CameraMode) => void) | undefined;

  // Framing (set by setFraming, restored on reset)
  private readonly defaultViewDir = new THREE.Vector3(0.7, 0.4, 0.8).normalize();
  private viewDir = this.defaultViewDir.clone();
  private baseDist = 5;
  private radius = 1;
  private defaultPan = new THREE.Vector2();

  // Current Inspect Camera state
  private dist = 5;
  private targetDist = 5;
  private yaw = 0;
  private pitch = 0;
  private pan = new THREE.Vector2(); // view-plane offset in world units

  // Inspect Camera interaction state
  private mode: 'none' | 'rotate' | 'pan' = 'none';
  private lastX = 0;
  private lastY = 0;
  private lastMoveTime = 0;
  private velYaw = 0; // rad/s inertia
  private velPitch = 0;

  // Advanced Camera state is independent so leaving it can restore the exact
  // Inspect Camera composition that was present on entry.
  private cameraMode: CameraMode = 'inspect';
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
  private altPressed = false;
  private altChorded = false;
  private disposed = false;

  constructor(
    camera: THREE.PerspectiveCamera,
    model: THREE.Group,
    dom: HTMLElement,
    onChange?: () => void,
    onModeChange?: (mode: CameraMode) => void,
  ) {
    this.camera = camera;
    this.model = model;
    this.dom = dom;
    this.onChange = onChange;
    this.onModeChange = onModeChange;
    model.rotation.order = 'YXZ';

    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('dblclick', this.onDblClick);
    dom.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
    document.addEventListener('mousemove', this.onLockedMouseMove);
    // Capture keyboard input before browser/page shortcuts can observe it while
    // Advanced Camera owns the pointer. Escape is intentionally left alone so
    // the browser can release Pointer Lock.
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onWindowBlur);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    dom.style.touchAction = 'none';
  }

  getCameraMode(): CameraMode {
    return this.cameraMode;
  }

  getInspectDistance(): number {
    return this.dist;
  }

  getInspectQuaternion(target = new THREE.Quaternion()): THREE.Quaternion {
    const matrix = new THREE.Matrix4().lookAt(this.viewDir, new THREE.Vector3(), this.camera.up);
    return target.setFromRotationMatrix(matrix);
  }

  // Orthographic projection emulates the perspective camera's apparent scale.
  // In Advanced Camera, use depth along the viewing axis instead of Euclidean
  // distance: forward/back flight changes scale, while strafing does not.
  getProjectionDistance(): number {
    if (this.cameraMode === 'inspect') return Math.max(this.radius * 0.85, this.camera.position.length());
    const toModel = this.model.getWorldPosition(new THREE.Vector3()).sub(this.camera.position);
    const forward = this.camera.getWorldDirection(new THREE.Vector3());
    return Math.max(this.radius * 0.85, toModel.dot(forward));
  }

  toggleAdvancedCamera(): CameraMode {
    if (this.cameraMode === 'advanced') this.exitAdvancedCamera();
    else this.enterAdvancedCamera();
    return this.cameraMode;
  }

  setAdvancedCamera(enabled: boolean): CameraMode {
    if (enabled && this.cameraMode !== 'advanced') this.enterAdvancedCamera();
    if (!enabled && this.cameraMode === 'advanced') this.exitAdvancedCamera();
    return this.cameraMode;
  }

  // Called by the viewer after loading a model: fixes the camera ray and the
  // default distance, then resets the transform state.
  setFraming(distance: number, radius: number, defaultPan = new THREE.Vector2()) {
    this.setAdvancedCamera(false);
    this.baseDist = distance;
    this.radius = radius;
    this.defaultPan.copy(defaultPan);
    this.resetInspect();
  }

  // Changes the projection-specific resting position without discarding any
  // deliberate pan the user has added on top of it.
  setDefaultPan(defaultPan: THREE.Vector2) {
    this.pan.sub(this.defaultPan).add(defaultPan);
    this.defaultPan.copy(defaultPan);
    if (this.cameraMode === 'inspect') this.applyInspect();
  }

  reset() {
    if (this.cameraMode === 'advanced') {
      this.advancedPosition.copy(this.advancedStartPosition);
      this.advancedYaw = this.advancedStartYaw;
      this.advancedPitch = this.advancedStartPitch;
      this.advancedVelocity.set(0, 0, 0);
      this.applyAdvanced();
      return;
    }
    this.resetInspect();
  }

  private resetInspect() {
    this.yaw = 0;
    this.pitch = 0;
    this.pan.copy(this.defaultPan);
    this.dist = this.baseDist;
    this.targetDist = this.baseDist;
    this.velYaw = 0;
    this.velPitch = 0;
    this.applyInspect();
  }

  private minDist() { return this.radius * 0.85; }
  private maxDist() { return this.baseDist * 4; }

  // Sets the camera's fixed viewing ray (normalized), or restores the default
  // 3/4 inspect angle when null, then resets rotation/pan/zoom so the angle
  // is exact.
  setViewDirection(dir: THREE.Vector3 | null) {
    this.setAdvancedCamera(false);
    if (dir) {
      const d = dir.clone();
      // Straight up/down rays make camera.lookAt's default up vector
      // degenerate; nudge off-axis slightly before normalizing.
      if (Math.abs(d.x) < 1e-6 && Math.abs(d.z) < 1e-6) d.z += 0.0001;
      this.viewDir = d.normalize();
    } else {
      this.viewDir = this.defaultViewDir.clone();
    }
    this.resetInspect();
  }

  // Sets model rotation directly (radians from degrees), clearing inertia.
  // Kept for API completeness; Viewer's view-angle presets now go through
  // setViewDirection instead of rotating the model.
  setPose(yawDeg: number, pitchDeg: number) {
    this.setAdvancedCamera(false);
    this.yaw = THREE.MathUtils.degToRad(yawDeg);
    this.pitch = THREE.MathUtils.clamp(THREE.MathUtils.degToRad(pitchDeg), -PITCH_LIMIT, PITCH_LIMIT);
    this.velYaw = 0;
    this.velPitch = 0;
    this.applyInspect();
  }

  // Rescales the framed default distance (e.g. after an FOV change) while
  // preserving the user's current zoom ratio relative to the old default.
  rescaleFraming(distance: number, defaultPan?: THREE.Vector2) {
    const oldBase = this.baseDist;
    this.baseDist = distance;
    if (oldBase > 0) {
      const ratio = distance / oldBase;
      this.dist = THREE.MathUtils.clamp(this.dist * ratio, this.minDist(), this.maxDist());
      this.targetDist = THREE.MathUtils.clamp(this.targetDist * ratio, this.minDist(), this.maxDist());
    }
    if (defaultPan) {
      this.pan.sub(this.defaultPan).add(defaultPan);
      this.defaultPan.copy(defaultPan);
    }
    if (this.cameraMode === 'inspect') this.applyInspect();
  }

  private onContextMenu = (e: Event) => e.preventDefault();

  private onPointerDown = (e: PointerEvent) => {
    if (this.cameraMode === 'advanced') {
      if (e.button === 0) {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.dom.requestPointerLock?.();
        e.preventDefault();
      }
      return;
    }
    if (e.button === 0) this.mode = 'rotate';
    else if (e.button === 2 || e.button === 1) this.mode = 'pan';
    else return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastMoveTime = performance.now();
    this.velYaw = 0;
    this.velPitch = 0;
    this.dom.setPointerCapture(e.pointerId);
    // Start the active-control frame loop before the first pointermove.
    this.onChange?.();
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.cameraMode === 'advanced') {
      // A drag still works as a fallback if Pointer Lock is unavailable.
      if (document.pointerLockElement !== this.dom && e.buttons !== 0) {
        this.applyAdvancedLook(e.movementX || e.clientX - this.lastX, e.movementY || e.clientY - this.lastY);
        this.lastX = e.clientX;
        this.lastY = e.clientY;
      }
      return;
    }
    if (this.mode === 'none') return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    const now = performance.now();
    const dt = Math.max(1, now - this.lastMoveTime) / 1000;
    this.lastMoveTime = now;
    if (this.mode === 'rotate') {
      const dYaw = dx * ROTATE_SPEED;
      const dPitch = dy * ROTATE_SPEED;
      this.yaw += dYaw;
      this.pitch = THREE.MathUtils.clamp(this.pitch + dPitch, -PITCH_LIMIT, PITCH_LIMIT);
      // Track release velocity for the inertia tail.
      this.velYaw = dYaw / dt;
      this.velPitch = dPitch / dt;
    } else {
      // Pan: convert pixel delta to world units at the model's distance.
      const h = this.dom.clientHeight || 1;
      const worldPerPx = (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
      this.pan.x += dx * worldPerPx;
      this.pan.y -= dy * worldPerPx;
      const limit = this.radius * PAN_LIMIT_FACTOR;
      this.pan.x = THREE.MathUtils.clamp(this.pan.x, -limit, limit);
      this.pan.y = THREE.MathUtils.clamp(this.pan.y, -limit, limit);
    }
    this.applyInspect();
    e.preventDefault();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.cameraMode === 'advanced' || this.mode === 'none') return;
    // If the pointer has been still for a beat before release, drop the inertia.
    if (performance.now() - this.lastMoveTime > 80 || this.mode !== 'rotate') {
      this.velYaw = 0;
      this.velPitch = 0;
    }
    this.mode = 'none';
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
  };

  private onWheel = (e: WheelEvent) => {
    if (this.cameraMode === 'advanced') return;
    e.preventDefault();
    this.targetDist = THREE.MathUtils.clamp(this.targetDist * Math.pow(ZOOM_STEP, e.deltaY / 100), this.minDist(), this.maxDist());
    // Wheel motion is integrated in update(), so request its first frame now.
    this.onChange?.();
  };

  private onDblClick = (e: MouseEvent) => {
    if (this.cameraMode === 'inspect') {
      e.preventDefault();
      this.resetInspect();
    }
  };

  private onPointerLockChange = () => {
    if (document.pointerLockElement === this.dom) this.onChange?.();
    else {
      this.pressedKeys.clear();
      this.advancedPrecisionActive = false;
      this.advancedVelocity.set(0, 0, 0);
    }
  };

  private onLockedMouseMove = (e: MouseEvent) => {
    if (this.cameraMode !== 'advanced' || document.pointerLockElement !== this.dom) return;
    this.applyAdvancedLook(e.movementX, e.movementY);
  };

  private applyAdvancedLook(dx: number, dy: number) {
    this.advancedYaw -= dx * ADVANCED_LOOK_SPEED;
    this.advancedPitch = THREE.MathUtils.clamp(this.advancedPitch - dy * ADVANCED_LOOK_SPEED, -ADVANCED_PITCH_LIMIT, ADVANCED_PITCH_LIMIT);
    this.applyAdvanced();
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Dialog shortcuts must stay local to the dialog. The help sheet is the
    // main consumer today, but this deliberately recognizes any modal.
    if (this.isKeyboardInputBlocked(e.target)) {
      this.pressedKeys.clear();
      this.altPressed = false;
      this.altChorded = false;
      return;
    }
    if (this.shouldSuppressAdvancedShortcut(e)) e.preventDefault();
    if (e.key === 'Alt') {
      if (!e.repeat) { this.altPressed = true; this.altChorded = false; }
      return;
    }
    if (this.altPressed) this.altChorded = true;
    if (this.cameraMode !== 'advanced' || document.pointerLockElement !== this.dom) return;
    if (this.isAdvancedKey(e.code)) {
      this.pressedKeys.add(e.code);
      this.onChange?.();
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (this.isKeyboardInputBlocked(e.target)) {
      this.pressedKeys.clear();
      this.altPressed = false;
      this.altChorded = false;
      return;
    }
    if (this.shouldSuppressAdvancedShortcut(e)) e.preventDefault();
    if (e.key === 'Alt') {
      const shouldToggle = this.altPressed && !this.altChorded;
      this.altPressed = false;
      this.altChorded = false;
      if (shouldToggle) this.toggleAdvancedCamera();
      return;
    }
    if (this.cameraMode !== 'advanced' || document.pointerLockElement !== this.dom) return;
    if (this.isAdvancedKey(e.code)) {
      this.pressedKeys.delete(e.code);
      e.preventDefault();
    }
  };

  private isAdvancedKey(code: string) {
    return code === 'KeyW' || code === 'KeyA' || code === 'KeyS' || code === 'KeyD'
      || code === 'KeyE' || code === 'KeyQ' || code === 'Space'
      || code === 'ControlLeft' || code === 'ControlRight'
      || code === 'ShiftLeft' || code === 'ShiftRight';
  }

  private shouldSuppressAdvancedShortcut(e: KeyboardEvent) {
    return this.cameraMode === 'advanced'
      && document.pointerLockElement === this.dom
      && e.key !== 'Escape';
  }

  private isKeyboardInputBlocked(target: EventTarget | null) {
    if (document.querySelector('[data-camera-input-suspended], [role="dialog"][aria-modal="true"]')) return true;
    if (!(target instanceof HTMLElement)) return false;
    return target.matches('input, textarea, select, [contenteditable="true"]')
      || target.closest('[contenteditable="true"]') !== null;
  }

  private onWindowBlur = () => {
    this.pressedKeys.clear();
    this.altPressed = false;
    this.altChorded = false;
    this.mode = 'none';
    this.velYaw = 0;
    this.velPitch = 0;
    this.advancedVelocity.set(0, 0, 0);
  };

  private onVisibilityChange = () => {
    if (document.hidden) this.onWindowBlur();
  };

  private enterAdvancedCamera() {
    this.mode = 'none';
    this.velYaw = 0;
    this.velPitch = 0;
    this.camera.updateMatrixWorld();
    this.advancedPosition.copy(this.camera.position);
    this.advancedStartPosition.copy(this.camera.position);
    const rotation = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.advancedYaw = this.advancedStartYaw = rotation.y;
    this.advancedPitch = this.advancedStartPitch = rotation.x;
    // Keep the free-fly boundary stable for the lifetime of this session.
    // FOV changes rescale the hidden inspect framing (`baseDist`), but must not
    // move or constrain the active Advanced Camera as a side effect.
    this.advancedMaxDistance = Math.max(this.radius * ADVANCED_BOUNDARY_FACTOR, this.baseDist * 2);
    this.advancedVelocity.set(0, 0, 0);
    this.advancedPrecisionActive = false;
    this.cameraMode = 'advanced';
    this.onModeChange?.(this.cameraMode);
    this.onChange?.();
  }

  private exitAdvancedCamera() {
    this.pressedKeys.clear();
    this.advancedPrecisionActive = false;
    this.advancedVelocity.set(0, 0, 0);
    if (document.pointerLockElement === this.dom) document.exitPointerLock?.();
    this.cameraMode = 'inspect';
    this.applyInspect();
    this.onModeChange?.(this.cameraMode);
  }

  // Per-frame integration: rotate inertia and smooth zoom in Inspect Camera,
  // or integrate velocity and bounds in Advanced Camera. dt is in seconds.
  update(dt: number): boolean {
    if (this.disposed) return false;
    if (this.cameraMode === 'advanced') return this.updateAdvanced(dt);
    let dirty = false;
    if (this.mode !== 'rotate' && (this.velYaw !== 0 || this.velPitch !== 0)) {
      this.yaw += this.velYaw * dt;
      this.pitch = THREE.MathUtils.clamp(this.pitch + this.velPitch * dt, -PITCH_LIMIT, PITCH_LIMIT);
      // Exponential decay with a fixed half-life; fully gone in a few hundred ms.
      const decay = Math.pow(0.5, dt / INERTIA_HALF_LIFE);
      this.velYaw *= decay;
      this.velPitch *= decay;
      if (Math.abs(this.velYaw) < INERTIA_CUTOFF && Math.abs(this.velPitch) < INERTIA_CUTOFF) this.velYaw = this.velPitch = 0;
      dirty = true;
    }
    if (Math.abs(this.dist - this.targetDist) > 1e-4) {
      this.dist += (this.targetDist - this.dist) * (1 - Math.exp(-ZOOM_SMOOTHING * dt));
      if (Math.abs(this.dist - this.targetDist) < 1e-4) this.dist = this.targetDist;
      dirty = true;
    }
    if (dirty) this.applyInspect();
    // Keep a frame pending while a pointer is held, even between pointermove
    // events. This makes controls responsive on displays that present faster
    // than input events, while the viewer can otherwise stay fully idle.
    return dirty || this.mode !== 'none';
  }

  private updateAdvanced(dt: number): boolean {
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    this.camera.getWorldDirection(forward);
    right.setFromMatrixColumn(this.camera.matrixWorld, 0);
    const wish = new THREE.Vector3();
    if (this.pressedKeys.has('KeyW')) wish.add(forward);
    if (this.pressedKeys.has('KeyS')) wish.sub(forward);
    if (this.pressedKeys.has('KeyD')) wish.add(right);
    if (this.pressedKeys.has('KeyA')) wish.sub(right);
    if (this.pressedKeys.has('KeyE') || this.pressedKeys.has('Space')) wish.y += 1;
    if (this.pressedKeys.has('KeyQ')) wish.y -= 1;

    const center = this.model.getWorldPosition(new THREE.Vector3());
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
      const speed = this.radius * ADVANCED_SPEED_FACTOR
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

  private applyInspect() {
    // Camera sits on a fixed ray; only its distance changes.
    this.camera.position.copy(this.viewDir).multiplyScalar(this.dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    // Model carries rotation and view-plane pan.
    this.model.rotation.set(this.pitch, this.yaw, 0);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.model.position.copy(right.multiplyScalar(this.pan.x)).add(up.multiplyScalar(this.pan.y));
    this.onChange?.();
  }

  private applyAdvanced() {
    this.camera.position.copy(this.advancedPosition);
    this.camera.rotation.set(this.advancedPitch, this.advancedYaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
    this.onChange?.();
  }

  dispose() {
    this.disposed = true;
    if (document.pointerLockElement === this.dom) document.exitPointerLock?.();
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('dblclick', this.onDblClick);
    this.dom.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
    document.removeEventListener('mousemove', this.onLockedMouseMove);
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onWindowBlur);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  }
}
