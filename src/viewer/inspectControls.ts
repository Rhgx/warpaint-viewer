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

const ROTATE_SPEED = 0.0085; // radians per pixel
const PITCH_LIMIT = THREE.MathUtils.degToRad(80);
const INERTIA_HALF_LIFE = 0.09; // seconds; velocity halves every 90 ms
const INERTIA_CUTOFF = 0.02; // rad/s below which inertia stops
const ZOOM_STEP = 1.15; // per wheel notch
const ZOOM_SMOOTHING = 12; // 1/s, exponential approach rate
const PAN_LIMIT_FACTOR = 1.2; // max pan offset as a multiple of model radius

export class InspectControls {
  private dom: HTMLElement;
  private camera: THREE.PerspectiveCamera;
  private model: THREE.Group;

  // Framing (set by setFraming, restored on reset)
  private viewDir = new THREE.Vector3(0.7, 0.4, 0.8).normalize();
  private baseDist = 5;
  private radius = 1;

  // Current state
  private dist = 5;
  private targetDist = 5;
  private yaw = 0;
  private pitch = 0;
  private pan = new THREE.Vector2(0, 0); // view-plane offset in world units

  // Interaction state
  private mode: 'none' | 'rotate' | 'pan' = 'none';
  private lastX = 0;
  private lastY = 0;
  private lastMoveTime = 0;
  private velYaw = 0; // rad/s inertia
  private velPitch = 0;

  private disposed = false;

  constructor(camera: THREE.PerspectiveCamera, model: THREE.Group, dom: HTMLElement) {
    this.camera = camera;
    this.model = model;
    this.dom = dom;
    model.rotation.order = 'YXZ';

    dom.addEventListener('pointerdown', this.onPointerDown);
    dom.addEventListener('pointermove', this.onPointerMove);
    dom.addEventListener('pointerup', this.onPointerUp);
    dom.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    dom.addEventListener('dblclick', this.onDblClick);
    dom.addEventListener('contextmenu', this.onContextMenu);
    dom.style.touchAction = 'none';
  }

  // Called by the viewer after loading a model: fixes the camera ray and the
  // default distance, then resets the transform state.
  setFraming(distance: number, radius: number) {
    this.baseDist = distance;
    this.radius = radius;
    this.reset();
  }

  reset() {
    this.yaw = 0;
    this.pitch = 0;
    this.pan.set(0, 0);
    this.dist = this.baseDist;
    this.targetDist = this.baseDist;
    this.velYaw = 0;
    this.velPitch = 0;
    this.apply();
  }

  private minDist() {
    return this.radius * 1.1;
  }
  private maxDist() {
    return this.baseDist * 4;
  }

  private onContextMenu = (e: Event) => e.preventDefault();

  private onPointerDown = (e: PointerEvent) => {
    if (e.button === 0) this.mode = 'rotate';
    else if (e.button === 2 || e.button === 1) this.mode = 'pan';
    else return;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastMoveTime = performance.now();
    this.velYaw = 0;
    this.velPitch = 0;
    this.dom.setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
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
      const worldPerPx = (2 * this.dist * Math.tan(((this.camera.fov / 2) * Math.PI) / 180)) / h;
      this.pan.x += dx * worldPerPx;
      this.pan.y -= dy * worldPerPx;
      const limit = this.radius * PAN_LIMIT_FACTOR;
      this.pan.x = THREE.MathUtils.clamp(this.pan.x, -limit, limit);
      this.pan.y = THREE.MathUtils.clamp(this.pan.y, -limit, limit);
    }
    this.apply();
    e.preventDefault();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (this.mode === 'none') return;
    // If the pointer has been still for a beat before release, drop the inertia.
    if (performance.now() - this.lastMoveTime > 80) {
      this.velYaw = 0;
      this.velPitch = 0;
    }
    if (this.mode !== 'rotate') {
      this.velYaw = 0;
      this.velPitch = 0;
    }
    this.mode = 'none';
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const notches = e.deltaY / 100;
    this.targetDist = THREE.MathUtils.clamp(
      this.targetDist * Math.pow(ZOOM_STEP, notches),
      this.minDist(),
      this.maxDist(),
    );
  };

  private onDblClick = (e: MouseEvent) => {
    e.preventDefault();
    this.reset();
  };

  // Per-frame integration: rotate inertia and smooth zoom. dt in seconds.
  update(dt: number) {
    if (this.disposed) return;
    let dirty = false;

    if (this.mode !== 'rotate' && (this.velYaw !== 0 || this.velPitch !== 0)) {
      this.yaw += this.velYaw * dt;
      this.pitch = THREE.MathUtils.clamp(this.pitch + this.velPitch * dt, -PITCH_LIMIT, PITCH_LIMIT);
      // Exponential decay with a fixed half-life; fully gone in a few hundred ms.
      const decay = Math.pow(0.5, dt / INERTIA_HALF_LIFE);
      this.velYaw *= decay;
      this.velPitch *= decay;
      if (Math.abs(this.velYaw) < INERTIA_CUTOFF && Math.abs(this.velPitch) < INERTIA_CUTOFF) {
        this.velYaw = 0;
        this.velPitch = 0;
      }
      dirty = true;
    }

    if (Math.abs(this.dist - this.targetDist) > 1e-4) {
      const k = 1 - Math.exp(-ZOOM_SMOOTHING * dt);
      this.dist += (this.targetDist - this.dist) * k;
      if (Math.abs(this.dist - this.targetDist) < 1e-4) this.dist = this.targetDist;
      dirty = true;
    }

    if (dirty) this.apply();
  }

  private apply() {
    // Camera sits on a fixed ray; only its distance changes.
    this.camera.position.copy(this.viewDir).multiplyScalar(this.dist);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();

    // Model carries rotation and view-plane pan.
    this.model.rotation.set(this.pitch, this.yaw, 0);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    this.model.position.copy(right.multiplyScalar(this.pan.x)).add(up.multiplyScalar(this.pan.y));
  }

  dispose() {
    this.disposed = true;
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerUp);
    this.dom.removeEventListener('wheel', this.onWheel);
    this.dom.removeEventListener('dblclick', this.onDblClick);
    this.dom.removeEventListener('contextmenu', this.onContextMenu);
  }
}
