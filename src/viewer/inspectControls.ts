import * as THREE from 'three';
import { TOUCH_ONLY_DEVICE } from '../device';
import { AdvancedFlyCamera } from './inspectFlyCamera';
import {
  DOUBLE_CLICK_DISTANCE_PX,
  DOUBLE_TAP_SLOP_PX,
  inspectDoubleClickResets,
  inspectDragForPointer,
  isRapidInspectClickPair,
  touchPairSnapshot,
} from './inspectInput';
import type { InspectPointerClick, InspectPrimaryDragMode, TouchPairSnapshot, TouchPoint } from './inspectInput';

// Inspect camera modeled on TF2's item inspect panel (tf_item_inspection_panel.cpp): drags
// rotate the MODEL while the camera stays fixed. Left drag rotates, the wheel dollies, right
// or middle drag pans, and double-click resets. Touch: one finger rotates, two fingers pan
// and pinch, and double-tap resets. Rotation inertia decays within a second and never becomes
// a spin; auto-spin is opt-in (setAutoSpin). Advanced Camera freezes this pose for a bounded
// free-fly view. It needs a keyboard and mouse, so touch-only devices never enter it.

const ROTATE_SPEED = 0.0085; // radians per pixel
const PITCH_LIMIT = THREE.MathUtils.degToRad(80);
const INERTIA_HALF_LIFE = 0.09; // seconds; velocity halves every 90 ms
const INERTIA_CUTOFF = 0.02; // rad/s below which inertia stops
const ZOOM_STEP = 1.15; // per wheel notch
const ZOOM_SMOOTHING = 12; // 1/s, exponential approach rate
const INSPECT_MIN_DISTANCE_FACTOR = 0.35;
/** Default zoom-out ceiling, as a multiple of the model's framed distance. */
export const INSPECT_MAX_DISTANCE_FACTOR = 4;
const PAN_LIMIT_FACTOR = 1.2; // max pan offset as a multiple of model radius
const ADVANCED_BOUNDARY_FACTOR = 12;
// Auto-spin timing from CTFItemInspectionPanel::OnThink: spin drops to 0 on grab, then 2 s
// after release ramps back over 2 s through vgui's INTERPOLATOR_BIAS at 0.75.
const SPIN_RESUME_DELAY = 2;
const SPIN_RAMP_SECONDS = 2;
const SPIN_RAMP_EXPONENT = Math.log(0.75) / Math.log(0.5);
// Below this finger spread a pinch has no usable ratio, so it only pans.
const MIN_PINCH_SPREAD_PX = 1;

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

  private dist = 5;
  private targetDist = 5;
  private yaw = 0;
  private pitch = 0;
  private pan = new THREE.Vector2(); // view-plane offset in world units

  // One gesture owns the camera at a time: a single mouse/pen pointer (`dragPointerId`) or up to
  // two touches. `pinch` is the two-finger gesture (pan plus zoom, never inertia).
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
  // Set by a touch release that flings. No frames run under a resting finger, so the frame
  // clock's first delta after it can span that pause and must not count as fling time.
  private flingJustReleased = false;
  private pendingStickerMiddleClick: (InspectPointerClick & { readonly pointerId: number; moved: boolean }) | null = null;
  private lastStickerMiddleClick: InspectPointerClick | null = null;

  // Advanced Camera state is independent so leaving it can restore the exact
  // Inspect Camera composition that was present on entry.
  private cameraMode: CameraMode = 'inspect';
  // The paint editor owns Shift + primary-click for part selection and has a simpler camera
  // model, so free-fly is unavailable while that interaction is active.
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
  // Direct-manipulation controls can sit above this canvas while an editor owns their drag.
  // Keep inspect input out of those exact pointer starts only.
  private pointerDownExclusion: ((event: PointerEvent) => boolean) | null = null;
  private readonly flyCamera: AdvancedFlyCamera;
  private maxDistanceFactor = INSPECT_MAX_DISTANCE_FACTOR;
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
    this.flyCamera = new AdvancedFlyCamera({
      camera,
      model,
      getRadius: () => this.radius,
      onChange,
    });
    model.rotation.order = 'YXZ';

    dom.addEventListener('touchstart', this.onTouchStart, { passive: false });
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
    // Capture keys before page shortcuts see them while Advanced Camera owns the pointer. Escape
    // is left alone so the browser can release Pointer Lock.
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

  getInspectQuaternion(): THREE.Quaternion {
    const matrix = new THREE.Matrix4().lookAt(this.viewDir, new THREE.Vector3(), this.camera.up);
    return new THREE.Quaternion().setFromRotationMatrix(matrix);
  }

  // Orthographic projection emulates perspective scale. In Advanced Camera use depth along the
  // view axis, not Euclidean distance: forward flight changes scale, strafing does not.
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
   * Enables or disables free-fly input. Disabling it leaves Advanced Camera at once if active.
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
   * In paint editing, Shift + primary-click belongs to the editor, not a model orbit.
   */
  setEditorSelectionActive(active: boolean) {
    this.editorSelectionActive = active;
    if (active) this.cancelGesture();
  }

  /**
   * Configures only empty-canvas primary drags, so an editor can reserve left drag while
   * secondary camera gestures keep working.
   */
  setPrimaryDragMode(mode: InspectPrimaryDragMode) {
    this.primaryDragMode = mode;
    // Touch has no secondary buttons, so a disabled primary drag leaves every touch to the editor.
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
      this.flyCamera.resetToStart();
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
   * Raises or restores the zoom-out ceiling for editors placing objects outside the framing.
   * Lowering it eases an out-of-range camera back in through normal zoom smoothing.
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

  // Sets the fixed viewing ray (normalized), or restores the default 3/4 angle when null,
  // then resets rotation, pan and zoom so the angle is exact.
  setViewDirection(dir: THREE.Vector3 | null) {
    this.setAdvancedCamera(false);
    // Inspect controls use a stable world-up frame. Authored attachment roll (for inventory icons)
    // would tilt ordinary orbit and pan between weapons, so it is not carried into the camera.
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

  /** TF2 inspect auto-spin at `radiansPerSecond` (0 turns it off), ramping in from rest. */
  setAutoSpin(radiansPerSecond: number) {
    if (radiansPerSecond > 0 && this.spinRate === 0) this.spinRamp = 0;
    this.spinRate = radiansPerSecond;
  }

  // CBaseModelPanel::RotateYaw: turns the model about world up, keeping pitch, pan and zoom.
  // Only the model moves, so the turntable also works in Advanced Camera.
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

  // Chromium holds back moves inside its touch slop region unless touchstart is consumed, and
  // cancelling pointerdown does not consume it. The model would stick, then jump, on every drag.
  // Pointer events still arrive, and double-tap has its own tracker, so nothing here needs the click.
  private onTouchStart = (e: Event) => {
    if (e.cancelable) e.preventDefault();
  };

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
    // Leave this pointer sequence observable to the editor's handler: it tells selection from a
    // camera gesture by the release point and a small drag threshold, so do not prevent it.
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
        this.flyCamera.applyAdvancedLook(e.movementX || e.clientX - this.lastX, e.movementY || e.clientY - this.lastY);
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
    const from = this.pinchBaseline;
    const next = touchPairSnapshot(points[0], points[1]);
    this.pinchBaseline = next;
    this.panBy(next.x - from.x, next.y - from.y);
    // Spreading the fingers moves the camera closer. Both distances are set so
    // the zoom tracks the fingers directly instead of easing like the wheel.
    const usable = from.distance >= MIN_PINCH_SPREAD_PX && next.distance >= MIN_PINCH_SPREAD_PX;
    this.dist = this.targetDist = THREE.MathUtils.clamp(
      this.dist * (usable ? from.distance / next.distance : 1), this.minDist(), this.maxDist());
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
    if (this.velYaw !== 0 || this.velPitch !== 0) {
      this.flingJustReleased = true;
      this.onChange?.();
    }
    const start = this.tapStart;
    this.tapStart = null;
    if (!start || start.pointerId !== e.pointerId
      || Math.hypot(e.clientX - start.clientX, e.clientY - start.clientY) > DOUBLE_CLICK_DISTANCE_PX) {
      this.lastTap = null;
      return;
    }
    const tap = { clientX: e.clientX, clientY: e.clientY, time: performance.now() };
    if (this.lastTap && isRapidInspectClickPair(this.lastTap, tap, DOUBLE_TAP_SLOP_PX)) {
      this.lastTap = null;
      this.resetInspect();
    } else {
      this.lastTap = tap;
    }
  }

  /**
   * Re-reads touch baselines whenever the owned touch count changes, so the pose never jumps.
   * Drops rotational inertia: only a final one-finger release may fling.
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
   * Owned pointers hold capture, so their release always reaches this element, and a lost
   * capture drops them via onPointerCancel. A pointer the browser refuses is not owned.
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
      this.flyCamera.clearKeys();
      this.flyCamera.setPrecisionActive(false);
      this.flyCamera.zeroVelocity();
    }
  };

  private onLockedMouseMove = (e: MouseEvent) => {
    if (this.cameraMode !== 'advanced' || document.pointerLockElement !== this.dom) return;
    this.flyCamera.applyAdvancedLook(e.movementX, e.movementY);
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.interactionLocked) return;
    // Dialog shortcuts stay local to the dialog; this recognizes any modal, not just the help sheet.
    if (this.isKeyboardInputBlocked(e.target)) {
      this.flyCamera.clearKeys();
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
      this.flyCamera.press(e.code);
      this.onChange?.();
      e.preventDefault();
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (this.isKeyboardInputBlocked(e.target)) {
      this.flyCamera.clearKeys();
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
      this.flyCamera.release(e.code);
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
    this.flyCamera.clearKeys();
    this.altPressed = false;
    this.altChorded = false;
    this.cancelGesture();
    this.pendingStickerMiddleClick = null;
    this.lastStickerMiddleClick = null;
    this.flyCamera.zeroVelocity();
  };

  private onVisibilityChange = () => {
    if (document.hidden) this.onWindowBlur();
  };

  private enterAdvancedCamera() {
    this.cancelGesture();
    this.camera.updateMatrixWorld();
    // Keep the free-fly boundary stable for the session. FOV changes rescale the hidden inspect
    // framing (`baseDist`) but must not constrain the active Advanced Camera.
    this.flyCamera.begin(Math.max(this.radius * ADVANCED_BOUNDARY_FACTOR, this.baseDist * 2));
    this.cameraMode = 'advanced';
    this.onModeChange?.(this.cameraMode);
    this.onChange?.();
  }

  private exitAdvancedCamera() {
    this.flyCamera.clearKeys();
    this.flyCamera.setPrecisionActive(false);
    this.flyCamera.zeroVelocity();
    if (document.pointerLockElement === this.dom) document.exitPointerLock?.();
    this.cameraMode = 'inspect';
    this.applyInspect();
    this.onModeChange?.(this.cameraMode);
  }

  // Per-frame integration: rotate inertia and smooth zoom in Inspect Camera,
  // or integrate velocity and bounds in Advanced Camera. dt is in seconds.
  update(dt: number): boolean {
    if (this.disposed) return false;
    if (this.cameraMode === 'advanced') return this.flyCamera.updateAdvanced(dt);
    let dirty = false;
    if (this.mode !== 'rotate' && (this.velYaw !== 0 || this.velPitch !== 0)) {
      const step = this.flingJustReleased ? Math.min(dt, 1 / 60) : dt;
      this.flingJustReleased = false;
      this.yaw += this.velYaw * step;
      this.pitch = THREE.MathUtils.clamp(this.pitch + this.velPitch * step, -PITCH_LIMIT, PITCH_LIMIT);
      // Exponential decay with a fixed half-life; fully gone in a few hundred ms.
      const decay = Math.pow(0.5, step / INERTIA_HALF_LIFE);
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
    // Keep a frame pending while a mouse or pen is held, so controls stay responsive on displays that
    // refresh faster than input events. Touch draws only when a finger moves the pose: on a phone,
    // redrawing an unchanged scene costs GPU time that the next real frame then waits behind.
    return dirty || this.dragPointerId !== null || this.spinRate > 0;
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

  dispose() {
    this.disposed = true;
    this.cancelGesture();
    if (document.pointerLockElement === this.dom) document.exitPointerLock?.();
    this.dom.removeEventListener('touchstart', this.onTouchStart);
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
