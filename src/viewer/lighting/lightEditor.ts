import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { LightingFrame } from './lighting';
import {
  buildCustomLights,
  framePositionToWorld,
  type CustomLight,
  type CustomLightRuntime,
  type CustomLightingRig,
  updateCustomLightRuntime,
  worldPositionToFrame,
} from './customLighting';
import { validateCustomLightingRig } from './customLightingModel';
import {
  clientToNdc,
  createAimHandleTexture,
  disposeObjectResources,
  isSecondaryTouch,
  pointDistanceToClient,
  setObjectColor,
  updateDefinition,
  type LightEditorHandle,
} from './lightEditorHelpers';

export interface LightEditorPick {
  readonly id: string;
  readonly handle: LightEditorHandle;
}

export interface LightEditorOptions {
  readonly canvas: HTMLCanvasElement;
  readonly root: THREE.Group;
  readonly getCamera: () => THREE.Camera;
  readonly getFrame: () => Pick<LightingFrame, 'dimensions'> | null;
  readonly invalidate: () => void;
  readonly onChange: (rig: CustomLightingRig) => void;
  readonly onSelectionChange?: (id: string | null) => void;
}

interface LightVisual {
  readonly runtime: CustomLightRuntime;
  readonly sourceHandle: THREE.Points;
  readonly targetHandle: THREE.Points | null;
  readonly helper: THREE.Object3D;
  readonly line: THREE.Line | null;
}

const HANDLE_HIT_RADIUS = 22;
const HELPER_SIZE = 0.16;
const DEFAULT_HELPER_COLOR = 0xaeb9c8;
const DISABLED_HELPER_COLOR = 0x68717d;
const SELECTED_HELPER_COLOR = 0x2f6fdb;
const HANDLE_COLOR = SELECTED_HELPER_COLOR;
const SELECTED_SOURCE_SIZE = 15;
const UNSELECTED_SOURCE_SIZE = 11;
const DISABLED_SOURCE_SIZE = 10;
const AIM_HANDLE_SIZE = 26;

/**
 * Viewer-specific lighting editor. Authored values stay separate from Three.js
 * objects so rigs serialize directly.
 */
export class LightEditor {
  private readonly canvas: HTMLCanvasElement;
  private readonly root: THREE.Group;
  private readonly lightsRoot = new THREE.Group();
  private readonly helpersRoot = new THREE.Group();
  private readonly transformControls: TransformControls;
  private readonly getCamera: () => THREE.Camera;
  private readonly getFrame: () => Pick<LightingFrame, 'dimensions'> | null;
  private readonly invalidate: () => void;
  private readonly onChange: (rig: CustomLightingRig) => void;
  private readonly onSelectionChange: (id: string | null) => void;
  private rig: CustomLightingRig = validateCustomLightingRig(null);
  private frame: Pick<LightingFrame, 'dimensions'> | null = null;
  private visuals = new Map<string, LightVisual>();
  private selectedLightId: string | null = null;
  private editorEnabled = false;
  private captureMode = false;
  private targetDrag: {
    gesture: LightEditorPick;
    plane: THREE.Plane;
    pointerId: number | null;
    initialRig: CustomLightingRig;
  } | null = null;
  private sourceTransformInitialRig: CustomLightingRig | null = null;
  private transformPointerId: number | null = null;
  private sourceTransformChanged = false;
  private markerGeometry = new THREE.BufferGeometry().setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0], 3),
  );
  private aimHandleTexture = createAimHandleTexture();
  private aimHandleMaterial = new THREE.PointsMaterial({
    color: HANDLE_COLOR,
    map: this.aimHandleTexture,
    size: AIM_HANDLE_SIZE,
    sizeAttenuation: false,
    transparent: true,
    alphaTest: 0.15,
    depthTest: false,
    depthWrite: false,
  });

  constructor(options: LightEditorOptions) {
    this.canvas = options.canvas;
    this.root = options.root;
    this.getCamera = options.getCamera;
    this.getFrame = options.getFrame;
    this.invalidate = options.invalidate;
    this.onChange = options.onChange;
    this.onSelectionChange = options.onSelectionChange ?? (() => undefined);
    this.transformControls = new TransformControls(this.getCamera(), this.canvas);
    this.transformControls.setMode('translate');
    // Local space, not world: the rig rotates with the model while the editor is open, and
    // only local keeps each arrow along the axis its X/Y/Z field writes.
    this.transformControls.setSpace('local');
    this.transformControls.setColors(0xb8383b, 0x1f8a4c, 0x3a6ea5, SELECTED_HELPER_COLOR);
    this.transformControls.enabled = false;
    this.transformControls.addEventListener('mouseDown', this.onTransformMouseDown);
    this.transformControls.addEventListener('mouseUp', this.onTransformMouseUp);
    this.transformControls.addEventListener('objectChange', this.onTransformObjectChange);
    // TransformControls reacts to every pointer, so a second finger could jump an active
    // light drag. Its input is routed here, for the gesture's first pointer only.
    const touchAction = this.canvas.style.touchAction;
    this.transformControls.disconnect();
    this.canvas.style.touchAction = touchAction;
    this.canvas.addEventListener('pointerdown', this.onTransformPointerDown);
    this.canvas.addEventListener('pointermove', this.onTransformPointerMove);
    this.canvas.addEventListener('pointerup', this.onTransformPointerUp);
    this.canvas.addEventListener('lostpointercapture', this.onPointerCancel);
    this.root.add(this.lightsRoot, this.helpersRoot);
    this.helpersRoot.add(this.transformControls.getHelper());
    this.helpersRoot.visible = false;
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerCancel);
    window.addEventListener('keydown', this.onKeyDown);
  }

  getSelectedLightId(): string | null {
    return this.selectedLightId;
  }

  setRig(next: CustomLightingRig): void {
    const canUpdateInPlace = next.lights.length === this.rig.lights.length
      && next.lights.every((light, index) => {
        const current = this.rig.lights[index];
        return current?.id === light.id && current.type === light.type;
      });
    this.rig = next;
    if (this.selectedLightId && !this.rig.lights.some((light) => light.id === this.selectedLightId)) {
      this.setSelectedLight(null);
    }
    if (canUpdateInPlace && this.visuals.size === next.lights.length) this.updateVisualsInPlace();
    else this.rebuild();
    this.invalidate();
  }

  private updateVisualsInPlace(): void {
    for (const definition of this.rig.lights) {
      const visual = this.visuals.get(definition.id);
      if (!visual) continue;
      updateCustomLightRuntime(visual.runtime, definition, this.frame);
      visual.sourceHandle.position.copy(visual.runtime.source);
      if (visual.targetHandle && visual.runtime.targetPosition) {
        visual.targetHandle.position.copy(visual.runtime.targetPosition);
      }
    }
    this.updateHelperColors();
  }

  setFrame(frame: Pick<LightingFrame, 'dimensions'> | null): void {
    this.frame = frame;
    this.rebuild();
    this.invalidate();
  }

  setEditorMode(enabled: boolean): void {
    this.editorEnabled = enabled;
    this.helpersRoot.visible = enabled && !this.captureMode;
    if (!enabled) {
      this.targetDrag = null;
      this.sourceTransformInitialRig = null;
      this.sourceTransformChanged = false;
      this.transformControls.detach();
      this.canvas.style.cursor = '';
    }
    this.syncTransformAttachment();
    this.updateTransformControlsState();
    this.invalidate();
  }

  /** Temporarily hide editor-only geometry while rendering a screenshot. */
  setCaptureMode(capturing: boolean): void {
    this.captureMode = capturing;
    this.helpersRoot.visible = this.editorEnabled && !capturing;
    this.updateTransformControlsState();
  }

  setSelectedLight(id: string | null): void {
    const next = id && this.visuals.has(id) ? id : null;
    if (next === this.selectedLightId) return;
    this.selectedLightId = next;
    this.onSelectionChange(next);
    this.syncTransformAttachment();
    this.updateHelperColors();
    this.invalidate();
  }

  /** Return the nearest visible source/target handle under a client point. */
  pick(clientX: number, clientY: number): LightEditorPick | null {
    if (!this.editorEnabled) return null;
    const camera = this.getCamera();
    camera.updateMatrixWorld();
    this.root.updateWorldMatrix(true, true);
    let result: LightEditorPick | null = null;
    let distance = HANDLE_HIT_RADIUS;
    for (const [id, visual] of this.visuals) {
      const source = visual.sourceHandle.getWorldPosition(new THREE.Vector3());
      const sourceDistance = pointDistanceToClient(source, camera, this.canvas, clientX, clientY);
      if (sourceDistance <= distance) {
        result = { id, handle: 'source' };
        distance = sourceDistance;
      }
      if (visual.targetHandle?.visible) {
        const target = visual.targetHandle.getWorldPosition(new THREE.Vector3());
        const targetDistance = pointDistanceToClient(target, camera, this.canvas, clientX, clientY);
        if (targetDistance <= distance) {
          result = { id, handle: 'target' };
          distance = targetDistance;
        }
      }
    }
    return result;
  }

  /** Used by InspectControls to reserve a light drag before camera handling. */
  shouldExcludeCameraPointer(event: PointerEvent): boolean {
    if (!this.editorEnabled || event.button !== 0 || isSecondaryTouch(event)) return false;
    if (this.pick(event.clientX, event.clientY) !== null) return true;
    const camera = this.getCamera();
    this.transformControls.camera = camera;
    this.root.updateWorldMatrix(true, true);
    const ndc = clientToNdc(this.canvas, event.clientX, event.clientY);
    this.transformControls.pointerHover(ndc as unknown as PointerEvent);
    return this.transformControls.axis !== null;
  }

  update(): void {
    if (!this.editorEnabled) return;
    this.syncTransformAttachment();
    const camera = this.getCamera();
    this.transformControls.camera = camera;
    camera.updateMatrixWorld();
    this.root.updateWorldMatrix(true, true);
    for (const visual of this.visuals.values()) {
      if (visual.helper instanceof THREE.PointLightHelper) {
        // PointLightHelper normally borrows the light's world matrix. Ours sits under the
        // editable rig's transformed parent, so it stays in that parent's local space.
        visual.helper.position.copy(visual.runtime.light.position);
      } else if (visual.helper instanceof THREE.SpotLightHelper) visual.helper.update();
      else if (visual.helper instanceof THREE.DirectionalLightHelper) visual.helper.update();
      if (visual.line && visual.targetHandle) {
        const source = visual.sourceHandle.position;
        const target = visual.targetHandle.position;
        visual.line.geometry.setFromPoints([source, target]);
      }
    }
  }

  private beginTargetTransform(pick: LightEditorPick, pointerId: number): boolean {
    const visual = this.visuals.get(pick.id);
    if (!visual?.targetHandle) return false;
    const camera = this.getCamera();
    camera.updateMatrixWorld();
    this.root.updateWorldMatrix(true, true);
    const point = visual.targetHandle.getWorldPosition(new THREE.Vector3());
    const normal = camera.getWorldDirection(new THREE.Vector3()).normalize();
    this.targetDrag = {
      gesture: pick,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, point),
      pointerId,
      initialRig: this.rig,
    };
    return true;
  }

  private updateTargetTransform(clientX: number, clientY: number, pointerId: number): void {
    const drag = this.targetDrag;
    if (!drag || drag.pointerId !== pointerId) return;
    const camera = this.getCamera();
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(clientToNdc(this.canvas, clientX, clientY), camera);
    const point = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3());
    if (!point) return;
    const local = this.root.worldToLocal(point);
    const frameValue = worldPositionToFrame(local, this.frame);
    const current = this.rig.lights.find((light) => light.id === drag.gesture.id);
    if (!current) return;
    const updated = updateDefinition(current, 'target', frameValue);
    if (!updated) return;
    this.replaceLight(updated);
    const visual = this.visuals.get(updated.id);
    if (!visual?.targetHandle || !visual.runtime.targetPosition) return;
    const targetWorld = framePositionToWorld(
      updated.type === 'spot' ? updated.target : frameValue,
      this.frame,
    );
    visual.targetHandle.position.copy(targetWorld);
    visual.runtime.targetPosition.copy(targetWorld);
    if (visual.runtime.target) visual.runtime.target.position.copy(targetWorld);
    if (updated.type === 'directional') {
      const sourceWorld = framePositionToWorld(updated.direction, this.frame).multiplyScalar(-10);
      visual.sourceHandle.position.copy(sourceWorld);
      visual.runtime.light.position.copy(sourceWorld);
      visual.runtime.source.copy(sourceWorld);
    }
    this.invalidate();
  }

  private commitTargetTransform(cancel: boolean): void {
    const drag = this.targetDrag;
    this.targetDrag = null;
    if (!drag) return;
    if (cancel) {
      this.rig = drag.initialRig;
      this.rebuild();
    } else {
      this.onChange(this.rig);
    }
    this.canvas.style.cursor = '';
    this.invalidate();
  }

  private syncTransformAttachment(): void {
    const visual = this.selectedLightId ? this.visuals.get(this.selectedLightId) : null;
    const attachable = visual?.runtime.definition.type === 'point' || visual?.runtime.definition.type === 'spot';
    if (!visual || !attachable || !this.editorEnabled || !this.root.parent) {
      this.transformControls.detach();
      this.updateTransformControlsState();
      return;
    }
    if (this.transformControls.object !== visual.sourceHandle) this.transformControls.attach(visual.sourceHandle);
    this.updateTransformControlsState();
  }

  private updateTransformControlsState(): void {
    this.transformControls.enabled = this.editorEnabled
      && !this.captureMode
      && this.root.parent !== null
      && this.transformControls.object !== undefined;
  }

  private onTransformMouseDown = (): void => {
    if (!this.editorEnabled || !this.transformControls.object) return;
    this.sourceTransformInitialRig = this.rig;
    this.sourceTransformChanged = false;
    this.canvas.style.cursor = 'grabbing';
    this.invalidate();
  };

  private onTransformObjectChange = (): void => {
    if (!this.sourceTransformInitialRig) return;
    const visual = this.selectedLightId ? this.visuals.get(this.selectedLightId) : null;
    if (!visual || (visual.runtime.definition.type !== 'point' && visual.runtime.definition.type !== 'spot')) return;
    const worldPosition = visual.sourceHandle.getWorldPosition(new THREE.Vector3());
    const localPosition = this.root.worldToLocal(worldPosition);
    const framePosition = worldPositionToFrame(localPosition, this.frame);
    const current = this.rig.lights.find((light) => light.id === visual.runtime.definition.id);
    if (!current) return;
    const updated = updateDefinition(current, 'source', framePosition);
    if (!updated || !('position' in updated)) return;
    this.replaceLight(updated);
    const lightPosition = framePositionToWorld(updated.position, this.frame);
    visual.sourceHandle.position.copy(lightPosition);
    visual.runtime.light.position.copy(lightPosition);
    visual.runtime.source.copy(lightPosition);
    this.sourceTransformChanged = true;
    this.invalidate();
  };

  private onTransformMouseUp = (): void => {
    if (!this.sourceTransformInitialRig) return;
    const changed = this.sourceTransformChanged;
    this.sourceTransformInitialRig = null;
    this.sourceTransformChanged = false;
    this.canvas.style.cursor = '';
    if (changed) this.onChange(this.rig);
    this.invalidate();
  };

  private rebuild(): void {
    this.transformControls.detach();
    this.frame = this.frame ?? this.getFrame();
    for (const visual of this.visuals.values()) {
      disposeObjectResources(visual.sourceHandle, false);
      if (visual.targetHandle) disposeObjectResources(visual.targetHandle, false);
      if (visual.helper !== visual.sourceHandle) disposeObjectResources(visual.helper);
      if (visual.line) disposeObjectResources(visual.line);
    }
    this.lightsRoot.clear();
    this.helpersRoot.clear();
    this.helpersRoot.add(this.transformControls.getHelper());
    this.visuals.clear();
    const runtimes = buildCustomLights(this.rig, this.frame);
    for (const runtime of runtimes) {
      this.lightsRoot.add(runtime.light);
      if (runtime.target) this.lightsRoot.add(runtime.target);
      // Object markers keep a viewport-pixel size as the camera moves; a world-space sphere
      // would vanish when a normalized light is several model lengths from the weapon.
      const sourceHandle = new THREE.Points(
        this.markerGeometry,
        new THREE.PointsMaterial({
          color: DEFAULT_HELPER_COLOR,
          size: UNSELECTED_SOURCE_SIZE,
          sizeAttenuation: false,
          transparent: true,
          depthTest: false,
          depthWrite: false,
        }),
      );
      sourceHandle.position.copy(runtime.source);
      sourceHandle.userData = { lightId: runtime.definition.id, handle: 'source' satisfies LightEditorHandle };
      this.helpersRoot.add(sourceHandle);
      let targetHandle: THREE.Points | null = null;
      if (runtime.target && runtime.targetPosition) {
        targetHandle = new THREE.Points(this.markerGeometry, this.aimHandleMaterial.clone());
        targetHandle.position.copy(runtime.targetPosition);
        targetHandle.userData = { lightId: runtime.definition.id, handle: 'target' satisfies LightEditorHandle };
        this.helpersRoot.add(targetHandle);
      }
      let helper: THREE.Object3D;
      if (runtime.light instanceof THREE.PointLight) {
        const pointHelper = new THREE.PointLightHelper(runtime.light, HELPER_SIZE, DEFAULT_HELPER_COLOR);
        // Decouple the helper from light.matrixWorld. Leaving Three.js's
        // shared matrix in place applies customLightRoot's transform twice.
        pointHelper.matrix = new THREE.Matrix4();
        pointHelper.matrixAutoUpdate = true;
        pointHelper.position.copy(runtime.source);
        helper = pointHelper;
      }
      else if (runtime.light instanceof THREE.SpotLight) helper = new THREE.SpotLightHelper(runtime.light, DEFAULT_HELPER_COLOR);
      else if (runtime.light instanceof THREE.DirectionalLight) helper = new THREE.DirectionalLightHelper(runtime.light, HELPER_SIZE * 2, DEFAULT_HELPER_COLOR);
      else helper = new THREE.Object3D();
      this.helpersRoot.add(helper);
      let line: THREE.Line | null = null;
      if (targetHandle) {
        const geometry = new THREE.BufferGeometry().setFromPoints([sourceHandle.position, targetHandle.position]);
        line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: DEFAULT_HELPER_COLOR, transparent: true, opacity: 0.7, depthTest: false }));
        this.helpersRoot.add(line);
      }
      this.visuals.set(runtime.definition.id, { runtime, sourceHandle, targetHandle, helper, line });
    }
    this.helpersRoot.visible = this.editorEnabled && !this.captureMode;
    this.syncTransformAttachment();
    this.updateHelperColors();
  }

  private updateHelperColors(): void {
    for (const [id, visual] of this.visuals) {
      const selected = id === this.selectedLightId;
      const enabled = visual.runtime.definition.enabled;
      const passiveColor = enabled ? DEFAULT_HELPER_COLOR : DISABLED_HELPER_COLOR;

      // Keep every light easy to find, but show its cone and aim handles only when selected;
      // all at once they turn a rig into a web of equally prominent lines.
      visual.sourceHandle.visible = true;
      visual.helper.visible = selected;
      if (visual.targetHandle) {
        visual.targetHandle.visible = selected;
      }
      if (visual.line) visual.line.visible = selected;

      setObjectColor(visual.helper, SELECTED_HELPER_COLOR);
      if (visual.line) setObjectColor(visual.line, SELECTED_HELPER_COLOR);
      if (visual.sourceHandle.material instanceof THREE.PointsMaterial) {
        visual.sourceHandle.material.color.setHex(selected ? HANDLE_COLOR : passiveColor);
        visual.sourceHandle.material.size = selected
          ? SELECTED_SOURCE_SIZE
          : enabled ? UNSELECTED_SOURCE_SIZE : DISABLED_SOURCE_SIZE;
        visual.sourceHandle.material.opacity = selected ? 1 : enabled ? 0.72 : 0.3;
      }
      if (visual.targetHandle?.material instanceof THREE.PointsMaterial) {
        visual.targetHandle.material.color.setHex(HANDLE_COLOR);
        visual.targetHandle.material.transparent = true;
        visual.targetHandle.material.opacity = 1;
      }
    }
  }

  // Mirrors TransformControls' own pointer listeners, gated to one pointer.
  private onTransformPointerDown = (event: PointerEvent): void => {
    if (!this.transformControls.enabled || this.transformPointerId !== null || isSecondaryTouch(event)) return;
    // Owning a pointer requires its capture (Pointer Lock already routes everything here),
    // so a release or lost capture always reaches this canvas and frees the id.
    if (!document.pointerLockElement) {
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
    }
    this.transformPointerId = event.pointerId;
    const pointer = this.transformPointer(event);
    this.transformControls.pointerHover(pointer);
    this.transformControls.pointerDown(pointer);
  };

  private onTransformPointerMove = (event: PointerEvent): void => {
    if (!this.transformControls.enabled) return;
    if (event.pointerType === 'mouse' || event.pointerType === 'pen') this.transformControls.pointerHover(this.transformPointer(event));
    if (event.pointerId === this.transformPointerId) this.transformControls.pointerMove(this.transformPointer(event));
  };

  private onTransformPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.transformPointerId) return;
    this.transformPointerId = null;
    if (!this.transformControls.enabled) return;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
    this.transformControls.pointerUp(this.transformPointer(event));
  };

  // TransformControls reads only NDC x/y and the button from its pointer
  // argument (the origin while the cursor is locked), as its own handlers do.
  private transformPointer(event: PointerEvent): PointerEvent {
    const ndc = document.pointerLockElement ? { x: 0, y: 0 } : clientToNdc(this.canvas, event.clientX, event.clientY);
    return { x: ndc.x, y: ndc.y, button: event.button } as unknown as PointerEvent;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.editorEnabled || event.button !== 0 || isSecondaryTouch(event)) return;
    const pick = this.pick(event.clientX, event.clientY);
    if (!pick) return;
    this.setSelectedLight(pick.id);
    if (pick.handle === 'target' && this.beginTargetTransform(pick, event.pointerId)) {
      this.canvas.setPointerCapture?.(event.pointerId);
      this.canvas.style.cursor = 'grabbing';
    }
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.targetDrag) {
      const hit = this.pick(event.clientX, event.clientY);
      if (hit) this.canvas.style.cursor = 'grab';
      else {
        const ndc = clientToNdc(this.canvas, event.clientX, event.clientY);
        this.transformControls.pointerHover(ndc as unknown as PointerEvent);
        this.canvas.style.cursor = this.transformControls.axis ? 'crosshair' : '';
      }
      return;
    }
    this.updateTargetTransform(event.clientX, event.clientY, event.pointerId);
    event.preventDefault();
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.targetDrag || event.pointerId !== this.targetDrag.pointerId) return;
    this.commitTargetTransform(event.type === 'pointercancel');
    if (this.canvas.hasPointerCapture?.(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  };

  // Shared by pointercancel and lostpointercapture. Only the owning pointer cancels a
  // gesture. Aim drags end on the window's pointerup, so only a real cancel reverts them;
  // a capture released during that pointerup must not.
  private onPointerCancel = (event: PointerEvent): void => {
    if (event.type === 'pointercancel' && this.targetDrag && event.pointerId === this.targetDrag.pointerId) {
      this.commitTargetTransform(true);
    }
    if (event.pointerId !== this.transformPointerId) return;
    this.transformPointerId = null;
    this.revertSourceTransform();
    // TransformControls has no cancel path. End its drag only now, after the
    // restore above, so the mouseUp it may emit cannot commit the moved light.
    this.transformControls.pointerUp(null);
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    if (this.targetDrag) {
      this.commitTargetTransform(true);
      event.preventDefault();
      return;
    }
    if (this.sourceTransformInitialRig) {
      this.revertSourceTransform();
      event.preventDefault();
    }
  };

  /** Restore the rig from before a source-handle drag and drop that drag. */
  private revertSourceTransform(): void {
    const initialRig = this.sourceTransformInitialRig;
    if (!initialRig) return;
    this.transformControls.detach();
    this.rig = initialRig;
    this.sourceTransformInitialRig = null;
    this.sourceTransformChanged = false;
    this.rebuild();
    this.onChange(this.rig);
  }

  private replaceLight(updated: CustomLight): void {
    this.rig = validateCustomLightingRig({
      ...this.rig,
      lights: this.rig.lights.map((light) => light.id === updated.id ? updated : light),
    });
  }

  dispose(): void {
    this.canvas.removeEventListener('pointerdown', this.onTransformPointerDown);
    this.canvas.removeEventListener('pointermove', this.onTransformPointerMove);
    this.canvas.removeEventListener('pointerup', this.onTransformPointerUp);
    this.canvas.removeEventListener('lostpointercapture', this.onPointerCancel);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerCancel);
    window.removeEventListener('keydown', this.onKeyDown);
    this.transformControls.removeEventListener('mouseDown', this.onTransformMouseDown);
    this.transformControls.removeEventListener('mouseUp', this.onTransformMouseUp);
    this.transformControls.removeEventListener('objectChange', this.onTransformObjectChange);
    for (const visual of this.visuals.values()) {
      disposeObjectResources(visual.sourceHandle, false);
      if (visual.targetHandle) disposeObjectResources(visual.targetHandle, false);
      disposeObjectResources(visual.helper);
      if (visual.line) disposeObjectResources(visual.line);
    }
    this.root.remove(this.lightsRoot, this.helpersRoot);
    this.transformControls.dispose();
    this.lightsRoot.clear();
    this.helpersRoot.clear();
    this.markerGeometry.dispose();
    this.aimHandleMaterial.dispose();
    this.aimHandleTexture.dispose();
    this.visuals.clear();
  }
}
