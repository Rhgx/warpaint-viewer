import * as THREE from 'three';

import type { ViewmodelAsset, ViewmodelWeapon } from './firstPerson/firstPerson';
import { getPreset } from './lighting/lighting';
import { LEGACY_PAINTKIT_ICON_LIGHTING_ID } from './lighting/lightingPresetIds';
import {
  CUSTOM_LIGHTING_ID,
  CUSTOM_LIGHT_POSITION_LIMIT,
  createDefaultCustomLightingRig,
  validateCustomLightingRig,
  type CustomLightingRig,
} from './lighting/customLightingModel';
import { LightEditor } from './lighting/lightEditor';
import { loadEditorEnvCube, makeEnvCube } from './env';
import { InspectControls, INSPECT_MAX_DISTANCE_FACTOR } from './inspectControls';
import type { CameraMode } from './inspectControls';
import type { ViewAnglePreset } from './presets';
import { SHEEN_SWEEP_SECONDS, SHEEN_PAUSE_SECONDS, computeSheenFrameData, msUntilNextSheenFrame } from './overlays/sheen';
import { installTf2VertexLit, TF2_VERTEXLIT_CACHE_KEY } from './shaders/vertexlit';
import { createUnusualEffect, setParticlePointScale } from './particles';
import type { UnusualEffect } from './particles';
import type { WeaponAttachment, WeaponMaterial } from '../data/types';
import { joinData } from '../data/loader';
import type { ScreenshotSize } from './capture/capture';
import { computeModelBounds, ModelLoader, type ModelPart } from './modelLoader';
import { CullableGeometry } from './modelCulling';
import { createTf2Uniforms } from './materialConfig';
import type { StickerPlacementQuad } from '../editor/sticker/viewerStickerPlacement';
import type { StickerGizmoTool } from '../editor/sticker/stickerGizmo';
import { visibleStickerEditorMap } from './stickerEditorMap';
import {
  StickerOverlay,
  type GroupStickerPreviewResources,
  type StickerGizmoDrag,
  type StickerGizmoDragResult,
  type StickerPreviewOptions,
} from './overlays/stickerOverlay';
import { GroupOverlays, GROUP_LAYER_OVERLAY_COLORS, type GroupLayerOverlayMap } from './overlays/groupOverlays';
import { ModelPartPicking, type ModelPartPick } from './modelPartPicking';
import { TransformIsolation } from './transformIsolation';
import { SheenOverlay } from './overlays/sheenOverlay';
import { EmissiveOverlay } from './overlays/emissiveOverlay';
import { WeaponAttachments } from './weaponAttachments';
import { FirstPersonStage } from './firstPersonStage';
import { MaterialTextures } from './materialTextures';
import { ViewerCapture, type TurntableOptions, type TurntableSink } from './capture/viewerCapture';

/** Drawing-buffer density cap; phones (often DPR 3) gain little above it. */
const MAX_PIXEL_RATIO = 1.5;

// three.js viewer with TF2's VertexLitGeneric/Skin controls layered onto
// MeshPhongMaterial. InspectControls rotates the model; the camera stays fixed.
export class Viewer {
  showFirstPerson(arms: ViewmodelAsset, weapon: ViewmodelWeapon, team: 'red' | 'blu'): Promise<void> {
    return this.firstPersonStage.showFirstPerson(arms, weapon, team);
  }

  clearFirstPerson(): void {
    this.firstPersonStage.clearFirstPerson();
  }

  get firstPersonHasSpinningBarrel(): boolean { return this.firstPersonStage.hasSpinningBarrel; }

  configureFirstPerson(fov: number, minimized: boolean, animation: string, paused = false, fishPhysics = false, showHands = true, spinBarrel = false): void {
    this.firstPersonStage.configureFirstPerson(fov, minimized, animation, paused, fishPhysics, showHands, spinBarrel);
  }

  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: InspectControls;
  private cameraModeListeners = new Set<(mode: CameraMode) => void>();
  private lightGroup = new THREE.Group();
  private activeLightingPresetId = 'inspect';
  private customLightRoot = new THREE.Group();
  private customLightingRig: CustomLightingRig = createDefaultCustomLightingRig();
  private materialRimLight = 0;
  private lightEditor: LightEditor;
  private lightingEditorActive = false;
  private customLightingListeners = new Set<(rig: CustomLightingRig) => void>();
  private lightSelectionListeners = new Set<(id: string | null) => void>();
  private modelGroup = new THREE.Group(); // rotated/panned by InspectControls
  private centerGroup = new THREE.Group(); // offsets the mesh so its center sits at the origin
  private material: THREE.MeshPhongMaterial;
  private paintableMeshes: THREE.Mesh[] = [];
  private cullableGeometries: CullableGeometry[] = [];
  private lensMaterial = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 0.12,
    metalness: 0,
    transmission: 1,
    thickness: 0.08,
    ior: 1.15,
    normalScale: new THREE.Vector2(0.15, 0.15),
    side: THREE.DoubleSide,
    envMapIntensity: 1,
  });
  private lensNormalTexture: THREE.Texture | null = null;
  private meshes: THREE.Mesh[] = [];
  private envMap: THREE.CubeTexture;
  private editorEnvMap: THREE.CubeTexture;
  private defaultEnvMap: THREE.CubeTexture;
  private mapEnvMap: THREE.CubeTexture | null = null;
  private backplateTexture: THREE.Texture | null = null;
  // Changed in place, so that a capture restoring the scene's background cannot bring back an older theme.
  private readonly stageColor = new THREE.Color(0x1c1f24);
  private backplateLoadToken = 0;
  private environmentLoadToken = 0;
  private envReady: Promise<void>;
  private modelLoader = new ModelLoader();
  private texLoader = new THREE.TextureLoader();
  private materialLoadToken = 0;
  private tf2Uniforms = createTf2Uniforms();
  private transformIsolationContextOpacity = { value: 1 };
  private legacyInspectOpacity = { value: 0 };
  private raf = 0;
  private lastTime = 0;
  private disposed = false;
  /** Another view covers the canvas (the showcase board), so nothing here is drawn. */
  private suspended = false;
  private canvas: HTMLCanvasElement;
  private activeUnusual: UnusualEffect | null = null;
  private unusualId = 'none';
  private unusualWeaponKey = '';
  // Set by frameCamera; reused by setFov to reframe without resetting pose.
  private framedDims: [number, number, number] | null = null;
  private framedRadius = 1;
  private framedScale = 1;
  private framedFixedDistance: number | null = null;
  private framedAuthoredPan: THREE.Vector2 | null = null;
  private perspectiveCenterNdc = new THREE.Vector2();
  private defaultPerspectiveCenterNdc = new THREE.Vector2();
  // Model bounding-box center in geometry space (uncentered), cached so every
  // rebuildUnusualEffect call can use it as a fallback control point.
  private framedCenter = new THREE.Vector3();
  private framedBounds = new THREE.Box3();

  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer = 0;
  // Mobile browsers drop the WebGL context on backgrounding and memory
  // pressure. No frames are scheduled until it is restored.
  private contextLost = false;

  private turntableCapturing = false;
  private sheenWakeTimer = 0;
  private meshIsLens: boolean[] = [];

  // The normal compositor map stays current while the Sticker editor shows the
  // pre-sticker base (see setStickerEditorBaseMap). Keeping them separate stops a
  // late recomposition from overwriting that base with a stale baked sticker.
  private composedMap: THREE.Texture | null = null;
  private stickerEditorBaseMap: THREE.Texture | null = null;

  // Sticker preview decal and transform gizmo; built in the constructor.
  private stickers: StickerOverlay;

  // Built in the constructor, after the material and sticker overlay exist.
  private groupOverlays: GroupOverlays;
  private transformIsolation: TransformIsolation;
  private modelPartPicking: ModelPartPicking;
  private sheenOverlay: SheenOverlay;
  private emissiveOverlay: EmissiveOverlay;
  private weaponAttachments: WeaponAttachments;
  private firstPersonStage: FirstPersonStage;
  private materialTextures: MaterialTextures;
  private viewerCapture: ViewerCapture;

  // Orthographic projection: derived every frame from the perspective camera,
  // which InspectControls always drives.
  private orthoCamera: THREE.OrthographicCamera;
  private projectionMode: 'perspective' | 'orthographic' = 'perspective';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearAlpha(0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.01, 1000);
    this.camera.position.set(4, 2, 5);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, this.camera.near, this.camera.far);

    this.modelGroup.add(this.centerGroup);
    this.scene.add(this.lightGroup);
    this.scene.add(this.modelGroup);

    this.controls = new InspectControls(
      this.camera,
      this.modelGroup,
      canvas,
      () => this.invalidate(),
      (mode) => this.emitCameraModeChange(mode),
    );
    // The SVG gizmo is pointer-transparent; only its true handle hits are reserved
    // here. React owns the transform gesture itself.
    this.controls.setPointerDownExclusion((event) => (
      this.stickers.shouldExcludeCameraPointer(event)
      || this.lightEditor?.shouldExcludeCameraPointer(event) === true
    ));
    this.stickers = new StickerOverlay({
      canvas,
      scene: this.scene,
      centerGroup: this.centerGroup,
      tf2Uniforms: this.tf2Uniforms,
      getPaintableMeshes: () => this.paintableMeshes,
      getMaterialSide: () => this.material.side,
      getActiveProjectionCamera: () => this.getActiveProjectionCamera(),
      invalidate: () => this.invalidate(),
      isDisposed: () => this.disposed,
    });

    this.lightEditor = new LightEditor({
      canvas,
      root: this.customLightRoot,
      getCamera: () => this.projectionMode === 'orthographic' ? this.orthoCamera : this.camera,
      getFrame: () => this.framedDims ? { dimensions: this.framedDims } : null,
      invalidate: () => this.invalidate(),
      onChange: (rig) => {
        this.customLightingRig = rig;
        for (const listener of this.customLightingListeners) listener(rig);
      },
      onSelectionChange: (id) => {
        for (const listener of this.lightSelectionListeners) listener(id);
      },
    });
    this.lightEditor.setRig(this.customLightingRig);

    this.envMap = makeEnvCube(0x9fb8d6, 0x40382c);
    this.editorEnvMap = this.envMap;
    this.defaultEnvMap = this.envMap;
    this.lensMaterial.envMap = this.envMap;
    this.material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      shininess: 30,
      specular: new THREE.Color(0x333333),
      envMap: this.envMap,
      combine: THREE.AddOperation,
      reflectivity: 1,
    });

    this.groupOverlays = new GroupOverlays({
      centerGroup: this.centerGroup,
      getPaintableMeshes: () => this.paintableMeshes,
      getMaterialSide: () => this.material.side,
      invalidate: () => this.invalidate(),
    });
    this.transformIsolation = new TransformIsolation({
      centerGroup: this.centerGroup,
      material: this.material,
      contextOpacity: this.transformIsolationContextOpacity,
      getPaintableMeshes: () => this.paintableMeshes,
      getMaterialLoadToken: () => this.materialLoadToken,
      invalidate: () => this.invalidate(),
    });
    this.modelPartPicking = new ModelPartPicking({
      canvas,
      scene: this.scene,
      centerGroup: this.centerGroup,
      getMeshes: () => this.meshes,
      getCullableGeometries: () => this.cullableGeometries,
      getFramedRadius: () => this.framedRadius,
      getActiveProjectionCamera: () => this.getActiveProjectionCamera(),
      stickers: this.stickers,
      invalidate: () => this.invalidate(),
      isDisposed: () => this.disposed,
    });
    this.sheenOverlay = new SheenOverlay({
      centerGroup: this.centerGroup,
      getMeshes: () => this.meshes,
      getMeshIsLens: () => this.meshIsLens,
      getMaterialSide: () => this.material.side,
      getFirstPerson: () => this.firstPersonStage.preview,
      isDisposed: () => this.disposed,
      invalidate: () => this.invalidate(),
    });
    this.emissiveOverlay = new EmissiveOverlay({
      centerGroup: this.centerGroup,
      renderer: this.renderer,
      texLoader: this.texLoader,
      getMeshes: () => this.meshes,
      getMeshIsLens: () => this.meshIsLens,
      getMaterialSide: () => this.material.side,
      getMaterialLoadToken: () => this.materialLoadToken,
      getFirstPerson: () => this.firstPersonStage.preview,
      isDisposed: () => this.disposed,
      invalidate: () => this.invalidate(),
    });
    this.materialTextures = new MaterialTextures({
      material: this.material,
      tf2Uniforms: this.tf2Uniforms,
      renderer: this.renderer,
      texLoader: this.texLoader,
      emissive: this.emissiveOverlay,
      getEnvReady: () => this.envReady,
      getDefaultEnvMap: () => this.defaultEnvMap,
      setMaterialEnvMap: (texture) => this.setMaterialEnvMap(texture),
      setMaterialRimLight: (value) => { this.materialRimLight = value; },
      syncMaterialRimLight: () => this.syncMaterialRimLight(),
      nextMaterialLoadToken: () => ++this.materialLoadToken,
      getMaterialLoadToken: () => this.materialLoadToken,
      isDisposed: () => this.disposed,
      invalidate: () => this.invalidate(),
    });
    this.weaponAttachments = new WeaponAttachments({
      centerGroup: this.centerGroup,
      texLoader: this.texLoader,
      modelLoader: this.modelLoader,
      invalidate: () => this.invalidate(),
    });
    this.firstPersonStage = new FirstPersonStage({
      canvas,
      renderer: this.renderer,
      scene: this.scene,
      lightGroup: this.lightGroup,
      controls: this.controls,
      material: this.material,
      lensMaterial: this.lensMaterial,
      tf2Uniforms: this.tf2Uniforms,
      getEnvMap: () => this.envMap,
      sheen: this.sheenOverlay,
      emissive: this.emissiveOverlay,
      getActiveUnusual: () => this.activeUnusual,
      isDisposed: () => this.disposed,
      invalidate: () => this.invalidate(),
    });
    this.viewerCapture = new ViewerCapture({
      canvas,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
      orthoCamera: this.orthoCamera,
      centerGroup: this.centerGroup,
      controls: this.controls,
      lightEditor: this.lightEditor,
      firstPersonStage: this.firstPersonStage,
      sheen: this.sheenOverlay,
      emissive: this.emissiveOverlay,
      weaponAttachments: this.weaponAttachments,
      getActiveUnusual: () => this.activeUnusual,
      getProjectionMode: () => this.projectionMode,
      getViewInset: () => this.viewInset,
      applyViewInset: (right, bottom) => this.applyViewInset(right, bottom),
      syncOrthoCamera: () => this.syncOrthoCamera(),
      isContextLost: () => this.contextLost,
      isDisposed: () => this.disposed,
      isTurntableCapturing: () => this.turntableCapturing,
      setTurntableCapturing: (capturing) => { this.turntableCapturing = capturing; },
      invalidate: () => this.invalidate(),
    });
    this.installTf2Shader();

    this.texLoader.loadAsync(joinData('textures/models/workshop/weapons/c_models/c_bazaar_sniper/c_bazaar_sniper_lens.webp')).then((texture) => {
      if (this.disposed) { texture.dispose(); return; }
      texture.colorSpace = THREE.NoColorSpace;
      texture.flipY = false;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      this.lensNormalTexture = texture;
      this.lensMaterial.normalMap = texture;
      this.lensMaterial.needsUpdate = true;
      this.invalidate();
    }).catch(() => {
      console.warn('[warpaint-viewer] Bazaar Bargain lens normal map unavailable; using smooth refraction');
    });

    this.envReady = new Promise<void>((resolve) => {
      loadEditorEnvCube((texture) => {
        if (this.disposed) { texture.dispose(); resolve(); return; }
        const previous = this.editorEnvMap;
        this.editorEnvMap = texture;
        if (previous !== texture && previous !== this.mapEnvMap && previous !== this.materialTextures.customEnvMap) previous.dispose();
        if (!this.mapEnvMap) this.setDefaultEnvMap(texture);
        resolve();
      }, () => {
        console.warn('[warpaint-viewer] TF2 editor cubemap unavailable; using fallback');
        resolve();
      });
    });

    this.setLighting('inspect');

    this.onResize();
    window.addEventListener('resize', this.onResize);
    // Layout reflows (collapsing sections, breakpoint stacking) resize the canvas
    // without a window resize event, so ResizeObserver catches them. Resizing the
    // drawing buffer on every animation frame flickers, so the frame is CSS-scaled
    // during the transition and resized once after it settles.
    let observedInitialSize = false;
    this.resizeObserver = new ResizeObserver(() => {
      this.syncDisplayAspect();
      this.invalidate();
      if (!observedInitialSize) {
        observedInitialSize = true;
        this.onResize();
        return;
      }
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(this.onResize, 240);
    });
    this.resizeObserver.observe(canvas);
    this.lastTime = performance.now();
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.invalidate();
  }

  // Preventing the default is what allows a restore, so do it explicitly here.
  private onContextLost = (event: Event) => {
    event.preventDefault();
    this.contextLost = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    window.clearTimeout(this.sheenWakeTimer);
    this.sheenWakeTimer = 0;
  };

  // three.js recreates programs and render targets lazily. Viewer-owned textures
  // keep their source data, but composed paints come back blank until recomposed.
  private onContextRestored = () => {
    this.contextLost = false;
    this.lastTime = performance.now();
    this.sheenOverlay.resetClock(this.lastTime);
    this.invalidate();
  };

  private onResize = () => {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    // Browser zoom, a move to another display and rotation change the DPR.
    // setPixelRatio resizes the buffer itself, so skip it when unchanged.
    const pixelRatio = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    if (pixelRatio !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, false);
    this.updateBackplateTransform();
    this.syncDisplayAspect();
    this.updateInspectFraming();
    this.invalidate();
  };

  private updateBackplateTransform() {
    const texture = this.backplateTexture;
    if (!texture || !(texture.image instanceof HTMLImageElement)) return;
    const imageAspect = texture.image.naturalWidth / Math.max(1, texture.image.naturalHeight);
    const canvasAspect = (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1);
    const visibleWidth = Math.min(1, canvasAspect / imageAspect);
    const visibleHeight = Math.min(1, imageAspect / canvasAspect);
    texture.repeat.set(visibleWidth, visibleHeight);
    texture.offset.set((1 - visibleWidth) * 0.5, (1 - visibleHeight) * 0.5);
    texture.updateMatrix();
  }

  // Match the projection to the CSS box during panel transitions, so the existing
  // buffer can be CSS-scaled without squeezing the weapon.
  private syncDisplayAspect() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    setParticlePointScale(h * this.renderer.getPixelRatio());
    this.syncOrthoCamera();
  }

  // Schedule a single paint. Animated state calls this again after each frame;
  // a static scene therefore consumes no requestAnimationFrame callbacks.
  private invalidate() {
    window.clearTimeout(this.sheenWakeTimer);
    this.sheenWakeTimer = 0;
    if (this.disposed || this.raf || document.hidden || this.contextLost || this.suspended) return;
    this.raf = requestAnimationFrame(this.renderFrame);
  }

  private onVisibilityChange = () => {
    this.lastTime = performance.now();
    this.sheenOverlay.resetClock(this.lastTime);
    if (document.hidden) {
      window.clearTimeout(this.sheenWakeTimer);
      this.sheenWakeTimer = 0;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    this.invalidate();
  };

  private renderFrame = () => {
    this.raf = 0;
    // A turntable capture owns the scene and steps its animations itself.
    if (this.disposed || document.hidden || this.turntableCapturing || this.suspended) return;
    // Thumbnail viewers share the particle uniform. Restore this drawing buffer's
    // scale before each frame, even when another viewer resized since our last one.
    setParticlePointScale(this.canvas.height);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const controlsAnimating = !this.firstPersonStage.preview && this.controls.update(dt);
    const emissiveAnimating = this.emissiveOverlay.stepEmissive(dt);
    const attachmentsAnimating = !this.firstPersonStage.preview && this.weaponAttachments.stepAttachments(dt);
    if (this.firstPersonStage.preview) {
      this.firstPersonStage.preview.update(dt);
      this.sheenOverlay.updateSheenAnimation();
      if (this.activeUnusual) {
        this.activeUnusual.updateAnchor(this.firstPersonStage.preview.weaponAnchor, this.firstPersonStage.preview.resolveUnusualAnchor);
        this.activeUnusual.update(dt);
      }
      this.firstPersonStage.renderFirstPerson(this.viewInset.right, this.viewInset.bottom);
      this.scheduleNextFrame(this.firstPersonStage.preview.animationPlaying || !!this.activeUnusual || emissiveAnimating, this.firstPersonStage.preview.overlays.sheen);
      return;
    }
    // Inspect lights are authored in camera-local space, so they follow the active
    // camera. Other presets follow model pan but never rotation.
    if (this.activeLightingPresetId === 'inspect') {
      this.lightGroup.position.copy(this.camera.position);
      this.lightGroup.quaternion.copy(this.camera.quaternion);
    } else {
      this.lightGroup.position.copy(this.modelGroup.position);
      // While the rig is being edited it turns with the model, so a drag orbits the
      // whole set. Outside the editor it snaps back to its authored world orientation.
      if (this.activeLightingPresetId === CUSTOM_LIGHTING_ID && this.lightingEditorActive) {
        this.lightGroup.quaternion.copy(this.modelGroup.quaternion);
      } else {
        this.lightGroup.quaternion.identity();
      }
    }
    this.lightEditor.update();
    this.sheenOverlay.updateSheenAnimation();
    if (this.activeUnusual) {
      // Particles simulate in world space, so re-anchor the control points to the
      // weapon's current transform first, as PATTACH_POINT_FOLLOW does in game.
      this.centerGroup.updateWorldMatrix(true, false);
      this.activeUnusual.updateAnchor(this.centerGroup.matrixWorld);
      this.activeUnusual.update(dt);
    }
    this.applyViewInset(this.viewInset.right, this.viewInset.bottom);
    if (!this.shadersReady()) return;
    if (this.projectionMode === 'orthographic') {
      this.syncOrthoCamera();
      this.stickers.updateStickerGizmoOverlay();
      this.renderer.render(this.scene, this.orthoCamera);
    } else {
      this.stickers.updateStickerGizmoOverlay();
      this.renderer.render(this.scene, this.camera);
    }
    this.scheduleNextFrame(!!controlsAnimating || emissiveAnimating || attachmentsAnimating || !!this.activeUnusual, this.sheenOverlay.meshes);
  };

  /**
   * Drawing with a new shader blocks the page until it compiles, the longest stall of a paint's first
   * composite. So a changed material compiles in the background while the last frame stays up, and the frame follows.
   */
  private shadersReady(): boolean {
    const version = [this.material, this.lensMaterial, this.sheenOverlay.material, this.emissiveOverlay.material].map((material) => material?.version ?? 0).join();
    if (version === this.compiledShaders) return true;
    if (!this.compilingShaders) {
      this.compilingShaders = true;
      void this.renderer.compileAsync(this.scene, this.camera).then(() => {
        this.compilingShaders = false;
        this.compiledShaders = version;
        this.invalidate();
      });
    }
    return false;
  }
  private compiledShaders = '';
  private compilingShaders = false;

  private scheduleNextFrame(animated: boolean, sheenMeshes: readonly THREE.Mesh[]): void {
    const sheenActive = this.sheenOverlay.active && sheenMeshes.length > 0;
    const sheenAnimating = sheenActive && sheenMeshes.some((mesh) => mesh.visible);
    // A sweep that is the only animation changes only on its 25 fps frame boundaries.
    // First-person keeps the vsync cadence.
    const sheenOnly = sheenAnimating && !animated && !this.firstPersonStage.preview;
    if (sheenOnly && !this.raf) {
      window.clearTimeout(this.sheenWakeTimer);
      // The clock was sampled before this frame rendered, so the render time counts against the wait.
      const sinceSample = performance.now() - this.sheenOverlay.sampledAt;
      this.sheenWakeTimer = window.setTimeout(() => {
        this.sheenWakeTimer = 0;
        this.invalidate();
      }, Math.max(0, msUntilNextSheenFrame(this.sheenOverlay.elapsed) - sinceSample));
    } else if (animated || sheenAnimating) this.invalidate();
    else if (sheenActive) {
      const cycle = SHEEN_SWEEP_SECONDS + SHEEN_PAUSE_SECONDS;
      this.sheenWakeTimer = window.setTimeout(() => {
        this.sheenWakeTimer = 0;
        this.invalidate();
      }, (cycle - this.sheenOverlay.elapsed % cycle) * 1000);
    }
  }

  // Copies the perspective camera's pose each frame, with a frustum sized to the
  // weapon's view-space depth, which InspectControls supplies.
  private syncOrthoCamera() {
    this.orthoCamera.position.copy(this.camera.position);
    this.orthoCamera.quaternion.copy(this.camera.quaternion);
    const dist = this.controls.getProjectionDistance();
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const halfW = halfH * this.camera.aspect;
    this.orthoCamera.left = -halfW;
    this.orthoCamera.right = halfW;
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.near = this.camera.near;
    this.orthoCamera.far = this.camera.far;
    this.orthoCamera.updateProjectionMatrix();
  }

  /**
   * Live view only: the CSS pixels from the right and bottom edges that a mobile
   * panel covers. Inspect centers the model in the uncovered area; captures ignore it.
   */
  setViewInset(right: number, bottom: number): void {
    if (right === this.viewInset.right && bottom === this.viewInset.bottom) return;
    this.viewInset = { right, bottom };
    this.applyViewInset(right, bottom);
    this.invalidate();
  }
  private viewInset = { right: 0, bottom: 0 };

  // A view offset rather than a pan, so picks and framing stay consistent. Both
  // cameras carry it so switching projection keeps it.
  private applyViewInset(right: number, bottom: number): void {
    // A running turntable owns the view offset; the first live frame reapplies it.
    if (this.turntableCapturing) return;
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    for (const camera of [this.camera, this.orthoCamera]) {
      const view = camera.view?.enabled ? camera.view : null;
      if (right === 0 && bottom === 0) {
        if (view) camera.clearViewOffset();
      } else if (!view || view.fullWidth !== w || view.fullHeight !== h || view.offsetX !== right / 2 || view.offsetY !== bottom / 2) {
        camera.setViewOffset(w, h, right / 2, bottom / 2, w, h);
      }
    }
  }

  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    if (suspended) {
      window.clearTimeout(this.sheenWakeTimer);
      this.sheenWakeTimer = 0;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    this.lastTime = performance.now();
    this.sheenOverlay.resetClock(this.lastTime);
    this.invalidate();
  }

  /** TF2-style inspect auto-spin taking `secondsPerTurn` per revolution, or null to stop. */
  setAutoSpin(secondsPerTurn: number | null) {
    this.controls.setAutoSpin(secondsPerTurn ? (Math.PI * 2) / secondsPerTurn : 0);
    this.invalidate();
  }

  resetView() {
    this.activeUnusual?.notifyTeleport();
    this.controls.reset();
  }

  setAdvancedCameraAvailable(available: boolean): CameraMode {
    return this.controls.setAdvancedCameraAvailable(available);
  }

  /** Give the paint editor Shift + primary-click without disabling inspection. */
  setEditorSelectionActive(active: boolean) {
    this.controls.setEditorSelectionActive(active);
  }

  setLightingEditorState(state: { readonly enabled: boolean; readonly selectedLightId: string | null }): void {
    this.lightingEditorActive = state.enabled;
    this.lightEditor.setEditorMode(state.enabled);
    this.lightEditor.setSelectedLight(state.selectedLightId);
    // Lights are authored out to CUSTOM_LIGHT_POSITION_LIMIT widths, past the normal
    // zoom-out ceiling, so widen the ceiling while the editor is open.
    this.controls.setMaxDistanceFactor(
      state.enabled ? CUSTOM_LIGHT_POSITION_LIMIT + 2 : INSPECT_MAX_DISTANCE_FACTOR,
    );
    // Entering or leaving the editor re-anchors the rig, so the current frame is stale.
    this.invalidate();
  }

  setCustomLighting(value: unknown): void {
    const enteringCustomLighting = this.activeLightingPresetId !== CUSTOM_LIGHTING_ID;
    this.customLightingRig = validateCustomLightingRig(value);
    this.lightEditor.setRig(this.customLightingRig);
    this.activeLightingPresetId = CUSTOM_LIGHTING_ID;
    if (enteringCustomLighting) this.applyCustomLighting();
    else this.applyCustomLightingSettings();
  }

  onCustomLightingChange(listener: (rig: CustomLightingRig) => void): () => void {
    this.customLightingListeners.add(listener);
    listener(this.customLightingRig);
    return () => this.customLightingListeners.delete(listener);
  }

  onLightSelectionChange(listener: (id: string | null) => void): () => void {
    this.lightSelectionListeners.add(listener);
    listener(this.lightEditor.getSelectedLightId());
    return () => this.lightSelectionListeners.delete(listener);
  }

  /**
   * Sticker placement owns primary drags on empty canvas. Middle and right drags
   * still orbit and pan the model.
   */
  setStickerPlacementActive(active: boolean) {
    this.controls.setPrimaryDragMode(active ? 'disabled' : 'rotate');
  }

  /** Subscribe UI to keyboard-initiated and button-initiated mode changes. */
  onCameraModeChange(listener: (mode: CameraMode) => void): () => void {
    this.cameraModeListeners.add(listener);
    listener(this.controls.getCameraMode());
    return () => this.cameraModeListeners.delete(listener);
  }

  private emitCameraModeChange(mode: CameraMode) {
    for (const listener of this.cameraModeListeners) listener(mode);
  }

  ready(): Promise<void> {
    return this.envReady;
  }

  setLighting(presetId: string) {
    if (presetId === CUSTOM_LIGHTING_ID) {
      this.activeLightingPresetId = CUSTOM_LIGHTING_ID;
      this.applyCustomLighting();
      return;
    }
    const preset = getPreset(presetId);
    this.activeLightingPresetId = preset.id;
    this.loadPresetEnvMap(preset.environmentMap);
    this.legacyInspectOpacity.value = preset.id === 'inspect-legacy'
      || preset.id === LEGACY_PAINTKIT_ICON_LIGHTING_ID ? 1 : 0;
    this.syncMaterialRimLight();
    this.lightGroup.position.set(0, 0, 0);
    this.lightGroup.quaternion.identity();
    // Map-lighting transforms are relative to the inspect composition, not to the
    // free-fly camera's current facing.
    const lightingCamera = this.camera.clone();
    lightingCamera.quaternion.copy(this.controls.getInspectQuaternion());
    lightingCamera.updateMatrixWorld();
    this.renderer.toneMappingExposure = preset.exposure ?? 1;
    this.tf2Uniforms.uTf2SpotFalloff.value = preset.spotFalloff ?? 0;
    this.lightGroup.clear();
    for (const l of preset.build(lightingCamera, this.framedDims ? {
      center: this.framedCenter,
      dimensions: this.framedDims,
      bounds: this.framedBounds,
    } : undefined)) {
      this.lightGroup.add(l);
      if (l instanceof THREE.DirectionalLight || l instanceof THREE.SpotLight) this.lightGroup.add(l.target);
    }
    preset.ambientCube.forEach((color, i) => this.tf2Uniforms.uTf2AmbientCube.value[i].copy(color));
    this.tf2Uniforms.uTf2AmbientBasis.value.copy(preset.ambientBasis?.(lightingCamera) ?? new THREE.Matrix3());
    const host = this.canvas.parentElement;
    host?.classList.toggle('has-backplate', Boolean(preset.backplate));
    host?.style.setProperty('--backplate-image', preset.backplate ? `url("${preset.backplate}")` : 'none');
    const backplateToken = ++this.backplateLoadToken;
    this.backplateTexture?.dispose();
    this.backplateTexture = null;
    this.scene.background = preset.background === null ? this.stageColor : new THREE.Color(preset.background);
    if (preset.backplate) {
      this.texLoader.loadAsync(preset.backplate).then((texture) => {
        if (this.disposed || backplateToken !== this.backplateLoadToken) {
          texture.dispose();
          return;
        }
        texture.colorSpace = THREE.SRGBColorSpace;
        this.backplateTexture = texture;
        this.updateBackplateTransform();
        this.scene.background = texture;
        this.scene.backgroundIntensity = 0.78;
        this.invalidate();
      }).catch(() => {
        if (backplateToken === this.backplateLoadToken) {
          console.warn(`[warpaint-viewer] Lighting backplate unavailable: ${preset.backplate}`);
        }
      });
    } else {
      this.scene.backgroundIntensity = 1;
    }
    this.invalidate();
  }

  /** The theme's stage colour. Lighting with a background of its own keeps that. */
  setStageColor(color: string): void {
    this.stageColor.set(color);
    this.invalidate();
  }

  private applyCustomLighting(): void {
    this.loadPresetEnvMap(undefined);
    this.legacyInspectOpacity.value = 0;
    this.lightGroup.position.set(0, 0, 0);
    this.lightGroup.quaternion.identity();
    this.lightGroup.clear();
    this.lightEditor.setFrame(this.framedDims ? { dimensions: this.framedDims } : null);
    this.lightGroup.add(this.customLightRoot);
    this.applyCustomLightingSettings();
    const host = this.canvas.parentElement;
    host?.classList.remove('has-backplate');
    host?.style.removeProperty('--backplate-image');
    this.backplateLoadToken++;
    this.backplateTexture?.dispose();
    this.backplateTexture = null;
    this.scene.background = this.stageColor;
    this.scene.backgroundIntensity = 1;
    this.invalidate();
  }

  private setDefaultEnvMap(texture: THREE.CubeTexture): void {
    this.defaultEnvMap = texture;
    this.lensMaterial.envMap = texture;
    this.lensMaterial.needsUpdate = true;
    if (!this.materialTextures.customEnvMap) this.setMaterialEnvMap(texture);
    else this.invalidate();
  }

  private loadPresetEnvMap(urls: readonly string[] | undefined): void {
    const token = ++this.environmentLoadToken;
    if (!urls) {
      this.mapEnvMap?.dispose();
      this.mapEnvMap = null;
      this.setDefaultEnvMap(this.editorEnvMap);
      return;
    }

    new THREE.CubeTextureLoader().loadAsync([...urls]).then((texture) => {
      if (this.disposed || token !== this.environmentLoadToken) {
        texture.dispose();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      this.mapEnvMap?.dispose();
      this.mapEnvMap = texture;
      this.setDefaultEnvMap(texture);
    }).catch(() => {
      if (this.disposed || token !== this.environmentLoadToken) return;
      this.mapEnvMap?.dispose();
      this.mapEnvMap = null;
      this.setDefaultEnvMap(this.editorEnvMap);
      console.warn('[warpaint-viewer] Map cubemap unavailable; using the editor cubemap');
    });
  }

  private applyCustomLightingSettings(): void {
    this.syncMaterialRimLight();
    this.renderer.toneMappingExposure = this.customLightingRig.exposure;
    this.tf2Uniforms.uTf2SpotFalloff.value = 0;
    for (const color of this.tf2Uniforms.uTf2AmbientCube.value) {
      color.setScalar(this.customLightingRig.ambient);
    }
    this.tf2Uniforms.uTf2AmbientBasis.value.identity();
    this.invalidate();
  }

  private syncMaterialRimLight(): void {
    const enabled = this.activeLightingPresetId === CUSTOM_LIGHTING_ID
      ? this.customLightingRig.cameraRimLight
      : this.activeLightingPresetId === 'inspect'
        || this.activeLightingPresetId === 'inspect-legacy'
        || this.activeLightingPresetId === LEGACY_PAINTKIT_ICON_LIGHTING_ID;
    this.tf2Uniforms.uTf2RimLight.value = enabled ? this.materialRimLight : 0;
  }

  // The compositor result is stored as sRGB, matching Source's output target.
  setMap(texture: THREE.Texture | null) {
    this.composedMap = texture;
    this.applyVisibleMap();
  }

  /**
   * Shows the recipe with one sticker stage removed. setMap() still remembers the
   * composed map, so async commits cannot swap this base out from under the editor.
   */
  setStickerEditorBaseMap(texture: THREE.Texture | null) {
    this.stickerEditorBaseMap = texture;
    this.applyVisibleMap();
  }

  private applyVisibleMap() {
    const map = visibleStickerEditorMap(this.composedMap, this.stickerEditorBaseMap);
    // Swapping one texture for another keeps the shader; only gaining or losing one changes it.
    if (!this.material.map !== !map) this.material.needsUpdate = true;
    this.material.map = map;
    this.invalidate();
  }

  /**
   * Ghost the complete paint and draw the isolated recipe at full strength on
   * only the group buckets addressed by the active layer.
   */
  setTransformIsolation(
    texture: THREE.Texture,
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    buckets: readonly number[],
  ): void {
    this.transformIsolation.setTransformIsolation(texture, pixels, width, height, buckets);
  }

  /** Restore the normal opaque paint after transform isolation. */
  clearTransformIsolation(): void {
    this.transformIsolation.clearTransformIsolation();
  }

  setSheen(sheenId: string, team: 'red' | 'blu') {
    this.sheenOverlay.setSheen(sheenId, team);
  }

  setUnusual(effectId: string, weaponKey: string) {
    this.unusualId = effectId;
    this.unusualWeaponKey = weaponKey;
    this.rebuildUnusualEffect();
  }

  private rebuildUnusualEffect() {
    if (this.activeUnusual) {
      this.scene.remove(this.activeUnusual.object);
      this.activeUnusual.dispose();
      this.activeUnusual = null;
    }
    const effect = createUnusualEffect(this.unusualId, this.framedRadius, this.unusualWeaponKey, this.framedCenter);
    if (!effect) {
      this.invalidate();
      return;
    }
    // Added at the scene root: particles simulate in world space, as in game. The
    // render loop re-anchors control points from centerGroup.matrixWorld each frame.
    this.scene.add(effect.object);
    this.activeUnusual = effect;
    this.invalidate();
  }

  setViewAngle(preset: ViewAnglePreset) {
    this.activeUnusual?.notifyTeleport();
    this.controls.setInteractionLocked(Boolean(preset.lockedCamera));
    this.framedScale = preset.framingScale ?? 1;
    if (preset.cameraAttachment && this.framedDims) {
      const { distance, pan } = this.applyAuthoredCamera(preset.cameraAttachment, Boolean(preset.lockedCamera));
      this.framedFixedDistance = distance;
      this.framedAuthoredPan = pan;
      this.perspectiveCenterNdc.set(0, 0);
      this.controls.setFraming(distance, this.framedRadius, pan);
    } else {
      this.framedFixedDistance = null;
      this.framedAuthoredPan = null;
      this.perspectiveCenterNdc.copy(this.defaultPerspectiveCenterNdc);
      this.controls.setViewDirection(preset.dir ? new THREE.Vector3(...preset.dir) : null);
      this.updateInspectFraming();
    }
    this.rebuildUnusualEffect();
  }

  setProjection(mode: 'perspective' | 'orthographic') {
    this.projectionMode = mode;
    const inspectDistance = this.controls.getInspectDistance();
    this.controls.setDefaultPan(mode === 'perspective'
      ? this.framedAuthoredPan?.clone() ?? this.computePerspectivePan(inspectDistance)
      : new THREE.Vector2());
    this.invalidate();
  }

  setFov(fov: number) {
    this.camera.fov = THREE.MathUtils.clamp(fov, 30, 110);
    this.camera.updateProjectionMatrix();
    this.updateInspectFraming();
    this.invalidate();
  }

  pickWeaponUv(clientX: number, clientY: number): { uv: [number, number]; chartId: number | null } | null {
    return this.stickers.pickWeaponUv(clientX, clientY);
  }

  /** Pick the nearest visible surface or exposed hidden-part outline. */
  pickModelPartAt(clientX: number, clientY: number): ModelPartPick | null {
    return this.modelPartPicking.pickModelPartAt(clientX, clientY);
  }

  setModelPartHover(pick: ModelPartPick | null): void {
    this.modelPartPicking.setModelPartHover(pick);
  }

  toggleModelPart(pick: ModelPartPick): number | null {
    return this.modelPartPicking.toggleModelPart(pick);
  }

  clearModelPartHover(): void {
    this.modelPartPicking.clearModelPartHover();
  }

  restoreHiddenModelParts(): void {
    this.modelPartPicking.restoreHiddenModelParts();
  }

  // Sticker editor support lives in StickerOverlay; these methods keep Viewer's
  // public sticker API.
  moveStickerQuadToClientPoint(
    quad: StickerPlacementQuad,
    clientX: number,
    clientY: number,
  ): StickerPlacementQuad | null {
    return this.stickers.moveStickerQuadToClientPoint(quad, clientX, clientY);
  }

  setStickerGizmo(quad: StickerPlacementQuad | null, tool?: StickerGizmoTool): void {
    this.stickers.setStickerGizmo(quad, tool);
  }

  resetStickerGizmoAnchor(): void {
    this.stickers.resetStickerGizmoAnchor();
  }

  beginStickerGizmoDrag(
    clientX: number,
    clientY: number,
    quad: StickerPlacementQuad,
  ): StickerGizmoDrag | null {
    return this.stickers.beginStickerGizmoDrag(clientX, clientY, quad);
  }

  updateStickerGizmoDrag(
    drag: StickerGizmoDrag,
    clientX: number,
    clientY: number,
    preserveAspect?: boolean,
  ): StickerGizmoDragResult | null {
    return this.stickers.updateStickerGizmoDrag(drag, clientX, clientY, preserveAspect);
  }

  setStickerPreview(
    textureUrl: string | null,
    quad: StickerPlacementQuad | null,
    options?: StickerPreviewOptions,
  ): void {
    this.stickers.setStickerPreview(textureUrl, quad, options);
  }

  setGroupStickerPreview(
    maskUrl: string | null,
    resources: GroupStickerPreviewResources | null,
    quad: StickerPlacementQuad | null,
    options?: StickerPreviewOptions,
  ): void {
    this.stickers.setGroupStickerPreview(maskUrl, resources, quad, options);
  }

  clearStickerPreview(): void {
    this.stickers.clearStickerPreview();
  }

  private getActiveProjectionCamera(): THREE.Camera {
    if (this.projectionMode === 'orthographic') {
      this.syncOrthoCamera();
      return this.orthoCamera;
    }
    return this.camera;
  }

  /**
   * Shows a faint color key for every assigned editor layer. Focused hover and
   * selection feedback is a separate, stronger pass drawn above it.
   */
  setGroupLayerOverlay(maps: readonly GroupLayerOverlayMap[] | null): void {
    this.groupOverlays.setGroupLayerOverlay(maps);
  }

  /** Remove the editor's all-layer surface cue without changing the weapon. */
  clearGroupLayerOverlay(): void {
    this.groupOverlays.clearGroupLayerOverlay();
  }

  /**
   * Overlays one compositor group bucket on the paintable surfaces; `null` pixels
   * or bucket clears it. Pixels are unflipped RGBA; buckets are round(red / 16).
   */
  setGroupHighlight(
    pixels: Uint8Array | Uint8ClampedArray | null,
    width: number,
    height: number,
    bucket: number | null,
    color: readonly [number, number, number] = GROUP_LAYER_OVERLAY_COLORS[0],
  ): void {
    this.groupOverlays.setGroupHighlight(pixels, width, height, bucket, color);
  }

  /** Remove the editor-only group cue without changing the loaded weapon. */
  clearGroupHighlight(): void {
    this.groupOverlays.clearGroupHighlight();
  }

  private updateInspectFraming() {
    if (!this.framedDims) return;
    const dist = this.framedFixedDistance
      ?? this.computeFramingDistance(this.framedDims, this.framedRadius) * this.framedScale;
    const defaultPan = this.projectionMode === 'perspective'
      ? this.framedAuthoredPan?.clone() ?? this.computePerspectivePan(dist)
      : new THREE.Vector2();
    this.controls.rescaleFraming(dist, defaultPan);
  }

  private applyAuthoredCamera(
    cameraAttachment: NonNullable<ViewAnglePreset['cameraAttachment']>,
    preserveAuthoredRoll = false,
  ) {
    const cameraPosition = new THREE.Vector3(...cameraAttachment.position);
    const forward = new THREE.Vector3(...cameraAttachment.forward).normalize();
    const distance = Math.max(
      this.framedRadius,
      new THREE.Vector3().subVectors(this.framedCenter, cameraPosition).dot(forward),
    );
    const authoredTarget = cameraPosition.clone().addScaledVector(forward, distance);
    const centeredModelPosition = this.framedCenter.clone().sub(authoredTarget);
    this.controls.setViewDirection(forward.clone().negate());
    if (preserveAuthoredRoll && cameraAttachment.up) {
      this.camera.up.set(...cameraAttachment.up).normalize();
      this.camera.lookAt(0, 0, 0);
      this.camera.updateMatrixWorld();
    }
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const viewUp = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    return {
      distance,
      pan: new THREE.Vector2(centeredModelPosition.dot(right), centeredModelPosition.dot(viewUp)),
    };
  }

  captureScreenshot(size: number | ScreenshotSize = 2): Promise<Blob> {
    return this.viewerCapture.captureScreenshot(size);
  }

  captureTurntable(options: TurntableOptions, sink: TurntableSink, signal?: AbortSignal): Promise<void> {
    return this.viewerCapture.captureTurntable(options, sink, signal);
  }

  private installTf2Shader() {
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.tf2Uniforms);
      shader.uniforms.uTf2IsolationContextOpacity = this.transformIsolationContextOpacity;
      shader.uniforms.uTf2LegacyInspectOpacity = this.legacyInspectOpacity;
      installTf2VertexLit(shader);
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform float uTf2IsolationContextOpacity;\nuniform float uTf2LegacyInspectOpacity;\nvoid main() {',
        )
        .replace(
          '#include <opaque_fragment>',
          `#include <opaque_fragment>
gl_FragColor.a = uTf2LegacyInspectOpacity > 0.5
  ? uTf2IsolationContextOpacity
  : gl_FragColor.a * uTf2IsolationContextOpacity;`,
        );
    };
    this.material.customProgramCacheKey = () => TF2_VERTEXLIT_CACHE_KEY;
  }

  applyMaterialParams(
    mat: WeaponMaterial,
    resolveTexture: (ref: string) => string | Promise<string> = (ref) => ref,
    resolveCubemap: (ref: string) => Promise<string[] | null> = async () => null,
    cancelled: () => boolean = () => false,
  ): Promise<void> {
    return this.materialTextures.applyMaterialParams(mat, resolveTexture, resolveCubemap, cancelled);
  }

  private setMaterialEnvMap(texture: THREE.CubeTexture): void {
    this.envMap = texture;
    this.material.envMap = texture;
    this.material.needsUpdate = true;
    this.invalidate();
  }

  private currentModelUrl: string | null = null;
  private loadToken = 0;

  private setMeshGeometries(parts: ModelPart[], initialView?: ViewAnglePreset) {
    this.sheenOverlay.teardownSheenMeshes();
    this.emissiveOverlay.teardownEmissiveMeshes();
    this.groupOverlays.teardownMeshes();
    this.clearModelPartHover();
    this.modelPartPicking.teardownModelPartOutlines();
    this.transformIsolation.teardownTransformIsolationMeshes();
    this.stickers.teardownStickerPreviewMeshes();
    for (const mesh of this.meshes) {
      this.centerGroup.remove(mesh);
    }
    for (const cullable of this.cullableGeometries) cullable.dispose();
    this.meshIsLens = parts.map(({ materialName }) => /(?:^|_)lens(?:$|_)/i.test(materialName));
    this.cullableGeometries = parts.map(({ geometry }) => new CullableGeometry(geometry));
    this.meshes = this.cullableGeometries.map(({ geometry }, i) => (
      new THREE.Mesh(geometry, this.meshIsLens[i] ? this.lensMaterial : this.material)
    ));
    // Lens submeshes use a separate, non-warpaint material. Letting editor
    // picking hit them would sample an unrelated point in the group map.
    this.paintableMeshes = this.meshes.filter((_, i) => !this.meshIsLens[i]);
    this.stickers.resetStickerUvTopology();
    this.centerGroup.add(...this.meshes);
    this.frameCamera(this.cullableGeometries.map(({ geometry }) => geometry), initialView);
    if (this.sheenOverlay.active) this.sheenOverlay.rebuildSheenMeshes();
    if (this.emissiveOverlay.enabled) this.emissiveOverlay.rebuildEmissiveMeshes();
    this.groupOverlays.rebuildMeshes();
    this.transformIsolation.rebuildTransformIsolationMeshes();
    this.stickers.rebuildStickerPreviewMeshesIfLoaded();
    this.invalidate();
  }

  private clearModel() {
    this.sheenOverlay.teardownSheenMeshes();
    this.emissiveOverlay.teardownEmissiveMeshes();
    this.stickers.clearStickerPreview();
    this.clearGroupLayerOverlay();
    // A group map belongs to the previous weapon/paint pairing. Do not retain
    // its GPU texture after a failed or explicit model clear.
    this.clearGroupHighlight();
    this.clearModelPartHover();
    this.modelPartPicking.teardownModelPartOutlines();
    this.clearTransformIsolation();
    for (const mesh of this.meshes) {
      this.centerGroup.remove(mesh);
    }
    for (const cullable of this.cullableGeometries) cullable.dispose();
    this.meshes = [];
    this.paintableMeshes = [];
    this.cullableGeometries = [];
    this.weaponAttachments.setAttachments([]);
    this.stickers.resetStickerUvTopology();
    this.meshIsLens = [];
    this.currentModelUrl = null;
    this.invalidate();
  }

  /** Warm parsed geometry without changing meshes, materials, or camera state. */
  async preloadModel(url: string | null): Promise<void> {
    if (url && !this.disposed) await this.modelLoader.load(url, this.currentModelUrl);
  }

  // Load a weapon GLB. Concurrent calls resolve in call order via a token so a
  // stale load never wins; missing models leave the stage empty.
  async loadModel(url: string | null, initialView?: ViewAnglePreset, attachments: readonly WeaponAttachment[] = []): Promise<void> {
    if (url && url === this.currentModelUrl && this.meshes.length > 0) return;
    const token = ++this.loadToken;
    if (!url) {
      this.clearModel();
      return;
    }
    try {
      const geometries = await this.modelLoader.load(url);
      const attached = await this.weaponAttachments.load(attachments);
      if (token !== this.loadToken || this.disposed) {
        this.weaponAttachments.discard(attached);
        return;
      }
      this.setMeshGeometries(geometries, initialView);
      this.weaponAttachments.setAttachments(attached);
      this.currentModelUrl = url;
    } catch (err) {
      if (token !== this.loadToken || this.disposed) return;
      console.warn('[warpaint-viewer] model load failed:', err);
      this.clearModel();
      throw err;
    }
  }

  private frameCamera(geometries: THREE.BufferGeometry[], initialView?: ViewAnglePreset) {
    const { box, center, radius, dimensions: dims } = computeModelBounds(
      geometries.map((geometry) => ({ geometry, materialName: '' })),
    );
    // The inspect pose keeps the longest axis mostly horizontal: fit it against the
    // horizontal fov and the next-largest axis against the vertical one. Fitting
    // everything to the vertical fov frames long weapons too small on wide canvases.
    const framingScale = initialView?.framingScale ?? 1;
    this.framedDims = dims;
    this.framedRadius = radius;
    this.framedScale = framingScale;
    this.framedCenter.copy(center);
    this.framedBounds.copy(box);
    this.lightEditor.setFrame({ dimensions: dims });
    let dist = this.computeFramingDistance(dims, radius) * framingScale;
    let authoredPan: THREE.Vector2 | null = null;
    this.controls.setInteractionLocked(Boolean(initialView?.lockedCamera));

    if (initialView?.cameraAttachment) {
      const authored = this.applyAuthoredCamera(
        initialView.cameraAttachment,
        Boolean(initialView.lockedCamera),
      );
      dist = authored.distance;
      authoredPan = authored.pan;
      this.framedFixedDistance = dist;
      this.framedAuthoredPan = authoredPan;
    } else {
      this.controls.setViewDirection(initialView?.dir ? new THREE.Vector3(...initialView.dir) : null);
      this.framedFixedDistance = null;
      this.framedAuthoredPan = null;
    }

    // Sheen mask placement (CProxyAnimatedWeaponSheen::InitParams) uses the
    // model's raw, uncentered local-space bounding box.
    this.sheenOverlay.setFrameData(computeSheenFrameData(box.min, box.max));

    // Center the mesh at the origin; the controls own modelGroup's transform.
    this.centerGroup.position.set(-center.x, -center.y, -center.z);
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.setFraming(dist, radius, authoredPan ?? new THREE.Vector2());

    if (authoredPan) {
      this.perspectiveCenterNdc.set(0, 0);
      this.defaultPerspectiveCenterNdc.set(0, 0);
      this.rebuildUnusualEffect();
      return;
    }

    // A centered bounding box can still look off-center after perspective (long,
    // deep weapons such as the rocket launcher). Measure the projected vertices and
    // use that visual center as the controls' reset position.
    const projectedMin = new THREE.Vector2(Infinity, Infinity);
    const projectedMax = new THREE.Vector2(-Infinity, -Infinity);
    const point = new THREE.Vector3();
    // Measure in the full canvas; the view inset would otherwise turn into pan.
    this.applyViewInset(0, 0);
    for (const geometry of geometries) {
      const positions = geometry.getAttribute('position');
      if (!positions) continue;
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i).sub(center).project(this.camera);
        projectedMin.x = Math.min(projectedMin.x, point.x);
        projectedMin.y = Math.min(projectedMin.y, point.y);
        projectedMax.x = Math.max(projectedMax.x, point.x);
        projectedMax.y = Math.max(projectedMax.y, point.y);
      }
    }
    this.applyViewInset(this.viewInset.right, this.viewInset.bottom);
    if (Number.isFinite(projectedMin.x)) {
      this.perspectiveCenterNdc.copy(projectedMin.add(projectedMax).multiplyScalar(0.5));
      this.defaultPerspectiveCenterNdc.copy(this.perspectiveCenterNdc);
      const defaultPan = this.projectionMode === 'perspective' ? this.computePerspectivePan(dist) : new THREE.Vector2();
      this.controls.setFraming(dist, radius, defaultPan);
    }
    this.rebuildUnusualEffect();
  }

  private computePerspectivePan(distance = this.camera.position.length()): THREE.Vector2 {
    const vHalf = (this.camera.fov * Math.PI) / 360;
    return new THREE.Vector2(
      -this.perspectiveCenterNdc.x * distance * Math.tan(vHalf) * this.camera.aspect,
      -this.perspectiveCenterNdc.y * distance * Math.tan(vHalf),
    );
  }

  private computeFramingDistance(dims: [number, number, number], radius: number): number {
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * Math.max(1, this.camera.aspect));
    const margin = 1.35; // headroom for the angled default view direction
    return Math.max(
      (dims[0] * 0.5 * margin) / Math.tan(hHalf),
      (dims[1] * 0.5 * margin) / Math.tan(vHalf),
      radius * 1.6, // keep the camera outside the model with room to orbit
    );
  }

  dispose() {
    this.disposed = true;
    this.clearFirstPerson();
    window.clearTimeout(this.sheenWakeTimer);
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    window.clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.parentElement?.classList.remove('has-backplate');
    this.canvas.parentElement?.style.removeProperty('--backplate-image');
    this.controls.dispose();
    this.lightEditor.dispose();
    this.cameraModeListeners.clear();
    this.customLightingListeners.clear();
    this.lightSelectionListeners.clear();
    if (this.activeUnusual) {
      this.scene.remove(this.activeUnusual.object);
      this.activeUnusual.dispose();
      this.activeUnusual = null;
    }
    this.sheenOverlay.teardownSheenMeshes();
    this.stickers.dispose();
    this.clearGroupLayerOverlay();
    this.clearGroupHighlight();
    this.clearModelPartHover();
    this.modelPartPicking.teardownModelPartOutlines();
    this.clearTransformIsolation();
    this.groupOverlays.disposeHighlightMaterial();
    this.sheenOverlay.dispose();
    this.material.dispose();
    this.lensMaterial.dispose();
    this.modelPartPicking.disposeModelPartMaterials();
    this.lensNormalTexture?.dispose();
    this.backplateLoadToken++;
    this.backplateTexture?.dispose();
    this.materialLoadToken++;
    this.materialTextures.disposeTextures();
    this.emissiveOverlay.dispose();
    this.environmentLoadToken++;
    this.materialTextures.customEnvMap?.dispose();
    if (this.mapEnvMap && this.mapEnvMap !== this.defaultEnvMap) this.mapEnvMap.dispose();
    if (this.editorEnvMap !== this.defaultEnvMap && this.editorEnvMap !== this.mapEnvMap) this.editorEnvMap.dispose();
    this.defaultEnvMap.dispose();
    for (const cullable of this.cullableGeometries) cullable.dispose();
    this.cullableGeometries = [];
    this.weaponAttachments.dispose();
    this.modelLoader.dispose();
    this.renderer.dispose();
  }
}
