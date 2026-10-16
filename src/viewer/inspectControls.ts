import * as THREE from 'three';
import { TOUCH_ONLY_DEVICE } from '../device';

// Controls modeled on TF2's in-game item inspect view
// (tf_item_inspection_panel.cpp / CEmbeddedItemModelPanel): dragging rotates the
// MODEL while the camera stays fixed. Extended for the web viewer:
//   left-drag          rotate model (yaw from horizontal, pitch from vertical,
//                      pitch clamped so it can never flip upside down)
//   scroll wheel       smooth dolly toward/away from the model
//   right/middle drag  pan the model in the view plane (limited)
//   double-click       reset rotation, zoom and pan to the framed default
// Touch:
//   one finger         rotate, like left-drag
//   two fingers        centroid pans, spread pinches the zoom; later fingers
//                      are ignored until the gesture ends
//   double-tap         reset, like double-click
// Rotation carries a short inertia tail that decays in well under a second and
// can never become a continuous spin on its own. The game's auto-spin is
// opt-in (setAutoSpin); otherwise the model stays still unless the user acts.
// Advanced Camera temporarily freezes that inspect pose and drives the camera
// as a bounded, TF2-inspired free-fly view. It needs a keyboard and mouse, so
// touch-only devices never enter it.

const ROTATE_SPEED = 0.0085; // radians per pixel
const ADVANCED_LOOK_SPEED = 0.0022;
const PITCH_LIMIT = THREE.MathUtils.degToRad(80);
const ADVANCED_PITCH_LIMIT = THREE.MathUtils.degToRad(89);
const INERTIA_HALF_LIFE = 0.09; // seconds; velocity halves every 90 ms
const INERTIA_CUTOFF = 0.02; // rad/s below which inertia stops
const ZOOM_STEP = 1.15; // per wheel notch
const ZOOM_SMOOTHING = 12; // 1/s, exponential approach rate
export const INSPECT_MIN_DISTANCE_FACTOR = 0.35;
/** Default zoom-out ceiling, as a multiple of the model's framed distance. */
export const INSPECT_MAX_DISTANCE_FACTOR = 4;
const PAN_LIMIT_FACTOR = 1.2; // max pan offset as a multiple of model radius
const ADVANCED_SPEED_FACTOR = 2.7;
const ADVANCED_BOOST_MULTIPLIER = 2.5;
const ADVANCED_PRECISION_MULTIPLIER = 0.2;
const ADVANCED_RESPONSE = 8;
const ADVANCED_BOUNDARY_FACTOR = 12;
const ADVANCED_SOFT_BOUNDARY_START = 0.8;
const DOUBLE_CLICK_WINDOW_MS = 350;
// Auto-spin timing from CTFItemInspectionPanel::OnThink: spin_vel drops to 0
// the moment the model is grabbed, and 2 s after release ramps back to 1 over
// 2 s through vgui's INTERPOLATOR_BIAS at 0.75.
const SPIN_RESUME_DELAY = 2;
const SPIN_RAMP_SECONDS = 2;
const SPIN_RAMP_EXPONENT = Math.log(0.75) / Math.log(0.5);
const DOUBLE_CLICK_DISTANCE_PX = 6;
// Two fingertip taps rarely land within a mouse's few pixels of each other.
const DOUBLE_TAP_SLOP_PX = 40;
// Below this finger spread a pinch has no usable ratio, so it only pans.
const MIN_PINCH_SPREAD_PX = 1;

export type CameraMode = 'inspect' | 'advanced';
/** Which inspect gesture owns a primary drag on empty canvas space. */
export type InspectPrimaryDragMode = 'rotate' | 'disabled';

/** Resolve only the inspect gesture; higher-level editors still own pointer capture. */
export function inspectDragForPointer(
  button: number,
  primaryDragMode: InspectPrimaryDragMode,
): 'none' | 'rotate' | 'pan' {
  if (button === 0) return primaryDragMode === 'disabled' ? 'none' : 'rotate';
  if (button === 1) return primaryDragMode === 'disabled' ? 'rotate' : 'pan';
  return button === 2 ? 'pan' : 'none';
}

/** Sticker placement reserves primary double-click; middle keeps a reset route. */
export function inspectDoubleClickResets(
  button: number,
  primaryDragMode: InspectPrimaryDragMode,
): boolean {
  return primaryDragMode === 'rotate' && button === 0;
}

export interface InspectPointerClick {
  readonly clientX: number;
  readonly clientY: number;
  readonly time: number;
}

/** Detect a reliable middle double-click (or, with touch slop, a double-tap) from completed gestures. */
export function isRapidInspectClickPair(
  first: InspectPointerClick,
  second: InspectPointerClick,
  maxDistancePx = DOUBLE_CLICK_DISTANCE_PX,
): boolean {
  return second.time >= first.time
    && second.time - first.time <= DOUBLE_CLICK_WINDOW_MS
    && Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY) <= maxDistancePx;
}

/** Whether two completed single-finger taps form a reset double-tap. */
export function isInspectDoubleTap(first: InspectPointerClick, second: InspectPointerClick): boolean {
  return isRapidInspectClickPair(first, second, DOUBLE_TAP_SLOP_PX);
}

export interface TouchPoint {
  x: number;
  y: number;
}

/** Centroid and spread of a two-finger touch, the baseline for pan and pinch. */
export interface TouchPairSnapshot {
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}

export function touchPairSnapshot(a: TouchPoint, b: TouchPoint): TouchPairSnapshot {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, distance: Math.hypot(b.x - a.x, b.y - a.y) };
}

/**
 * Centroid movement in pixels and the camera-distance factor between two
 * snapshots: spreading the fingers moves the camera closer.
 */
export function touchPairDelta(from: TouchPairSnapshot, to: TouchPairSnapshot): { dx: number; dy: number; distanceScale: number } {
  const usable = from.distance >= MIN_PINCH_SPREAD_PX && to.distance >= MIN_PINCH_SPREAD_PX;
  return { dx: to.x - from.x, dy: to.y - from.y, distanceScale: usable ? from.distance / to.distance : 1 };
}

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

  // Inspect Camera interaction state. One gesture owns the camera at a time:
  // either a single mouse/pen pointer (`dragPointerId`) or up to two touches.
  // `pinch` is the two-finger touch gesture (pan plus zoom, never inertia).
  private mode: 'none' | 'rotate' | 'pan' | 'pinch' = 'none';
  private dragPointerId: number | null = null;
  private touches = new Map<number, TouchPoint>();
  private pinchBaseline: TouchPairSnapshot | null = null;
  // Set when a higher-level editor took the first finger, so later fingers of
  // the same touch session do not start a camera gesture underneath it.
  private touchSessionForeign = false;
  private tapStart: { readonly pointerId: number; readonly clientX: number; readonly clientY: number } | null = null;
  private lastTap: InspectPointerClick | null = null;
  // Touch double-taps reset through the tap tracker; the dblclick a browser may
  // synthesize from them must not reset a second time.
  private lastPointerDownWasTouch = false;
  /** Auto-spin speed at full ramp in rad/s; 0 when off. */
  private spinRate = 0;
  /** Seconds into the auto-spin ramp, or -1 while stopped by manipulation. */
  private spinRamp = -1;
  private spinIdle = 0;
  private lastX = 0;
  private lastY = 0;
  private lastMoveTime = 0;
  private velYaw = 0; // rad/s inertia
  private velPitch = 0;
  private pendingStickerMiddleClick: (InspectPointerClick & { readonly pointerId: number; moved: boolean }) | null = null;
  private lastStickerMiddleClick: InspectPointerClick | null = null;

  // Advanced Camera state is independent so leaving it can restore the exact
  // Inspect Camera composition that was present on entry.
  private cameraMode: CameraMode = 'inspect';
  // The visual paint editor deliberately owns Shift + primary-click for part
  // selection. It also has a much simpler camera model, so free-fly is not
  // available while that interaction is active.
  private advancedCameraAvailable = !TOUCH_ONLY_DEVICE;
  private interactionLocked = false;
  private previewActive = false;

  /** First-person preview owns the view: inspect pointer, wheel and reset input are ignored. */
  setPreviewActive(active: boolean): void {
    this.previewActive = active;
    if (active) {
      this.cancelGesture();
      this.setAdvancedCamera(false);
    }
  }
  private editorSelectionActive = false;
  // Sticker placement reserves ordinary primary drags for its own surfaces.
  // Keep this narrowly scoped: paint editing keeps the familiar orbit gesture.
  private primaryDragMode: InspectPrimaryDragMode = 'rotate';
  // Direct-manipulation controls may be rendered above this canvas while a
  // higher-level editor owns their drag lifecycle. Keep inspect input out of
  // those exact pointer starts without changing ordinary canvas drags.
  private pointerDownExclusion: ((event: PointerEvent) => boolean) | null = null;
  private advancedPosition = new THREE.Vector3();
  private advancedStartPosition = new THREE.Vector3();
  private advancedVelocity = new THREE.Vector3();
  private advancedYaw = 0;
  private advancedPitch = 0;
  private advancedStartYaw = 0;
  private advancedStartPitch = 0;
  private advancedMaxDistance = 1;
  private maxDistanceFactor = INSPECT_MAX_DISTANCE_FACTOR;
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
    dom.addEventListener('pointercancel', this.onPointerCancel);
    dom.addEventListener('lostpointercapture', this.onPointerCancel);
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
    if (!this.advancedCameraAvailable || this.interactionLocked) return this.cameraMode;
    if (this.cameraMode === 'advanced') this.exitAdvancedCamera();
    else this.enterAdvancedCamera();
    return this.cameraMode;
  }

  setAdvancedCamera(enabled: boolean): CameraMode {
    if (enabled && this.interactionLocked) return this.cameraMode;
    if (enabled && !this.advancedCameraAvailable) return this.cameraMode;
    if (enabled && this.cameraMode !== 'advanced') this.enterAdvancedCamera();
    if (!enabled && this.cameraMode === 'advanced') this.exitAdvancedCamera();
    return this.cameraMode;
  }

  /**
   * Enables or disables free-fly input without changing the normal inspect
   * camera. Disabling it immediately leaves Advanced Camera if necessary.
   */
  setAdvancedCameraAvailable(available: boolean): CameraMode {
    this.advancedCameraAvailable = available && !TOUCH_ONLY_DEVICE;
    this.altPressed = false;
    this.altChorded = false;
    if (!available) this.setAdvancedCamera(false);
    return this.cameraMode;
  }

  /** Freeze all camera input for an exact authored screenshot composition. */
  setInteractionLocked(locked: boolean) {
    this.interactionLocked = locked;
    this.cancelGesture();
    this.targetDist = this.dist;
    this.altPressed = false;
    this.altChorded = false;
    if (locked) this.setAdvancedCamera(false);
  }

  /**
   * In paint editing, Shift + primary-click belongs to the editor rather than
   * beginning a model orbit. Other inspect-camera gestures continue to work.
   */
  setEditorSelectionActive(active: boolean) {
    this.editorSelectionActive = active;
    if (active) this.cancelGesture();
  }

  /**
   * Configure only empty-canvas primary drags. Secondary camera gestures stay
   * intact, which lets a direct-manipulation editor reserve left drag without
   * turning its stage into a dead end for inspection.
   */
  setPrimaryDragMode(mode: InspectPrimaryDragMode) {
    this.primaryDragMode = mode;
    // Touch has no secondary buttons, so a disabled primary drag leaves every
    // touch to the editor.
    if (mode === 'disabled' && (this.mode === 'rotate' || this.touches.size > 0)) this.cancelGesture();
    if (mode !== 'disabled') {
      this.pendingStickerMiddleClick = null;
      this.lastStickerMiddleClick = null;
    }
  }

  /** Reserve specific primary-pointer starts for a higher-level editor tool. */
  setPointerDownExclusion(exclusion: ((event: PointerEvent) => boolean) | null) {
    this.pointerDownExclusion = exclusion;
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

  private minDist() { return this.radius * INSPECT_MIN_DISTANCE_FACTOR; }
  private maxDist() { return this.baseDist * this.maxDistanceFactor; }

  /**
   * Raise or restore the zoom-out ceiling. Editors that place objects outside
   * the model's own framing need to see further out than plain inspection ever
   * does; lowering it again eases an out-of-range camera back in through the
   * usual zoom smoothing rather than snapping on the next wheel notch.
   */
  setMaxDistanceFactor(factor: number) {
    const next = Math.max(1, factor);
    if (next === this.maxDistanceFactor) return;
    this.maxDistanceFactor = next;
    const max = this.maxDist();
    if (this.targetDist > max) {
      this.targetDist = max;
      this.onChange?.();
    }
  }

  // Sets the camera's fixed viewing ray (normalized), or restores the default
  // 3/4 inspect angle when null, then resets rotation/pan/zoom so the angle
  // is exact.
  setViewDirection(dir: THREE.Vector3 | null) {
    this.setAdvancedCamera(false);
    // Inspect controls always operate in a stable world-up frame. Model
    // attachments can contain an authored roll for inventory-icon rendering,
    // but carrying that roll into the interactive camera makes ordinary orbit
    // and pan feel tilted and inconsistent between weapons.
    this.camera.up.set(0, 1, 0);
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

  /** TF2 inspect auto-spin at `radiansPerSecond` (0 turns it off), ramping in from rest. */
  setAutoSpin(radiansPerSecond: number) {
    if (radiansPerSecond > 0 && this.spinRate === 0) this.spinRamp = 0;
    this.spinRate = radiansPerSecond;
  }

  // CBaseModelPanel::RotateYaw: turn the model about world up, keeping pitch,
  // pan and zoom. Touches only the model, so the turntable also works while
  // Advanced Camera has the camera.
  rotateYaw(radians: number) {
    this.velYaw = 0;
    this.velPitch = 0;
    this.yaw = (this.yaw + radians) % (Math.PI * 2);
    this.model.rotation.set(this.pitch, this.yaw, 0);
  }

  /** Current inspect zoom distance, and the framed default it resets to. */
  getDistance(): { current: number; framed: number } {
    return { current: this.dist, framed: this.baseDist };
  }

  /** Jumps the inspect zoom (no smoothing); Advanced Camera keeps its pose. */
  setDistance(distance: number) {
    this.dist = this.targetDist = distance;
    if (this.cameraMode === 'inspect') this.applyInspect();
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
    this.lastPointerDownWasTouch = e.pointerType === 'touch';
    if (this.interactionLocked || this.previewActive) {
      e.preventDefault();
      return;
    }
    if (e.button === 0 && this.pointerDownExclusion?.(e)) {
      // A missed pointerup must not leave a stale inspect gesture or inertia
      // tail running underneath an editor-owned transform.
      this.cancelGesture();
      if (e.pointerType === 'touch') this.touchSessionForeign = true;
      if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    if (this.cameraMode === 'advanced') {
      if (e.button === 0) {
        this.lastX = e.clientX;
        this.lastY = e.clientY;
        this.dom.requestPointerLock?.();
        e.preventDefault();
      }
      return;
    }
    if (e.pointerType === 'touch') {
      this.beginTouch(e);
      return;
    }
    // One gesture owns the camera; a second pointer kind cannot join it.
    if (this.touches.size > 0 || (this.dragPointerId !== null && this.dragPointerId !== e.pointerId)) return;
    // Let the editor's React handler observe this exact pointer sequence. Do
    // not capture or prevent it: the editor uses the release point and a
    // small drag threshold to distinguish selection from a camera gesture.
    if (this.editorSelectionActive && e.button === 0 && e.shiftKey) return;
    if (e.button === 1 && this.primaryDragMode === 'disabled') {
      const click = { clientX: e.clientX, clientY: e.clientY, time: performance.now() };
      if (this.lastStickerMiddleClick && isRapidInspectClickPair(this.lastStickerMiddleClick, click)) {
        this.lastStickerMiddleClick = null;
        this.pendingStickerMiddleClick = null;
        this.resetInspect();
        e.preventDefault();
        return;
      }
      this.pendingStickerMiddleClick = { ...click, pointerId: e.pointerId, moved: false };
    }
    // Sticker placement owns left drag. Middle becomes the deliberate inspect
    // orbit gesture, while right remains the stable pan affordance.
    this.mode = inspectDragForPointer(e.button, this.primaryDragMode);
    this.dragPointerId = null;
    if (this.mode === 'none') return;
    if (!this.capturePointer(e.pointerId)) {
      this.mode = 'none';
      return;
    }
    this.dragPointerId = e.pointerId;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.lastMoveTime = performance.now();
    this.velYaw = 0;
    this.velPitch = 0;
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
    if (e.pointerType === 'touch') {
      this.moveTouch(e);
      return;
    }
    if (this.mode === 'none' || e.pointerId !== this.dragPointerId) return;
    const pendingMiddleClick = this.pendingStickerMiddleClick;
    if (pendingMiddleClick?.pointerId === e.pointerId
      && Math.hypot(e.clientX - pendingMiddleClick.clientX, e.clientY - pendingMiddleClick.clientY) > DOUBLE_CLICK_DISTANCE_PX) {
      this.pendingStickerMiddleClick = { ...pendingMiddleClick, moved: true };
    }
    this.dragTo(e.clientX, e.clientY);
    e.preventDefault();
  };

  // Shared by mouse drags and one-finger touch so both feel identical.
  private dragTo(x: number, y: number) {
    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.lastX = x;
    this.lastY = y;
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
      this.panBy(dx, dy);
    }
    this.applyInspect();
  }

  private panBy(dx: number, dy: number) {
    // Pan: convert pixel delta to world units at the model's distance.
    const h = this.dom.clientHeight || 1;
    const worldPerPx = (2 * this.dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2))) / h;
    this.pan.x += dx * worldPerPx;
    this.pan.y -= dy * worldPerPx;
    const limit = this.radius * PAN_LIMIT_FACTOR;
    this.pan.x = THREE.MathUtils.clamp(this.pan.x, -limit, limit);
    this.pan.y = THREE.MathUtils.clamp(this.pan.y, -limit, limit);
  }

  private onPointerUp = (e: PointerEvent) => {
    const pendingMiddleClick = this.pendingStickerMiddleClick;
    if (pendingMiddleClick?.pointerId === e.pointerId) {
      const released = { clientX: e.clientX, clientY: e.clientY, time: performance.now() };
      const moved = pendingMiddleClick.moved
        || Math.hypot(released.clientX - pendingMiddleClick.clientX, released.clientY - pendingMiddleClick.clientY) > DOUBLE_CLICK_DISTANCE_PX;
      this.lastStickerMiddleClick = moved ? null : released;
      this.pendingStickerMiddleClick = null;
    }
    if (e.pointerType === 'touch') {
      this.endTouch(e);
      return;
    }
    if (e.pointerId !== this.dragPointerId) return;
    // If the pointer has been still for a beat before release, drop the inertia.
    if (performance.now() - this.lastMoveTime > 80 || this.mode !== 'rotate') {
      this.velYaw = 0;
      this.velPitch = 0;
    }
    this.mode = 'none';
    this.dragPointerId = null;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
  };

  // pointercancel and lostpointercapture: drop only that pointer, and never
  // let an interrupted gesture fling or count toward a double-tap.
  private onPointerCancel = (e: PointerEvent) => {
    if (this.pendingStickerMiddleClick?.pointerId === e.pointerId) {
      this.pendingStickerMiddleClick = null;
      this.lastStickerMiddleClick = null;
    }
    const ownedTouch = this.touches.delete(e.pointerId);
    if (!ownedTouch && e.pointerId !== this.dragPointerId) return;
    if (!ownedTouch) {
      this.dragPointerId = null;
      this.mode = 'none';
    }
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    this.tapStart = null;
    this.lastTap = null;
    if (ownedTouch) this.rebaselineTouches();
    this.velYaw = 0;
    this.velPitch = 0;
  };

  private beginTouch(e: PointerEvent) {
    // A primary touch starts a new session: every earlier finger has lifted,
    // even if its pointerup never reached this element.
    if (e.isPrimary) {
      this.touchSessionForeign = false;
      this.touches.clear();
    }
    if (this.touchSessionForeign || this.primaryDragMode === 'disabled'
      || this.dragPointerId !== null || this.touches.size >= 2) return;
    if (!this.capturePointer(e.pointerId)) return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.touches.size === 1) {
      this.tapStart = { pointerId: e.pointerId, clientX: e.clientX, clientY: e.clientY };
    } else {
      // Any multitouch disqualifies the sequence as a double-tap.
      this.tapStart = null;
      this.lastTap = null;
    }
    this.rebaselineTouches();
    this.onChange?.();
    e.preventDefault();
  }

  private moveTouch(e: PointerEvent) {
    const point = this.touches.get(e.pointerId);
    if (!point) return;
    e.preventDefault();
    point.x = e.clientX;
    point.y = e.clientY;
    const tap = this.tapStart;
    if (tap?.pointerId === e.pointerId
      && Math.hypot(e.clientX - tap.clientX, e.clientY - tap.clientY) > DOUBLE_CLICK_DISTANCE_PX) {
      this.tapStart = null;
      this.lastTap = null;
    }
    if (this.mode === 'rotate') {
      this.dragTo(e.clientX, e.clientY);
      return;
    }
    const points = [...this.touches.values()];
    if (this.mode !== 'pinch' || points.length !== 2 || !this.pinchBaseline) return;
    const next = touchPairSnapshot(points[0], points[1]);
    const { dx, dy, distanceScale } = touchPairDelta(this.pinchBaseline, next);
    this.pinchBaseline = next;
    this.panBy(dx, dy);
    // Set both distances so the zoom tracks the fingers directly instead of
    // easing behind them like the wheel does.
    this.dist = this.targetDist = THREE.MathUtils.clamp(this.dist * distanceScale, this.minDist(), this.maxDist());
    this.applyInspect();
  }

  private endTouch(e: PointerEvent) {
    if (!this.touches.delete(e.pointerId)) return;
    if (this.dom.hasPointerCapture(e.pointerId)) this.dom.releasePointerCapture(e.pointerId);
    if (this.touches.size > 0) {
      // 2 -> 1: keep rotating from the remaining finger's current position.
      this.rebaselineTouches();
      return;
    }
    // Same release rule as the mouse: a finger that paused keeps no inertia.
    if (performance.now() - this.lastMoveTime > 80 || this.mode !== 'rotate') {
      this.velYaw = 0;
      this.velPitch = 0;
    }
    this.mode = 'none';
    const start = this.tapStart;
    this.tapStart = null;
    if (!start || start.pointerId !== e.pointerId
      || Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) > DOUBLE_CLICK_DISTANCE_PX) {
      this.lastTap = null;
      return;
    }
    const tap = { clientX: e.clientX, clientY: e.clientY, time: performance.now() };
    if (this.lastTap && isInspectDoubleTap(this.lastTap, tap)) {
      this.lastTap = null;
      this.resetInspect();
    } else {
      this.lastTap = tap;
    }
  }

  /**
   * Called whenever the owned touch count changes. Re-reads the baselines from
   * the fingers' current positions so the pose never jumps, and drops any
   * rotational inertia: only a final one-finger release may fling.
   */
  private rebaselineTouches() {
    const points = [...this.touches.values()];
    this.velYaw = 0;
    this.velPitch = 0;
    this.lastMoveTime = performance.now();
    this.pinchBaseline = null;
    if (points.length === 2) {
      this.mode = 'pinch';
      this.pinchBaseline = touchPairSnapshot(points[0], points[1]);
    } else if (points.length === 1) {
      this.mode = 'rotate';
      this.lastX = points[0].x;
      this.lastY = points[0].y;
    } else {
      this.mode = 'none';
    }
  }

  /**
   * Every owned pointer holds capture: its release then always reaches this
   * element, and a lost capture drops it through onPointerCancel, so a pointer
   * released outside the canvas can never stay owned. A pointer the browser
   * refuses to capture (already released, or unknown) is simply not owned.
   */
  private capturePointer(pointerId: number): boolean {
    try {
      this.dom.setPointerCapture(pointerId);
      return true;
    } catch {
      return false;
    }
  }

  /** Drop every owned pointer and release its capture, without an inertia tail. */
  private cancelGesture() {
    const owned = [...this.touches.keys()];
    if (this.dragPointerId !== null) owned.push(this.dragPointerId);
    // Clear ownership before releasing so the lostpointercapture it causes is a no-op.
    this.touches.clear();
    this.dragPointerId = null;
    this.pinchBaseline = null;
    this.mode = 'none';
    this.velYaw = 0;
    this.velPitch = 0;
    this.tapStart = null;
    this.lastTap = null;
    for (const id of owned) {
      if (this.dom.hasPointerCapture(id)) this.dom.releasePointerCapture(id);
    }
  }

  private onWheel = (e: WheelEvent) => {
    if (this.interactionLocked || this.previewActive) {
      e.preventDefault();
      return;
    }
    if (this.cameraMode === 'advanced') return;
    e.preventDefault();
    this.targetDist = THREE.MathUtils.clamp(this.targetDist * Math.pow(ZOOM_STEP, e.deltaY / 100), this.minDist(), this.maxDist());
    // Wheel motion is integrated in update(), so request its first frame now.
    this.onChange?.();
  };

  private onDblClick = (e: MouseEvent) => {
    if (this.interactionLocked || this.previewActive) {
      e.preventDefault();
      return;
    }
    if (this.lastPointerDownWasTouch || this.cameraMode !== 'inspect' || !inspectDoubleClickResets(e.button, this.primaryDragMode)) return;
    e.preventDefault();
    this.resetInspect();
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
    if (this.interactionLocked) return;
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
      if (!this.advancedCameraAvailable) return;
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
      if (!this.advancedCameraAvailable) return;
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
    if (this.previewActive) return true;
    if (document.querySelector('[data-camera-input-suspended], [role="dialog"][aria-modal="true"]')) return true;
    if (!(target instanceof HTMLElement)) return false;
    return target.matches('input, textarea, select, [contenteditable="true"]')
      || target.closest('[contenteditable="true"]') !== null;
  }

  private onWindowBlur = () => {
    this.pressedKeys.clear();
    this.altPressed = false;
    this.altChorded = false;
    this.cancelGesture();
    this.pendingStickerMiddleClick = null;
    this.lastStickerMiddleClick = null;
    this.advancedVelocity.set(0, 0, 0);
  };

  private onVisibilityChange = () => {
    if (document.hidden) this.onWindowBlur();
  };

  private enterAdvancedCamera() {
    this.cancelGesture();
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
    if (this.spinRate > 0) {
      if (this.mode !== 'none') {
        this.spinRamp = -1;
        this.spinIdle = 0;
      } else {
        this.spinIdle += dt;
        if (this.spinRamp < 0 && this.spinIdle > SPIN_RESUME_DELAY) this.spinRamp = 0;
        if (this.spinRamp >= 0) {
          this.spinRamp = Math.min(SPIN_RAMP_SECONDS, this.spinRamp + dt);
          const speed = (this.spinRamp / SPIN_RAMP_SECONDS) ** SPIN_RAMP_EXPONENT;
          this.yaw = (this.yaw + this.spinRate * speed * dt) % (Math.PI * 2);
          dirty = true;
        }
      }
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
    return dirty || this.mode !== 'none' || this.spinRate > 0;
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
    this.cancelGesture();
    if (document.pointerLockElement === this.dom) document.exitPointerLock?.();
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
    this.dom.removeEventListener('pointermove', this.onPointerMove);
    this.dom.removeEventListener('pointerup', this.onPointerUp);
    this.dom.removeEventListener('pointercancel', this.onPointerCancel);
    this.dom.removeEventListener('lostpointercapture', this.onPointerCancel);
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
