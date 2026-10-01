import * as THREE from 'three';
import type { FirstPersonPreview, ViewmodelAsset, ViewmodelWeapon } from './firstPerson';
import { getPreset, LEGACY_PAINTKIT_ICON_LIGHTING_ID } from './lighting/lighting';
import {
  CUSTOM_LIGHTING_ID,
  CUSTOM_LIGHT_POSITION_LIMIT,
  createDefaultCustomLightingRig,
  validateCustomLightingRig,
  type CustomLightingRig,
} from './lighting/customLighting';
import { LightEditor } from './lighting/lightEditor';
import { loadEditorEnvCube, makeEnvCube } from './env';
import { InspectControls, INSPECT_MAX_DISTANCE_FACTOR } from './inspectControls';
import type { CameraMode } from './inspectControls';
import { getSheen } from './presets';
import type { ViewAnglePreset } from './presets';
import {
  loadSheenAssets,
  createSheenMaterial,
  computeSheenFrameData,
  SHEEN_SWEEP_SECONDS,
  SHEEN_PAUSE_SECONDS,
  SHEEN_FRAMERATE,
  SHEEN_MASK_FRAMES,
} from './sheen';
import type { SheenAssets, SheenFrameData } from './sheen';
import {
  createEmissiveMaterial,
  configureEmissiveTexture,
  whiteTexture,
  EMISSIVE_DEFAULT_SCROLL,
  EMISSIVE_DEFAULT_STRENGTH,
} from './emissive';
import { installTf2VertexLit, TF2_VERTEXLIT_CACHE_KEY } from './shaders/vertexlit';
import { createUnusualEffect, setParticlePointScale } from './particles';
import type { UnusualEffect } from './particles';
import type { WeaponAttachment, WeaponMaterial } from '../data/types';
import { joinData } from '../data/loader';
import {
  fitScreenshotCapture,
  resolveScreenshotCapture,
  screenshotPixelsToBlob,
  TurntableFrameResolver,
  unionContentBounds,
  type ScreenshotSize,
} from './capture';

export interface TurntableOptions {
  /** Output long edge in pixels. */
  readonly maxEdge: number;
  readonly fps: number;
  /** Duration of one full revolution. */
  readonly seconds: number;
  /** 0xRRGGBB solid background, or null for transparent frames. */
  readonly background: number | null;
  /** Transparency the output format holds (see TurntableFrameResolver). */
  readonly alpha: 'binary' | 'full';
  /** Render palette samples before the frames (GIF needs its palette up front). */
  readonly paletteSamples: boolean;
}

/** A turntable capture stopped on purpose (cancelled, or the scene changed under it). */
export class TurntableStoppedError extends Error {
  override name = 'TurntableStoppedError';
}

/** Receives a turntable capture as it renders. */
export interface TurntableSink {
  /** Called once, before any frame, with the output size and any palette samples. */
  start(info: { width: number; height: number; frames: number; fps: number }, samples: Uint8Array[]): void;
  /** Each output frame in order (ownership passes on); resolves when more may follow. */
  frame(rgba: Uint8Array): Promise<void>;
}
import { computeModelBounds, ModelLoader, type ModelPart } from './modelLoader';
import { CullableGeometry } from './modelCulling';
import { configureTf2Material, createTf2Uniforms, type Tf2Uniforms } from './materialConfig';
import { EDITOR_LAYER_MAP_COLORS } from '../editor/layers/layerMap';
import type { StickerPlacementQuad } from '../editor/sticker/viewerStickerPlacement';
import type { StickerGizmoHandleKind, StickerGizmoTool } from '../editor/sticker/stickerGizmo';
import { visibleStickerEditorMap } from './stickerEditorMap';
import {
  StickerOverlay,
  type GroupStickerPreviewResources,
  type StickerGizmoDrag,
  type StickerGizmoDragResult,
  type StickerGizmoState,
  type StickerPreviewOptions,
} from './stickerOverlay';

/** A single, subtle tint assigned to one compositor group bucket. */
interface GroupLayerOverlayLayer {
  /** Compositor bucket (1..16), rather than the raw 0..255 group-map byte. */
  readonly bucket: number;
  /** Linear RGB channels in the 0..1 range. */
  readonly color: readonly [number, number, number];
}

/**
 * One group-map source used by the editor's all-layer surface cue. A paint can
 * legitimately use more than one groups texture, so the public API accepts a
 * collection rather than silently drawing only the currently active one.
 */
export interface GroupLayerOverlayMap {
  /** Unflipped RGBA pixels, in the same orientation as the composited map. */
  readonly pixels: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly layers: readonly GroupLayerOverlayLayer[];
}

/** The deliberately low-strength opacity used for the all-layer surface cue. */
const GROUP_LAYER_OVERLAY_OPACITY = 0.16;

/** Opacity of the normal paint while a transform layer is isolated. */
const TRANSFORM_ISOLATION_CONTEXT_OPACITY = 0.2;

/**
 * Turntable anti-aliasing, measured on Taxi Cabbed's checkerboard against a
 * 16x + MSAA reference (Oklab error; ~0.02 is one just-noticeable step):
 *   2x + MSAA  99th pct 0.060, 99.9th 0.134 (visible sparkle)
 *   6x + MSAA  99th pct 0.009, 99.9th 0.024
 *   8x + MSAA  99th pct 0.006, 99.9th 0.015
 * With the GPU filter even 8x costs ~12 ms a frame, so GPU memory (samples
 * across the MSAA render target) is the real limit.
 */
const TURNTABLE_MAX_SUPERSAMPLE = 8;
/** ~190 MB of colour + depth samples; 480 px GIFs get 6x + MSAA. */
const TURNTABLE_SAMPLE_BUDGET = 24_000_000;
/** Low-resolution sweep that finds the turntable crop. */
const TURNTABLE_PROBE_EDGE = 320;
const TURNTABLE_PROBE_STEPS = 36;
/** Frames rendered up front to fit the shared GIF palette. */
const TURNTABLE_PALETTE_SAMPLES = 40;
/** Crossfade length hiding the loop seam of time-driven effects. */
const TURNTABLE_SEAM_SECONDS = 0.5;
const TURNTABLE_SEAM_BUDGET_BYTES = 64 * 1024 * 1024;
/** Widest probe frustum, in viewport sizes, before a sweep is clipped. */
const TURNTABLE_MAX_REACH = 27;

/**
 * Distinct but muted default tints for editor layers. The UI may use these for
 * its own swatches and passes the chosen value explicitly to Viewer.
 */
const GROUP_LAYER_OVERLAY_COLORS = EDITOR_LAYER_MAP_COLORS;

export interface ModelPartPick {
  readonly meshIndex: number;
  readonly componentIndex: number;
}

interface GroupLayerOverlayPass {
  texture: THREE.DataTexture;
  material: THREE.ShaderMaterial;
  meshes: THREE.Mesh[];
}

class ModelPartOutline extends THREE.LineSegments {
  readonly pick: ModelPartPick;

  constructor(
    pick: ModelPartPick,
    geometry: THREE.BufferGeometry,
    material: THREE.LineBasicMaterial,
  ) {
    super(geometry, material);
    this.pick = pick;
  }
}

function modelPartLineMaterial(color: number, opacity: number): THREE.LineBasicMaterial {
  return new THREE.LineBasicMaterial({
    color,
    opacity,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
}

function modelPartKey(meshIndex: number, componentIndex: number): string {
  return `${meshIndex}:${componentIndex}`;
}

function modelPartPicksEqual(left: ModelPartPick | null, right: ModelPartPick | null): boolean {
  return left?.meshIndex === right?.meshIndex
    && left?.componentIndex === right?.componentIndex;
}

interface LoadedAttachment {
  meshes: THREE.Mesh[];
  material: THREE.MeshPhongMaterial;
  uniforms: Tf2Uniforms;
}

function disposeAttachment({ material, uniforms }: LoadedAttachment): void {
  material.map?.dispose();
  uniforms.uTf2DetailMap.value?.dispose();
  material.dispose();
}

// three.js viewer with TF2's important VertexLitGeneric/Skin controls layered
// onto MeshPhongMaterial: base-alpha phong mask, exponent/lightwarp textures,
// optional tangent normal, albedo tint, Fresnel, rim light, and env-map mask.
// Interaction is handled by InspectControls (model rotates, camera stays fixed,
// like the in-game inspect panel). The model never moves on its own.
export class Viewer {
  private firstPerson: FirstPersonPreview | null = null;
  private pendingFirstPerson: FirstPersonPreview | null = null;
  private firstPersonToken = 0;

  async showFirstPerson(arms: ViewmodelAsset, weapon: ViewmodelWeapon, team: 'red' | 'blu'): Promise<void> {
    this.clearFirstPerson();
    const token = this.firstPersonToken;
    const { FirstPersonPreview } = await import('./firstPerson');
    if (token !== this.firstPersonToken || this.disposed) return;
    const preview = new FirstPersonPreview();
    this.pendingFirstPerson = preview;
    try {
      await preview.load(arms, weapon, team, this.material, this.lensMaterial, this.tf2Uniforms, this.envMap);
      if (token !== this.firstPersonToken || this.disposed) { preview.dispose(); return; }
      this.pendingFirstPerson = null;
      this.firstPerson = preview;
      this.scene.add(preview.root);
      preview.setOverlay('sheen', this.sheenId !== 'none' ? this.sheenMaterial : null);
      preview.setOverlay('emissive', this.emissiveEnabled ? this.emissiveMaterial : null);
      this.activeUnusual?.notifyTeleport();
      this.controls.setPreviewActive(true);
      this.invalidate();
    } catch (error) {
      preview.dispose();
      if (this.pendingFirstPerson === preview) this.pendingFirstPerson = null;
      throw error;
    }
  }

  clearFirstPerson(): void {
    this.firstPersonToken++;
    this.pendingFirstPerson?.dispose();
    this.pendingFirstPerson = null;
    this.firstPerson?.dispose();
    this.firstPerson = null;
    this.activeUnusual?.notifyTeleport();
    this.controls.setPreviewActive(false);
    this.invalidate();
  }

  get firstPersonHasSpinningBarrel(): boolean { return this.firstPerson?.hasSpinningBarrel ?? false; }

  configureFirstPerson(fov: number, minimized: boolean, animation: string, paused = false, fishPhysics = false, showHands = true, spinBarrel = false): void {
    this.activeUnusual?.notifyTeleport();
    this.firstPerson?.setPlayback(paused, fishPhysics);
    this.firstPerson?.setAppearance(showHands, spinBarrel);
    this.firstPerson?.setView(fov, minimized);
    this.firstPerson?.setAnimation(animation);
    this.invalidate();
  }

  private previewChildren: THREE.Object3D[] = [];
  private previewVisibility: boolean[] = [];
  private previewLightPosition = new THREE.Vector3();
  private previewLightRotation = new THREE.Quaternion();

  private renderFirstPerson(): void {
    const preview = this.firstPerson;
    if (!preview) return;
    const aspect = (this.canvas.clientWidth || 1) / (this.canvas.clientHeight || 1);
    if (preview.camera.aspect !== aspect) {
      preview.camera.aspect = aspect;
      preview.camera.updateProjectionMatrix();
    }
    const visibility = this.previewVisibility;
    const children = this.previewChildren;
    this.previewLightPosition.copy(this.lightGroup.position);
    this.previewLightRotation.copy(this.lightGroup.quaternion);
    try {
      // Particles stay at the scene root so they can trail the animated attachment.
      for (let i = 0; i < this.scene.children.length; i++) {
        const child = this.scene.children[i];
        children[i] = child;
        visibility[i] = child.visible;
        child.visible = child === preview.root || child === this.lightGroup || child === this.activeUnusual?.object;
      }
      this.sheenMaterial?.uniforms.uSheenModelTransform.value.copy(preview.weaponBindInverse);
      this.lightGroup.position.set(0, 0, 0);
      this.lightGroup.quaternion.identity();
      this.renderer.render(this.scene, preview.camera);
    } finally {
      this.sheenMaterial?.uniforms.uSheenModelTransform.value.identity();
      for (let i = 0; i < children.length; i++) children[i].visible = visibility[i];
      children.length = 0;
      this.lightGroup.position.copy(this.previewLightPosition);
      this.lightGroup.quaternion.copy(this.previewLightRotation);
    }
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
  private raycaster = new THREE.Raycaster();
  private pickNdc = new THREE.Vector2();
  private paintableMeshes: THREE.Mesh[] = [];
  private cullableGeometries: CullableGeometry[] = [];
  private modelPartOutlines = new Map<string, ModelPartOutline>();
  private modelPartHover: ModelPartPick | null = null;
  private modelPartHoverMesh: THREE.Mesh | null = null;
  private modelPartOutlineMaterial = modelPartLineMaterial(0x8fb6ff, 0.42);
  private modelPartOutlineHoverMaterial = modelPartLineMaterial(0xd9e7ff, 0.96);
  private modelPartHoverMaterial = new THREE.MeshBasicMaterial({
    color: 0x8fb6ff,
    transparent: true,
    opacity: 0.2,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
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
  private customEnvMap: THREE.CubeTexture | null = null;
  private backplateTexture: THREE.Texture | null = null;
  private backplateLoadToken = 0;
  private environmentLoadToken = 0;
  private envReady: Promise<void>;
  private modelLoader = new ModelLoader();
  private texLoader = new THREE.TextureLoader();
  private normalTexture: THREE.Texture | null = null;
  private exponentTexture: THREE.Texture | null = null;
  private lightwarpTexture: THREE.Texture | null = null;
  private selfIllumTexture: THREE.Texture | null = null;
  private detailTexture: THREE.Texture | null = null;
  private materialLoadToken = 0;
  private tf2Uniforms = createTf2Uniforms();
  private transformIsolationContextOpacity = { value: 1 };
  private legacyInspectOpacity = { value: 0 };
  private raf = 0;
  private lastTime = 0;
  private disposed = false;
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
  // Model bounding-box center in GEOMETRY space (raw, uncentered), cached so
  // every rebuildUnusualEffect call (including setUnusual between model
  // loads) can pass a fallback control point without re-deriving it.
  private framedCenter = new THREE.Vector3();
  private framedBounds = new THREE.Box3();

  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer = 0;

  // Killstreak sheen: a shared second-pass material over per-mesh clones of
  // the weapon geometry. Assets/material are created lazily on first enable
  // and kept for this Viewer's lifetime.
  private sheenId = 'none';
  private sheenTeam: 'red' | 'blu' = 'red';
  private sheenAssets: SheenAssets | null = null;
  private sheenAssetsPromise: Promise<SheenAssets> | null = null;
  private sheenMaterial: THREE.ShaderMaterial | null = null;
  private sheenMeshes: THREE.Mesh[] = [];
  private sheenElapsed = 0;
  private turntableCapturing = false;
  private sheenLastTime = performance.now();
  private sheenWakeTimer = 0;
  private sheenFrameData: SheenFrameData = { scaleX: 1, offsetX: 0, scaleY: 1, offsetY: 0, sweepAxis: 0, sideAxis: 1 };
  private meshIsLens: boolean[] = [];

  // Editor surface cue: a small transparent pass that reads the CPU-decoded
  // groups texture. It intentionally uses the exact bucket comparison used by
  // the compositor, so what is highlighted is what a selector addresses.
  private groupHighlightTexture: THREE.DataTexture | null = null;
  private groupHighlightMaterial: THREE.ShaderMaterial | null = null;
  private groupHighlightMeshes: THREE.Mesh[] = [];

  // Editor surface cue for understanding the current layer assignment. Unlike
  // the focused highlight above, this may contain every assigned layer (and
  // every distinct group-map source) at once. It deliberately remains a
  // separate pass so it never changes the composed war-paint texture.
  private groupLayerOverlayPasses: GroupLayerOverlayPass[] = [];

  // Transform isolation keeps the complete paint as a translucent context
  // pass, then redraws only the selected groups with the isolated recipe.
  private transformIsolationMaskTexture: THREE.DataTexture | null = null;
  private transformIsolationSource: {
    pixels: Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
    buckets: string;
    materialToken: number;
  } | null = null;
  private transformIsolationMaterial: THREE.MeshPhongMaterial | null = null;
  private transformIsolationMeshes: THREE.Mesh[] = [];
  private transformIsolationBaseState: {
    readonly opacity: number;
    readonly transparent: boolean;
    readonly depthWrite: boolean;
  } | null = null;

  // The normal compositor map remains current even while the Sticker editor
  // temporarily shows the exact pre-sticker surface below its live decal.
  // Keeping these as separate sources prevents a late normal recomposition
  // from overwriting the editor base and exposing a stale baked sticker.
  private composedMap: THREE.Texture | null = null;
  private stickerEditorBaseMap: THREE.Texture | null = null;

  // Sticker preview decal and transform gizmo; built in the constructor.
  private stickers: StickerOverlay;

  // $EmissiveBlend pass: like the sheen, a second material over per-mesh
  // clones of the weapon geometry, created on demand by an imported material.
  private emissiveMaterial: THREE.ShaderMaterial | null = null;
  private emissiveMeshes: THREE.Mesh[] = [];
  private emissiveTextures: THREE.Texture[] = [];
  private emissiveEnabled = false;
  private emissiveElapsed = 0;

  // Orthographic projection: derived every frame from the perspective camera,
  // which InspectControls always drives.
  private orthoCamera: THREE.OrthographicCamera;
  private projectionMode: 'perspective' | 'orthographic' = 'perspective';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearAlpha(0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
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
    // The SVG gizmo stays pointer-transparent so it shares the canvas
    // coordinate space. Reserve only its true handle hits at the native
    // inspect-control layer; React owns the transform gesture itself.
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
        if (previous !== texture && previous !== this.mapEnvMap && previous !== this.customEnvMap) previous.dispose();
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
    // The canvas also changes size when the app's layout reflows (inspector
    // sections collapsing, responsive breakpoint stacking) without a window
    // resize event; ResizeObserver catches that directly on the element.
    // Layout panels animate their width/height. Resizing the WebGL drawing
    // buffer on every animation frame causes visible clears and flicker, so
    // keep the existing frame CSS-scaled during the short transition and do
    // one real renderer resize after the layout has settled.
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
    this.invalidate();
  }

  private onResize = () => {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
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

  // Keep projection matched to the CSS box while a panel transition changes
  // its aspect ratio. The existing drawing buffer can then be CSS-scaled
  // briefly without making the weapon look squeezed or stretched.
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
    if (this.disposed || this.raf || document.hidden) return;
    this.raf = requestAnimationFrame(this.renderFrame);
  }

  private onVisibilityChange = () => {
    this.lastTime = performance.now();
    this.sheenLastTime = this.lastTime;
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
    if (this.disposed || document.hidden || this.turntableCapturing) return;
    // Thumbnail viewers share the particle uniform. Restore this drawing buffer's
    // scale before each frame, even when another viewer resized since our last one.
    setParticlePointScale(this.canvas.height);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const controlsAnimating = !this.firstPerson && this.controls.update(dt);
    const emissiveAnimating = this.stepEmissive(dt);
    const attachmentsAnimating = !this.firstPerson && this.stepAttachments(dt);
    if (this.firstPerson) {
      this.firstPerson.update(dt);
      this.updateSheenAnimation();
      if (this.activeUnusual) {
        this.activeUnusual.updateAnchor(this.firstPerson.weaponAnchor, this.firstPerson.resolveUnusualAnchor);
        this.activeUnusual.update(dt);
      }
      this.renderFirstPerson();
      this.scheduleNextFrame(this.firstPerson.animationPlaying || !!this.activeUnusual || emissiveAnimating, this.firstPerson.overlays.sheen);
      return;
    }
    // Inspect lights are authored in camera-local panel space, so follow the
    // active camera through zoom and advanced-camera movement. Other presets
    // retain the existing map behavior: follow model pan, never rotation.
    if (this.activeLightingPresetId === 'inspect') {
      this.lightGroup.position.copy(this.camera.position);
      this.lightGroup.quaternion.copy(this.camera.quaternion);
    } else {
      this.lightGroup.position.copy(this.modelGroup.position);
      // While the rig is being edited, carry it through the model's rotation so
      // a drag orbits the whole set instead of spinning the weapon under fixed
      // lights; that is the only way to get around the rig and see where a
      // light actually sits. Outside the editor the rig snaps back to its
      // authored world orientation and the model turns under it as before.
      if (this.activeLightingPresetId === CUSTOM_LIGHTING_ID && this.lightingEditorActive) {
        this.lightGroup.quaternion.copy(this.modelGroup.quaternion);
      } else {
        this.lightGroup.quaternion.identity();
      }
    }
    this.lightEditor.update();
    this.updateSheenAnimation();
    if (this.activeUnusual) {
      // Particles simulate in world space; re-anchor the control points to
      // the weapon's current transform first so they follow the model the way
      // PATTACH_POINT_FOLLOW attachments do in game.
      this.centerGroup.updateWorldMatrix(true, false);
      this.activeUnusual.updateAnchor(this.centerGroup.matrixWorld);
      this.activeUnusual.update(dt);
    }
    if (this.projectionMode === 'orthographic') {
      this.syncOrthoCamera();
      this.stickers.updateStickerGizmoOverlay();
      this.renderer.render(this.scene, this.orthoCamera);
    } else {
      this.stickers.updateStickerGizmoOverlay();
      this.renderer.render(this.scene, this.camera);
    }
    this.scheduleNextFrame(!!controlsAnimating || emissiveAnimating || attachmentsAnimating || !!this.activeUnusual, this.sheenMeshes);
  };

  // The pass reads $time, which only moves the picture when the scroll vector
  // is non-zero. Wrapped so a long session cannot drift the sample out of the
  // range where float precision still resolves texels.
  private stepEmissive(dt: number): boolean {
    const scroll: THREE.Vector2 | undefined = this.emissiveMaterial?.uniforms.uEmissiveScroll.value;
    const animating = this.emissiveEnabled && !!scroll && scroll.lengthSq() > 0;
    if (animating && this.emissiveMaterial) {
      const period = Math.max(1 / Math.max(Math.abs(scroll.x), Math.abs(scroll.y)), 1);
      this.emissiveElapsed = (this.emissiveElapsed + dt) % period;
      this.emissiveMaterial.uniforms.uEmissiveTime.value = this.emissiveElapsed;
    }
    return animating;
  }

  private scheduleNextFrame(animated: boolean, sheenMeshes: readonly THREE.Mesh[]): void {
    const sheenActive = this.sheenId !== 'none' && this.sheenMaterial !== null && sheenMeshes.length > 0;
    const sheenAnimating = sheenActive && sheenMeshes.some((mesh) => mesh.visible);
    if (animated || sheenAnimating) this.invalidate();
    else if (sheenActive) {
      const cycle = SHEEN_SWEEP_SECONDS + SHEEN_PAUSE_SECONDS;
      this.sheenWakeTimer = window.setTimeout(() => {
        this.sheenWakeTimer = 0;
        this.invalidate();
      }, (cycle - this.sheenElapsed % cycle) * 1000);
    }
  }

  // Derives the ortho camera from the perspective camera every frame: same
  // position/orientation, with a frustum sized to match the apparent scale at
  // the weapon's current view-space depth. InspectControls supplies that depth
  // for both its fixed-ray inspect view and its free-flying advanced view.
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

  /** TF2-style inspect auto-spin taking `secondsPerTurn` per revolution, or null to stop. */
  setAutoSpin(secondsPerTurn: number | null) {
    this.controls.setAutoSpin(secondsPerTurn ? (Math.PI * 2) / secondsPerTurn : 0);
    this.invalidate();
  }

  resetView() {
    this.activeUnusual?.notifyTeleport();
    this.controls.reset();
  }

  /** Current interaction mode. Advanced mode can also be toggled with Alt. */
  getCameraMode(): CameraMode {
    return this.controls.getCameraMode();
  }

  toggleAdvancedCamera(): CameraMode {
    return this.controls.toggleAdvancedCamera();
  }

  setAdvancedCamera(enabled: boolean): CameraMode {
    return this.controls.setAdvancedCamera(enabled);
  }

  /** Configure Advanced Camera availability for a contextual interaction. */
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
    // Light sources are authored out to CUSTOM_LIGHT_POSITION_LIMIT model
    // widths, well past the inspect view's normal zoom-out ceiling, so a light
    // dragged out there would otherwise be off screen and out of reach. Widen
    // the ceiling while the editor is open and restore it on the way out.
    this.controls.setMaxDistanceFactor(
      state.enabled ? CUSTOM_LIGHT_POSITION_LIMIT + 2 : INSPECT_MAX_DISTANCE_FACTOR,
    );
    // Entering or leaving the editor re-anchors the rig, so the frame it is
    // currently showing is already stale.
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
   * Sticker placement owns empty-canvas primary drags. Middle drag remains an
   * intentional inspect orbit and right drag continues to pan the model.
   */
  setStickerPlacementActive(active: boolean) {
    this.controls.setPrimaryDragMode(active ? 'disabled' : 'rotate');
  }

  /** Lock or restore all direct camera interaction. */
  setCameraInteractionLocked(locked: boolean) {
    this.controls.setInteractionLocked(locked);
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
    // Map-lighting transforms are relative to the inspect composition, not to
    // whichever direction the free-fly camera happens to face when selected.
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
    this.scene.background = new THREE.Color(preset.background);
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
    this.scene.background = new THREE.Color(0x1c1f24);
    this.scene.backgroundIntensity = 1;
    this.invalidate();
  }

  private setDefaultEnvMap(texture: THREE.CubeTexture): void {
    this.defaultEnvMap = texture;
    this.lensMaterial.envMap = texture;
    this.lensMaterial.needsUpdate = true;
    if (!this.customEnvMap) this.setMaterialEnvMap(texture);
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
   * Temporarily draw an exact recipe with one sticker stage removed. The
   * normal composed map is still remembered by setMap(), so asynchronous
   * commits cannot replace this base underneath a live editor overlay.
   */
  setStickerEditorBaseMap(texture: THREE.Texture | null) {
    this.stickerEditorBaseMap = texture;
    this.applyVisibleMap();
  }

  private applyVisibleMap() {
    const map = visibleStickerEditorMap(this.composedMap, this.stickerEditorBaseMap);
    if (this.material.map !== map) {
      this.material.map = map;
      this.material.needsUpdate = true;
    }
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
    if (!Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0
      || pixels.length < width * height * 4
      || buckets.length === 0
      || buckets.some((bucket) => !Number.isInteger(bucket) || bucket < 1 || bucket > 16)) {
      this.clearTransformIsolation();
      return;
    }

    const bucketKey = buckets.join(',');
    const prior = this.transformIsolationSource;
    if (this.transformIsolationMaterial && prior?.pixels === pixels
      && prior.width === width && prior.height === height && prior.buckets === bucketKey
      && prior.materialToken === this.materialLoadToken) {
      this.transformIsolationMaterial.map = texture;
      this.invalidate();
      return;
    }
    const selectedBuckets = new Set(buckets);
    const maskData = new Uint8Array(width * height * 4);
    for (let sourceOffset = 0, targetOffset = 0; targetOffset < maskData.length; sourceOffset += 4, targetOffset += 4) {
      const bucket = Math.floor(pixels[sourceOffset] / 16 + 0.5);
      const selected = selectedBuckets.has(bucket) ? 255 : 0;
      maskData[targetOffset] = selected;
      maskData[targetOffset + 1] = selected;
      maskData[targetOffset + 2] = selected;
      maskData[targetOffset + 3] = 255;
    }
    const mask = new THREE.DataTexture(maskData, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    mask.colorSpace = THREE.NoColorSpace;
    mask.flipY = false;
    mask.generateMipmaps = false;
    mask.magFilter = THREE.NearestFilter;
    mask.minFilter = THREE.NearestFilter;
    mask.wrapS = THREE.ClampToEdgeWrapping;
    mask.wrapT = THREE.ClampToEdgeWrapping;
    mask.needsUpdate = true;

    this.applyTransformIsolation(texture, mask);
    this.transformIsolationSource = { pixels, width, height, buckets: bucketKey, materialToken: this.materialLoadToken };
  }

  private applyTransformIsolation(texture: THREE.Texture, mask: THREE.DataTexture): void {
    this.teardownTransformIsolationPass();
    if (!this.transformIsolationBaseState) {
      this.transformIsolationBaseState = {
        opacity: this.material.opacity,
        transparent: this.material.transparent,
        depthWrite: this.material.depthWrite,
      };
    }
    this.transformIsolationContextOpacity.value = TRANSFORM_ISOLATION_CONTEXT_OPACITY;
    this.material.transparent = true;
    this.material.depthWrite = true;
    this.material.needsUpdate = true;
    this.transformIsolationMaskTexture = mask;

    const material = this.material.clone();
    material.map = texture;
    // Sample the editor mask with the model's raw UVs. Three's alphaMap path
    // can inherit a different UV transform/channel from the weapon material,
    // which makes paintkit_tool treat a partial group mask as full-surface.
    material.alphaMap = null;
    material.alphaTest = 0;
    material.opacity = 1;
    material.transparent = false;
    material.depthWrite = true;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
    const compileTf2Material = this.material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      compileTf2Material(shader, renderer);
      shader.uniforms.uTf2IsolationContextOpacity = { value: 1 };
      shader.uniforms.uTf2IsolationMask = { value: mask };
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec2 vTf2IsolationUv;\nvoid main() {')
        .replace('void main() {', 'void main() {\n  vTf2IsolationUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform sampler2D uTf2IsolationMask;\nvarying vec2 vTf2IsolationUv;\nvoid main() {',
        )
        .replace(
          'if ( uTf2AlphaTestRef > 0.0 && diffuseColor.a < uTf2AlphaTestRef ) discard;',
          `if ( uTf2AlphaTestRef > 0.0 && diffuseColor.a < uTf2AlphaTestRef ) discard;
  if ( texture2D( uTf2IsolationMask, vTf2IsolationUv ).r < 0.5 ) discard;`,
        );
    };
    material.customProgramCacheKey = () => `${TF2_VERTEXLIT_CACHE_KEY}:transform-isolation`;
    material.needsUpdate = true;

    this.transformIsolationMaterial = material;
    this.rebuildTransformIsolationMeshes();
    this.invalidate();
  }

  /** Restore the normal opaque paint after transform isolation. */
  clearTransformIsolation(): void {
    this.teardownTransformIsolationPass();
    if (this.transformIsolationBaseState) {
      this.material.opacity = this.transformIsolationBaseState.opacity;
      this.material.transparent = this.transformIsolationBaseState.transparent;
      this.material.depthWrite = this.transformIsolationBaseState.depthWrite;
      this.transformIsolationContextOpacity.value = 1;
      this.material.needsUpdate = true;
      this.transformIsolationBaseState = null;
    }
    this.invalidate();
  }

  private rebuildTransformIsolationMeshes(): void {
    this.teardownTransformIsolationMeshes();
    if (!this.transformIsolationMaterial) return;
    for (const mesh of this.paintableMeshes) {
      const isolated = new THREE.Mesh(mesh.geometry, this.transformIsolationMaterial);
      isolated.renderOrder = 3;
      this.centerGroup.add(isolated);
      this.transformIsolationMeshes.push(isolated);
    }
  }

  private teardownTransformIsolationMeshes(): void {
    for (const mesh of this.transformIsolationMeshes) this.centerGroup.remove(mesh);
    this.transformIsolationMeshes = [];
  }

  private teardownTransformIsolationPass(): void {
    this.transformIsolationSource = null;
    this.teardownTransformIsolationMeshes();
    this.transformIsolationMaterial?.dispose();
    this.transformIsolationMaterial = null;
    this.transformIsolationMaskTexture?.dispose();
    this.transformIsolationMaskTexture = null;
  }

  setSheen(sheenId: string, team: 'red' | 'blu') {
    const wasOff = this.sheenId === 'none';
    this.sheenId = sheenId;
    this.sheenTeam = team;
    this.invalidate();
    if (sheenId === 'none') {
      this.teardownSheenMeshes();
      return;
    }
    if (wasOff) {
      this.sheenElapsed = 0;
      this.sheenLastTime = performance.now();
    }
    void this.ensureSheenReady().then(() => {
      if (this.disposed || this.sheenId === 'none') return;
      this.rebuildSheenMeshes();
      this.invalidate();
    });
  }

  private ensureSheenReady(): Promise<void> {
    if (this.sheenAssets) return Promise.resolve();
    if (!this.sheenAssetsPromise) {
      this.sheenAssetsPromise = loadSheenAssets().catch((err) => {
        console.warn('[warpaint-viewer] killstreak sheen assets unavailable; sheen disabled:', err);
        this.sheenAssetsPromise = null;
        throw err;
      });
    }
    return this.sheenAssetsPromise
      .then((assets) => {
        if (this.disposed) return;
        this.sheenAssets = assets;
        this.sheenMaterial = createSheenMaterial(assets, this.material.side);
      })
      .catch(() => undefined);
  }

  private teardownSheenMeshes() {
    this.firstPerson?.setOverlay('sheen', null);
    for (const mesh of this.sheenMeshes) this.centerGroup.remove(mesh);
    this.sheenMeshes = [];
  }

  private rebuildSheenMeshes() {
    this.teardownSheenMeshes();
    if (this.sheenId === 'none' || !this.sheenMaterial) return;
    this.firstPerson?.setOverlay('sheen', this.sheenMaterial);
    for (let i = 0; i < this.meshes.length; i++) {
      if (this.meshIsLens[i]) continue;
      const mesh = new THREE.Mesh(this.meshes[i].geometry, this.sheenMaterial);
      mesh.renderOrder = 1;
      this.centerGroup.add(mesh);
      this.sheenMeshes.push(mesh);
    }
    this.updateSheenFrameUniforms();
    this.updateSheenTint();
  }

  private updateSheenFrameUniforms() {
    if (!this.sheenMaterial) return;
    const u = this.sheenMaterial.uniforms;
    u.uMaskScale.value.set(this.sheenFrameData.scaleX, this.sheenFrameData.scaleY);
    u.uMaskOffset.value.set(this.sheenFrameData.offsetX, this.sheenFrameData.offsetY);
    u.uSweepAxis.value = this.sheenFrameData.sweepAxis;
    u.uSideAxis.value = this.sheenFrameData.sideAxis;
  }

  private updateSheenTint() {
    if (!this.sheenMaterial) return;
    const preset = getSheen(this.sheenId);
    const rgb = this.sheenTeam === 'blu' ? preset.blu : preset.red;
    this.sheenMaterial.uniforms.uTint.value.set(rgb[0], rgb[1], rgb[2], 1);
  }

  // Sweep timing (CProxyAnimatedWeaponSheen): 60 mask frames at 25 fps, then
  // invisible for 5s with no killstreak owner (the inspect case), then loop.
  // `dt` overrides wall-clock time for deterministic captures.
  private updateSheenAnimation(dt?: number) {
    if (this.sheenId === 'none' || !this.sheenMaterial) return;
    const now = performance.now();
    this.sheenElapsed += dt ?? (now - this.sheenLastTime) / 1000;
    this.sheenLastTime = now;
    const cycle = SHEEN_SWEEP_SECONDS + SHEEN_PAUSE_SECONDS;
    const tInCycle = this.sheenElapsed % cycle;
    const sweeping = tInCycle < SHEEN_SWEEP_SECONDS;
    for (const mesh of this.sheenMeshes) mesh.visible = sweeping;
    for (const mesh of this.firstPerson?.overlays.sheen ?? []) mesh.visible = sweeping;
    if (sweeping) {
      this.sheenMaterial.uniforms.uFrame.value = Math.min(SHEEN_MASK_FRAMES - 1, Math.floor(SHEEN_FRAMERATE * tInCycle));
    }
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
    // Added at the scene root: particles simulate in WORLD space (like the
    // game, where control points follow the weapon but particles do not).
    // The render loop re-anchors the effect's control points from
    // centerGroup.matrixWorld every frame.
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
    if (this.disposed || this.meshes.length === 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0
      || clientX < rect.left || clientX > rect.right
      || clientY < rect.top || clientY > rect.bottom) return null;

    this.pickNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    // Pointer input can arrive before the next render has refreshed the
    // model/control matrices, so make the hit test use the current pose.
    this.scene.updateMatrixWorld(true);
    let camera: THREE.Camera = this.camera;
    if (this.projectionMode === 'orthographic') {
      this.syncOrthoCamera();
      camera = this.orthoCamera;
    }
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pickNdc, camera);
    // Line raycasts use world-space tolerance. Scale it to the framed model so
    // the x-ray remains easy to hit without swallowing nearby surfaces.
    this.raycaster.params.Line.threshold = Math.max(this.framedRadius * 0.014, 1e-4);
    const outlines = [...this.modelPartOutlines.values()];
    const outlineHit = this.raycaster.intersectObjects(outlines, false)[0];
    const visibleHit = this.raycaster.intersectObjects(this.meshes, false)[0];
    const outline = outlineHit?.object instanceof ModelPartOutline ? outlineHit.object : null;
    // Keep the front-most hit authoritative; bias coplanar and near-equal hits
    // toward visible geometry so stacked surfaces do not restore by accident.
    const coplanarEpsilon = Math.max(this.framedRadius * 0.001, 1e-4);
    if (outline && (!visibleHit || outlineHit.distance + coplanarEpsilon < visibleHit.distance)) {
      return outline.pick;
    }
    if (visibleHit?.faceIndex === undefined || visibleHit?.faceIndex === null || !Number.isInteger(visibleHit.faceIndex)) return null;
    const meshIndex = this.meshes.indexOf(visibleHit.object as THREE.Mesh);
    const cullable = meshIndex >= 0 ? this.cullableGeometries[meshIndex] : undefined;
    if (!cullable) return null;
    const componentIndex = cullable.componentForVisibleFace(visibleHit.faceIndex);
    if (componentIndex === null) return null;
    return { meshIndex, componentIndex };
  }

  setModelPartHover(pick: ModelPartPick | null): void {
    if (modelPartPicksEqual(this.modelPartHover, pick)) return;
    this.clearModelPartHover();
    if (!pick) return;

    const cullable = this.cullableGeometries[pick.meshIndex];
    if (!cullable || pick.componentIndex < 0 || pick.componentIndex >= cullable.componentCount) return;
    const hidden = cullable.isComponentHidden(pick.componentIndex);
    this.modelPartHover = pick;
    if (hidden) {
      const outline = this.modelPartOutlines.get(modelPartKey(pick.meshIndex, pick.componentIndex));
      if (outline) outline.material = this.modelPartOutlineHoverMaterial;
      this.invalidate();
      return;
    }

    const componentGeometry = cullable.getComponentGeometry(pick.componentIndex);
    if (!componentGeometry) {
      this.invalidate();
      return;
    }
    this.modelPartHoverMesh = new THREE.Mesh(componentGeometry, this.modelPartHoverMaterial);
    this.modelPartHoverMesh.renderOrder = 3;
    this.centerGroup.add(this.modelPartHoverMesh);
    this.invalidate();
  }

  toggleModelPart(pick: ModelPartPick): number | null {
    if (this.disposed) return null;
    const cullable = this.cullableGeometries[pick.meshIndex];
    if (!cullable) return null;
    this.clearModelPartHover();
    const hidden = cullable.isComponentHidden(pick.componentIndex);
    const changed = hidden
      ? cullable.restoreComponent(pick.componentIndex)
      : cullable.hideComponent(pick.componentIndex);
    if (!changed) return null;

    if (hidden) this.removeModelPartOutline(pick.meshIndex, pick.componentIndex);
    else this.addModelPartOutline(pick.meshIndex, pick.componentIndex);
    this.stickers.resetStickerUvTopology();
    this.stickers.clearStickerGizmoState();
    if (!hidden) this.setModelPartHover(pick);
    this.invalidate();
    return this.cullableGeometries.reduce((count, geometry) => count + geometry.hiddenCount, 0);
  }

  clearModelPartHover(): void {
    if (this.modelPartHover) {
      const outline = this.modelPartOutlines.get(modelPartKey(
        this.modelPartHover.meshIndex,
        this.modelPartHover.componentIndex,
      ));
      if (outline) outline.material = this.modelPartOutlineMaterial;
    }
    this.modelPartHover = null;
    if (this.modelPartHoverMesh) this.centerGroup.remove(this.modelPartHoverMesh);
    this.modelPartHoverMesh = null;
    this.invalidate();
  }

  restoreHiddenModelParts(): void {
    if (this.disposed) return;
    let restored = false;
    for (const cullable of this.cullableGeometries) restored = cullable.restore() || restored;
    if (!restored) return;
    this.teardownModelPartOutlines();
    this.clearModelPartHover();
    this.stickers.resetStickerUvTopology();
    this.stickers.clearStickerGizmoState();
    this.invalidate();
  }

  // Sticker editor support lives in StickerOverlay (stickerOverlay.ts); these
  // keep Viewer's public sticker API.
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

  getStickerGizmoState(): StickerGizmoState | null {
    return this.stickers.getStickerGizmoState();
  }

  hitTestStickerGizmo(clientX: number, clientY: number): StickerGizmoHandleKind | null {
    return this.stickers.hitTestStickerGizmo(clientX, clientY);
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
   * Show a faint color key for every assigned editor layer. The input can
   * contain more than one group texture, which is important for paint kits
   * whose selectors address distinct maps. Focused hover/selection feedback
   * remains a separate, stronger pass drawn above this one.
   */
  setGroupLayerOverlay(maps: readonly GroupLayerOverlayMap[] | null): void {
    this.teardownGroupLayerOverlayPasses();
    if (maps === null) {
      this.invalidate();
      return;
    }

    for (const source of maps) {
      if (!Number.isSafeInteger(source.width) || source.width <= 0
        || !Number.isSafeInteger(source.height) || source.height <= 0
        || source.pixels.length < source.width * source.height * 4) continue;

      // Keep exactly one color per bucket. The last entry wins intentionally:
      // callers can build a simple layer list without first de-duplicating a
      // bucket that was reassigned during the same state update.
      const colors = Array.from({ length: 16 }, () => new THREE.Vector3());
      const active = Array.from({ length: 16 }, () => 0);
      for (const layer of source.layers) {
        if (!Number.isInteger(layer.bucket) || layer.bucket < 1 || layer.bucket > 16) continue;
        const [r, g, b] = layer.color;
        if (![r, g, b].every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)) continue;
        colors[layer.bucket - 1].set(r, g, b);
        active[layer.bucket - 1] = 1;
      }
      if (!active.some(Boolean)) continue;

      const texture = this.createGroupMapTexture(source.pixels, source.width, source.height);
      const material = this.createGroupLayerOverlayMaterial(texture, colors, active);
      const pass: GroupLayerOverlayPass = { texture, material, meshes: [] };
      this.groupLayerOverlayPasses.push(pass);
      this.rebuildGroupLayerOverlayMeshes(pass);
    }
    this.invalidate();
  }

  /** Remove the editor's all-layer surface cue without changing the weapon. */
  clearGroupLayerOverlay(): void {
    this.teardownGroupLayerOverlayPasses();
    this.invalidate();
  }

  private createGroupMapTexture(
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
  ): THREE.DataTexture {
    // Copy caller-owned data. Decoding and editor state may reuse the source
    // buffer after this call, which must not mutate an already-uploaded map.
    const data = new Uint8Array(width * height * 4);
    data.set(pixels.subarray(0, data.length));
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false;
    texture.generateMipmaps = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }

  private createGroupLayerOverlayMaterial(
    texture: THREE.Texture,
    colors: THREE.Vector3[],
    active: number[],
  ): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uGroupMap: { value: texture },
        uLayerColors: { value: colors },
        uLayerActive: { value: active },
      },
      vertexShader: `
        varying vec2 vGroupUv;
        void main() {
          vGroupUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uGroupMap;
        uniform vec3 uLayerColors[16];
        uniform float uLayerActive[16];
        varying vec2 vGroupUv;
        void main() {
          float rawGroup = texture2D(uGroupMap, vGroupUv).r * 255.0;
          float groupBucket = floor(rawGroup / 16.0 + 0.5);
          for (int i = 0; i < 16; i++) {
            if (uLayerActive[i] > 0.5 && abs(groupBucket - float(i + 1)) < 0.1) {
              gl_FragColor = vec4(uLayerColors[i], ${GROUP_LAYER_OVERLAY_OPACITY.toFixed(2)});
              return;
            }
          }
          discard;
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: this.material.side,
    });
  }

  private rebuildGroupLayerOverlayMeshes(pass: GroupLayerOverlayPass) {
    for (const mesh of this.paintableMeshes) {
      const overlay = new THREE.Mesh(mesh.geometry, pass.material);
      // The focused selection cue uses renderOrder 2, so it always remains
      // visibly stronger and on top of this orientation-only cue.
      overlay.renderOrder = 1;
      this.centerGroup.add(overlay);
      pass.meshes.push(overlay);
    }
  }

  private teardownGroupLayerOverlayMeshes() {
    for (const pass of this.groupLayerOverlayPasses) {
      for (const mesh of pass.meshes) this.centerGroup.remove(mesh);
      pass.meshes = [];
    }
  }

  private teardownGroupLayerOverlayPasses() {
    this.teardownGroupLayerOverlayMeshes();
    for (const pass of this.groupLayerOverlayPasses) {
      pass.material.dispose();
      pass.texture.dispose();
    }
    this.groupLayerOverlayPasses = [];
  }

  /**
   * Shows a restrained overlay for one compositor group bucket on the current
   * paintable weapon surfaces. Pass `null` pixels or bucket to clear it.
   *
   * The pixels must be unflipped RGBA image data (the same orientation as the
   * composited map and `ImageData` decoded from a group texture). Buckets are
   * the 0..16 values produced by `round(red / 16)`, not raw red-channel bytes.
   */
  setGroupHighlight(
    pixels: Uint8Array | Uint8ClampedArray | null,
    width: number,
    height: number,
    bucket: number | null,
    color: readonly [number, number, number] = GROUP_LAYER_OVERLAY_COLORS[0],
  ): void {
    if (pixels === null
      || !Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0
      || pixels.length < width * height * 4
      || bucket === null || !Number.isInteger(bucket) || bucket < 0 || bucket > 16
      || !color.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
      this.clearGroupHighlight();
      return;
    }

    const texture = this.createGroupMapTexture(pixels, width, height);

    this.groupHighlightTexture?.dispose();
    this.groupHighlightTexture = texture;
    const material = this.ensureGroupHighlightMaterial();
    material.uniforms.uGroupMap.value = texture;
    material.uniforms.uBucket.value = bucket;
    material.uniforms.uColor.value.set(color[0], color[1], color[2]);
    this.rebuildGroupHighlightMeshes();
    this.invalidate();
  }

  /** Remove the editor-only group cue without changing the loaded weapon. */
  clearGroupHighlight(): void {
    this.teardownGroupHighlightMeshes();
    this.groupHighlightTexture?.dispose();
    this.groupHighlightTexture = null;
    if (this.groupHighlightMaterial) this.groupHighlightMaterial.uniforms.uGroupMap.value = null;
    this.invalidate();
  }

  private ensureGroupHighlightMaterial(): THREE.ShaderMaterial {
    if (this.groupHighlightMaterial) return this.groupHighlightMaterial;
    this.groupHighlightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uGroupMap: { value: null as THREE.Texture | null },
        uBucket: { value: -1 },
        uColor: { value: new THREE.Vector3(...GROUP_LAYER_OVERLAY_COLORS[0]) },
      },
      vertexShader: `
        varying vec2 vGroupUv;
        void main() {
          vGroupUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uGroupMap;
        uniform float uBucket;
        uniform vec3 uColor;
        varying vec2 vGroupUv;
        void main() {
          float rawGroup = texture2D(uGroupMap, vGroupUv).r * 255.0;
          float groupBucket = floor(rawGroup / 16.0 + 0.5);
          if (abs(groupBucket - uBucket) > 0.1) discard;
          gl_FragColor = vec4(uColor, 0.32);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      // Draw just in front of the source mesh, preventing coplanar flicker
      // while retaining depth testing against the rest of the weapon.
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: this.material.side,
    });
    return this.groupHighlightMaterial;
  }

  private teardownGroupHighlightMeshes() {
    for (const mesh of this.groupHighlightMeshes) this.centerGroup.remove(mesh);
    this.groupHighlightMeshes = [];
  }

  private addModelPartOutline(meshIndex: number, componentIndex: number): void {
    const key = modelPartKey(meshIndex, componentIndex);
    if (this.modelPartOutlines.has(key)) return;
    const cullable = this.cullableGeometries[meshIndex];
    const componentGeometry = cullable?.getComponentGeometry(componentIndex);
    if (!componentGeometry) return;
    const edges = new THREE.EdgesGeometry(componentGeometry, 18);
    // The component geometry is cached and owned by CullableGeometry; the
    // edge geometry owns the data used by this persistent outline pass.
    if ((edges.getAttribute('position')?.count ?? 0) === 0) {
      edges.dispose();
      return;
    }
    const line = new ModelPartOutline({ meshIndex, componentIndex }, edges, this.modelPartOutlineMaterial);
    line.renderOrder = 4;
    line.frustumCulled = false;
    this.centerGroup.add(line);
    this.modelPartOutlines.set(key, line);
  }

  private removeModelPartOutline(meshIndex: number, componentIndex: number): void {
    const key = modelPartKey(meshIndex, componentIndex);
    const outline = this.modelPartOutlines.get(key);
    if (!outline) return;
    this.modelPartOutlines.delete(key);
    this.centerGroup.remove(outline);
    outline.geometry.dispose();
  }

  private teardownModelPartOutlines(): void {
    for (const outline of this.modelPartOutlines.values()) {
      this.centerGroup.remove(outline);
      outline.geometry.dispose();
    }
    this.modelPartOutlines.clear();
  }

  private rebuildGroupHighlightMeshes() {
    this.teardownGroupHighlightMeshes();
    if (!this.groupHighlightTexture || !this.groupHighlightMaterial) return;
    this.groupHighlightMaterial.side = this.material.side;
    for (const mesh of this.paintableMeshes) {
      const overlay = new THREE.Mesh(mesh.geometry, this.groupHighlightMaterial);
      overlay.renderOrder = 2;
      this.centerGroup.add(overlay);
      this.groupHighlightMeshes.push(overlay);
    }
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

  // Renders at the current viewport aspect with no background so the PNG
  // carries alpha. Numeric sizes retain the scaled, cropped path used by
  // generated thumbnails. Size presets crop the same way, then resize the
  // result so its longest edge matches the requested tier. Capture uses an
  // offscreen target rather than resizing the live canvas, so the animation
  // loop can keep running while PNG encoding completes without observing
  // temporary renderer state.
  //
  // The buffer can't go through canvas.toBlob() directly: additive passes
  // (unusual particles, sheens) add color while leaving destination alpha
  // untouched, which reads correctly when the page composites the (nominally
  // premultiplied) canvas over the backplate but is invalid premultiplied
  // data on a transparent background. toBlob's unpremultiply divides those
  // bright low-alpha pixels into rainbow garbage. PNG's straight alpha
  // cannot represent additive light at all, so convert each pixel to the
  // closest "over" approximation: alpha = max(alpha, r, g, b) and color
  // rescaled to keep color * alpha unchanged. Over dark backgrounds this
  // reproduces the glow exactly; opaque weapon pixels pass through untouched.
  async captureScreenshot(size: number | ScreenshotSize = 2): Promise<Blob> {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    // ponytail: cap the working target at an 8K pixel budget; tile the render
    // if native 16K detail ever becomes a real requirement.
    const { width, height, paddingScale, outputMaxEdge } = fitScreenshotCapture(
      resolveScreenshotCapture(size, w, h),
      this.renderer.capabilities.maxTextureSize,
      7680 * 4320,
    );
    const target = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
      // Large exports already carry enough edge detail, and multisampling would
      // multiply their GPU memory cost.
      samples: width * height <= 2560 * 1440 ? 4 : 0,
    });
    target.texture.colorSpace = this.renderer.outputColorSpace;
    const prevTarget = this.renderer.getRenderTarget();
    const prevBackground = this.scene.background;
    const raw = new Uint8Array(width * height * 4);
    try {
      this.lightEditor.setCaptureMode(true);
      this.scene.background = null;
      setParticlePointScale(height);
      this.renderer.setRenderTarget(target);
      if (this.firstPerson) {
        this.renderFirstPerson();
      } else if (this.projectionMode === 'orthographic') {
        this.syncOrthoCamera();
        this.renderer.render(this.scene, this.orthoCamera);
      } else {
        this.renderer.render(this.scene, this.camera);
      }
      this.renderer.readRenderTargetPixels(target, 0, 0, width, height, raw);
    } finally {
      this.renderer.setRenderTarget(prevTarget);
      this.scene.background = prevBackground;
      this.lightEditor.setCaptureMode(false);
      setParticlePointScale(h * this.renderer.getPixelRatio());
      target.dispose();
    }

    return screenshotPixelsToBlob(raw, width, height, paddingScale, outputMaxEdge, !!this.firstPerson);
  }

  /**
   * Renders one revolution of the TF2 inspect-panel turntable
   * (CTFItemInspectionPanel::OnThink: yaw advances about world up while pitch
   * and pan hold; tf_item_inspect_model_spin_rate's 30 deg/s is a 12 s
   * `seconds`) and streams it to `sink` as top-down RGBA frames with 1-bit
   * alpha. Frames are cropped to the whole area the spinning model sweeps,
   * even where that leaves the viewport, and supersampled 2x, then flattened
   * to the format's alpha (see TurntableFrameResolver) or onto a solid `background`.
   * Zoom never gets closer than the framed default: nearer than that the model
   * swings past the lens and no crop can hold it.
   *
   * Sheens, particles and scrolling emissives advance in lockstep with the
   * spin, so the capture plays back at real inspect speed. When any of them is
   * running, the render continues past the full turn and those extra frames
   * crossfade into the start (same poses, later effect state), hiding the loop
   * seam. The live view pauses and ignores pointer input until the capture
   * settles; aborting `signal`, resizing or switching camera mode stops it
   * with a TurntableStoppedError.
   */
  async captureTurntable(
    { maxEdge, fps, seconds, background, alpha, paletteSamples }: TurntableOptions,
    sink: TurntableSink,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.firstPerson) throw new Error('Turntable GIFs need the Inspect view');
    if (this.turntableCapturing) throw new Error('A turntable capture is already running');
    // Let the caller's busy state paint before the synchronous probe (the
    // timeout covers hidden tabs, where animation frames never come).
    await new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
      setTimeout(resolve, 100);
    });
    if (this.disposed) throw new Error('Viewer disposed');

    const viewW = this.canvas.clientWidth || 1;
    const viewH = this.canvas.clientHeight || 1;
    const distance = this.controls.getDistance();
    this.controls.setDistance(Math.max(distance.current, distance.framed));
    const camera = this.projectionMode === 'orthographic' ? this.orthoCamera : this.camera;
    if (camera === this.orthoCamera) this.syncOrthoCamera();
    const cameraMode = this.controls.getCameraMode();
    // Between frames the page stays live: the caller aborts `signal` for a
    // cancel or a scene change it knows about, and a resize or camera switch
    // would warp every later frame, so all of them stop the capture.
    const checkInterrupted = () => {
      if (this.disposed) throw new Error('Viewer disposed');
      if (signal?.aborted) throw new TurntableStoppedError(String(signal.reason ?? 'Cancelled'));
      if (this.canvas.clientWidth !== viewW || this.canvas.clientHeight !== viewH) {
        throw new TurntableStoppedError('The viewer was resized');
      }
      if (this.controls.getCameraMode() !== cameraMode) throw new TurntableStoppedError('The camera mode changed');
    };
    const frameCount = Math.max(2, Math.round(seconds * fps));
    const dt = 1 / fps;
    const sheenActive = this.sheenId !== 'none' && !!this.sheenMaterial && this.sheenMeshes.length > 0;
    const animated = !!this.activeUnusual || sheenActive || this.stepEmissive(0) || this.stepAttachments(0);
    const prevTarget = this.renderer.getRenderTarget();
    const prevBackground = this.scene.background;
    const prevPointerEvents = this.canvas.style.pointerEvents;
    const disposables: { dispose(): void }[] = [];
    const renderTarget = (width: number, height: number, samples: number) => {
      const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false, samples });
      target.texture.colorSpace = this.renderer.outputColorSpace;
      disposables.push(target);
      return target;
    };
    this.turntableCapturing = true;
    this.canvas.style.pointerEvents = 'none';
    this.lightEditor.setCaptureMode(true);
    this.scene.background = null;
    try {
      // Probe: the screen area the model sweeps through a revolution, found at
      // low resolution through a frustum widened to `reach` times the
      // viewport, widening again if the sweep still touches its border.
      let reach = 3;
      let box: number[] = [];
      let probeScale = 1;
      for (;;) {
        probeScale = TURNTABLE_PROBE_EDGE / (reach * Math.max(viewW, viewH));
        const probeW = Math.max(1, Math.round(reach * viewW * probeScale));
        const probeH = Math.max(1, Math.round(reach * viewH * probeScale));
        const probe = renderTarget(probeW, probeH, 0);
        const probeRaw = new Uint8Array(probeW * probeH * 4);
        box = [probeW, probeH, -1, -1];
        const margin = (reach - 1) / 2;
        camera.setViewOffset(viewW, viewH, -margin * viewW, -margin * viewH, reach * viewW, reach * viewH);
        setParticlePointScale(viewH * probeScale);
        this.renderer.setRenderTarget(probe);
        for (let i = 0; i < TURNTABLE_PROBE_STEPS; i++) {
          this.controls.rotateYaw((Math.PI * 2) / TURNTABLE_PROBE_STEPS);
          this.renderer.render(this.scene, camera);
          this.renderer.readRenderTargetPixels(probe, 0, 0, probeW, probeH, probeRaw);
          unionContentBounds(probeRaw, probeW, probeH, box);
        }
        if (box[2] < 0) throw new Error('Nothing to capture');
        const touches = box[0] === 0 || box[1] === 0 || box[2] === probeW - 1 || box[3] === probeH - 1;
        // Viewport pixels; the sweep may start left of or above the viewport.
        const x = (px: number) => px / probeScale - margin * viewW;
        const y = (px: number) => px / probeScale - margin * viewH;
        box = [x(box[0]), y(box[1]), x(box[2] + 1), y(box[3] + 1)];
        if (!touches || reach >= TURNTABLE_MAX_REACH) break;
        reach *= 3;
      }

      // Crop in viewport pixels, padded for probe resolution and for anything
      // (particles, the angles between probe steps) that strays a little.
      const pad = 0.05 * Math.max(box[2] - box[0], box[3] - box[1]) + 1 / probeScale;
      const cropX = box[0] - pad;
      const cropY = box[1] - pad;
      const cropW = box[2] - box[0] + 2 * pad;
      const cropH = box[3] - box[1] + 2 * pad;

      const outScale = maxEdge / Math.max(cropW, cropH);
      const width = Math.max(1, Math.round(cropW * outScale));
      const height = Math.max(1, Math.round(cropH * outScale));
      // As many samples per pixel as the GPU budget allows. The paint has no
      // mipmaps (TF2's inspect panel composites without them), so only real
      // subsamples average a minified pattern instead of letting it sparkle;
      // MSAA on top still halves the remaining edge error.
      const msaa = Math.min(4, this.renderer.capabilities.maxSamples);
      const ss = Math.max(1, Math.min(
        TURNTABLE_MAX_SUPERSAMPLE,
        Math.floor(Math.sqrt(TURNTABLE_SAMPLE_BUDGET / (width * height * Math.max(1, msaa)))),
        Math.floor(this.renderer.capabilities.maxTextureSize / Math.max(width, height)),
      ));
      const target = renderTarget(width * ss, height * ss, msaa);
      const resolver = new TurntableFrameResolver(width, height, ss, background, alpha);
      disposables.push(resolver);
      const renderScale = outScale * ss;
      camera.setViewOffset(viewW * renderScale, viewH * renderScale, cropX * renderScale, cropY * renderScale, width * ss, height * ss);
      // Seam frames are held on the GPU (half float, 8 bytes per output pixel)
      // until the overrun reaches them; large captures get a shorter crossfade
      // instead of more memory.
      const seamFrames = animated
        ? Math.min(Math.round(TURNTABLE_SEAM_SECONDS * fps), Math.floor(frameCount / 4), Math.floor(TURNTABLE_SEAM_BUDGET_BYTES / (width * height * 8)))
        : 0;
      const render = () => {
        // Other viewers share the particle scale uniform and may have drawn
        // while we awaited the sink. three r185 also only re-resolves a
        // multisampled target after it is bound again; repeated renders
        // without the rebind read back the first frame.
        setParticlePointScale(viewH * renderScale);
        this.renderer.setRenderTarget(target);
        this.renderer.render(this.scene, camera);
      };

      const advance = () => {
        this.controls.rotateYaw((Math.PI * 2) / frameCount);
        this.updateSheenAnimation(dt);
        this.stepEmissive(dt);
        this.stepAttachments(dt);
        if (this.activeUnusual) {
          this.centerGroup.updateWorldMatrix(true, false);
          this.activeUnusual.updateAnchor(this.centerGroup.matrixWorld);
          this.activeUnusual.update(dt);
        }
      };

      // Palette samples: a rehearsal turn, simulated at full rate but only
      // rendered every few frames, so the samples see the same poses, sheen,
      // emissive and particle evolution as the capture that follows. Frames
      // stream out as they render, so the palette must exist before them.
      const samples: Uint8Array[] = [];
      const sampleCount = Math.min(TURNTABLE_PALETTE_SAMPLES, frameCount);
      for (let f = 0, next = 0; paletteSamples && f < frameCount; f++) {
        if (f === Math.floor((next * frameCount) / sampleCount)) {
          render();
          samples.push(resolver.resolve(this.renderer, target.texture));
          next++;
        }
        advance();
      }
      sink.start({ width, height, frames: frameCount, fps }, samples);

      // Output order: the turn from `seamFrames` onward, then the overrun
      // frames blended into the held opening frames (same poses), ramping from
      // the overrun toward the opening so both loop joins are continuous.
      for (let f = 0; f < frameCount + seamFrames; f++) {
        checkInterrupted();
        render();
        if (f < seamFrames) {
          resolver.hold(this.renderer, target.texture, f);
        } else {
          const blend = f >= frameCount ? { slot: f - frameCount, t: (f - frameCount + 1) / (seamFrames + 1) } : undefined;
          await sink.frame(resolver.resolve(this.renderer, target.texture, blend));
        }
        advance();
      }
    } finally {
      camera.clearViewOffset();
      this.controls.setDistance(distance.current);
      this.scene.background = prevBackground;
      this.renderer.setRenderTarget(prevTarget);
      this.lightEditor.setCaptureMode(false);
      setParticlePointScale(viewH * this.renderer.getPixelRatio());
      for (const disposable of disposables) disposable.dispose();
      this.canvas.style.pointerEvents = prevPointerEvents;
      this.turntableCapturing = false;
      this.invalidate();
    }
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

  async applyMaterialParams(
    mat: WeaponMaterial,
    resolveTexture: (ref: string) => string | Promise<string> = (ref) => ref,
    resolveCubemap: (ref: string) => Promise<string[] | null> = async () => null,
    cancelled: () => boolean = () => false,
  ): Promise<void> {
    const token = ++this.materialLoadToken;
    await this.envReady;
    if (this.disposed || cancelled() || token !== this.materialLoadToken) return;
    const u = this.tf2Uniforms;
    configureTf2Material(mat, this.material, u);
    this.materialRimLight = u.uTf2RimLight.value;
    this.syncMaterialRimLight();
    this.invalidate();

    this.normalTexture?.dispose();
    this.exponentTexture?.dispose();
    this.lightwarpTexture?.dispose();
    this.selfIllumTexture?.dispose();
    this.detailTexture?.dispose();
    this.normalTexture = this.exponentTexture = this.lightwarpTexture = this.selfIllumTexture = null;
    this.detailTexture = null;
    this.material.normalMap = null;
    u.uTf2ExponentMap.value = null;
    u.uTf2LightwarpMap.value = null;
    u.uTf2UseExponentMap.value = 0;
    u.uTf2UseLightwarp.value = 0;
    u.uTf2UseSelfIllumMask.value = 0;
    u.uTf2SelfIllumMaskMap.value = null;
    u.uTf2DetailMap.value = null;

    const loads: Promise<void>[] = [];
    if (mat.envmapTexture) {
      loads.push(resolveCubemap(mat.envmapTexture).then((urls) => {
        if (token !== this.materialLoadToken || this.disposed) return;
        if (!urls) {
          this.resetMaterialEnvMap();
          return;
        }
        return new THREE.CubeTextureLoader().loadAsync(urls).then((texture) => {
          if (token !== this.materialLoadToken || this.disposed) { texture.dispose(); return; }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.needsUpdate = true;
          this.customEnvMap?.dispose();
          this.customEnvMap = texture;
          this.setMaterialEnvMap(texture);
        });
      }).catch(() => {
        if (token === this.materialLoadToken && !this.disposed) this.resetMaterialEnvMap();
      }));
    } else {
      this.resetMaterialEnvMap();
    }
    if (mat.normalMap) loads.push(Promise.resolve(resolveTexture(mat.normalMap)).then((url) => this.texLoader.loadAsync(url)).then((t) => {
      if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
      t.colorSpace = THREE.NoColorSpace;
      t.flipY = false; // glTF UV convention, same as the composited map
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      // Source normal maps use the DirectX (green-down) convention.
      this.material.normalScale.set(1, -1);
      this.normalTexture = t;
      this.material.normalMap = t;
      this.material.needsUpdate = true;
      this.renderer.initTexture(t);
      this.invalidate();
    }).catch(() => undefined));
    if (mat.phongExponentTexture) {
      loads.push(Promise.resolve(resolveTexture(mat.phongExponentTexture)).then((url) => this.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        this.exponentTexture = t; u.uTf2ExponentMap.value = t; u.uTf2UseExponentMap.value = 1;
        this.renderer.initTexture(t);
        this.invalidate();
      }).catch(() => undefined));
    }
    if (mat.lightwarpTexture) {
      loads.push(Promise.resolve(resolveTexture(mat.lightwarpTexture)).then((url) => this.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
        // skin_dx9_helper.cpp does not enable sRGB reads for the diffuse-warp
        // sampler. Source therefore uses the stored ramp values directly.
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        this.lightwarpTexture = t; u.uTf2LightwarpMap.value = t; u.uTf2UseLightwarp.value = 1;
        this.renderer.initTexture(t);
        this.invalidate();
      }).catch(() => undefined));
    }
    if (mat.selfIllumMask) {
      loads.push(Promise.resolve(resolveTexture(mat.selfIllumMask)).then((url) => this.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        this.selfIllumTexture = t; u.uTf2SelfIllumMaskMap.value = t; u.uTf2UseSelfIllumMask.value = 1;
        this.renderer.initTexture(t);
        this.invalidate();
      }).catch(() => undefined));
    }
    if (mat.detailTexture) {
      loads.push(Promise.resolve(resolveTexture(mat.detailTexture)).then((url) => this.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
        // Decoded in the shader instead of here, because Mod2X reads the
        // detail texture raw while every other blend mode reads it as sRGB.
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        this.detailTexture = t; u.uTf2DetailMap.value = t;
        this.renderer.initTexture(t);
        this.invalidate();
      }).catch(() => undefined));
    }
    loads.push(this.applyEmissivePass(mat, resolveTexture, token));
    this.material.needsUpdate = true;
    await Promise.all(loads);
    this.invalidate();
  }

  private setMaterialEnvMap(texture: THREE.CubeTexture): void {
    this.envMap = texture;
    this.material.envMap = texture;
    this.material.needsUpdate = true;
    this.invalidate();
  }

  private resetMaterialEnvMap(): void {
    this.customEnvMap?.dispose();
    this.customEnvMap = null;
    this.setMaterialEnvMap(this.defaultEnvMap);
  }

  /**
   * $EmissiveBlendEnabled is a second additive pass over the weapon rather
   * than a term in the lit shader (see src/viewer/emissive.ts), so it gets its
   * own material, its own copies of the meshes, and its own textures.
   */
  private async applyEmissivePass(
    mat: WeaponMaterial,
    resolveTexture: (ref: string) => string | Promise<string>,
    token: number,
  ): Promise<void> {
    for (const texture of this.emissiveTextures) texture.dispose();
    this.emissiveTextures = [];
    const strength = mat.emissiveBlendStrength ?? EMISSIVE_DEFAULT_STRENGTH;
    // vertexlitgeneric_dx9.cpp skips the pass entirely at zero strength.
    this.emissiveEnabled = !!mat.emissiveBlend && strength > 0 && !!mat.emissiveBlendBaseTexture;
    if (!this.emissiveEnabled) {
      this.teardownEmissiveMeshes();
      return;
    }
    if (!this.emissiveMaterial) this.emissiveMaterial = createEmissiveMaterial(this.material.side);
    const u = this.emissiveMaterial.uniforms;
    u.uEmissiveStrength.value = strength;
    u.uEmissiveTint.value.setRGB(...(mat.emissiveBlendTint ?? [1, 1, 1]));
    u.uEmissiveScroll.value.fromArray(mat.emissiveBlendScrollVector ?? EMISSIVE_DEFAULT_SCROLL);
    u.uEmissiveTime.value = 0;
    this.emissiveElapsed = 0;
    // A missing flow or emissive map would sample as black and swallow the
    // glow, so both fall back to the white texture the fxc's math expects.
    const white = whiteTexture();
    u.uEmissiveBaseMap.value = null;
    u.uEmissiveFlowMap.value = white;
    u.uEmissiveMap.value = white;

    const slots: [string | null | undefined, 'uEmissiveBaseMap' | 'uEmissiveFlowMap' | 'uEmissiveMap'][] = [
      [mat.emissiveBlendBaseTexture, 'uEmissiveBaseMap'],
      [mat.emissiveBlendFlowTexture, 'uEmissiveFlowMap'],
      [mat.emissiveBlendTexture, 'uEmissiveMap'],
    ];
    await Promise.all(slots.map(([ref, slot]) => (ref
      ? Promise.resolve(resolveTexture(ref)).then((url) => this.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
        configureEmissiveTexture(t);
        this.emissiveTextures.push(t);
        if (this.emissiveMaterial) this.emissiveMaterial.uniforms[slot].value = t;
        this.renderer.initTexture(t);
      }).catch(() => undefined)
      : Promise.resolve())));
    if (token !== this.materialLoadToken || this.disposed) return;
    // Without a glow color there is nothing to add, and the pass would tint
    // the weapon by whatever the fallback white maps happened to multiply out.
    this.emissiveEnabled = !!this.emissiveMaterial.uniforms.uEmissiveBaseMap.value;
    if (this.emissiveEnabled) this.rebuildEmissiveMeshes();
    else this.teardownEmissiveMeshes();
    this.invalidate();
  }

  private teardownEmissiveMeshes() {
    this.firstPerson?.setOverlay('emissive', null);
    for (const mesh of this.emissiveMeshes) this.centerGroup.remove(mesh);
    this.emissiveMeshes = [];
  }

  private rebuildEmissiveMeshes() {
    this.teardownEmissiveMeshes();
    if (!this.emissiveEnabled || !this.emissiveMaterial) return;
    this.firstPerson?.setOverlay('emissive', this.emissiveMaterial);
    for (let i = 0; i < this.meshes.length; i++) {
      if (this.meshIsLens[i]) continue;
      const mesh = new THREE.Mesh(this.meshes[i].geometry, this.emissiveMaterial);
      mesh.renderOrder = 1;
      this.centerGroup.add(mesh);
      this.emissiveMeshes.push(mesh);
    }
  }

  private currentModelUrl: string | null = null;
  private loadToken = 0;
  private attachments: LoadedAttachment[] = [];

  // Attached models keep their own unpainted material and stay out of
  // picking, framing and paint overlays. One that fails to load is left out.
  private async loadAttachment({ model, material: params }: WeaponAttachment): Promise<LoadedAttachment | null> {
    const loadTexture = async (ref: string | null | undefined) => {
      if (!ref) return null;
      const texture = await this.texLoader.loadAsync(joinData(ref));
      // Sampled like the viewmodel's copy in FirstPersonPreview.
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      return texture;
    };
    const [parts, map, detail] = await Promise.allSettled([
      this.modelLoader.load(`${import.meta.env.BASE_URL}data/${model}`),
      loadTexture(params.baseTexture),
      loadTexture(params.detailTexture),
    ]);
    if (parts.status === 'rejected' || map.status === 'rejected' || detail.status === 'rejected') {
      if (map.status === 'fulfilled') map.value?.dispose();
      if (detail.status === 'fulfilled') detail.value?.dispose();
      console.warn('[warpaint-viewer] attached model failed to load:', model);
      return null;
    }
    const uniforms = createTf2Uniforms();
    const material = new THREE.MeshPhongMaterial({ color: 0xffffff, map: map.value });
    configureTf2Material(params, material, uniforms);
    uniforms.uTf2DetailMap.value = detail.value;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      installTf2VertexLit(shader);
    };
    // Kept apart from this.material's program, which adds isolation uniforms.
    material.customProgramCacheKey = () => `${TF2_VERTEXLIT_CACHE_KEY}-attachment`;
    return { meshes: parts.value.map(({ geometry }) => new THREE.Mesh(geometry, material)), material, uniforms };
  }

  private setAttachments(attachments: LoadedAttachment[]) {
    for (const attachment of this.attachments) {
      this.centerGroup.remove(...attachment.meshes);
      disposeAttachment(attachment);
    }
    this.attachments = attachments;
    for (const { meshes } of attachments) this.centerGroup.add(...meshes);
    this.invalidate();
  }

  // $texture2 TextureScroll runs on game time, so it scrolls in the inspect
  // panel too. The base's BuildingRescueLevel reads the owner's metal and has
  // no player there, so it stays put.
  private stepAttachments(dt: number): boolean {
    let animating = false;
    for (const { uniforms } of this.attachments) {
      const scroll = uniforms.uTf2DetailScroll.value;
      if (scroll.lengthSq() === 0) continue;
      animating = true;
      const period = 1 / Math.max(Math.abs(scroll.x), Math.abs(scroll.y));
      uniforms.uTf2Time.value = (uniforms.uTf2Time.value + dt) % period;
    }
    return animating;
  }

  private setMeshGeometries(parts: ModelPart[], initialView?: ViewAnglePreset) {
    this.teardownSheenMeshes();
    this.teardownEmissiveMeshes();
    this.teardownGroupLayerOverlayMeshes();
    this.teardownGroupHighlightMeshes();
    this.clearModelPartHover();
    this.teardownModelPartOutlines();
    this.teardownTransformIsolationMeshes();
    this.stickers.teardownStickerPreviewMeshes();
    for (const mesh of this.meshes) {
      this.centerGroup.remove(mesh);
    }
    for (const cullable of this.cullableGeometries) cullable.dispose();
    this.cullableGeometries = [];
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
    if (this.sheenId !== 'none' && this.sheenMaterial) this.rebuildSheenMeshes();
    if (this.emissiveEnabled) this.rebuildEmissiveMeshes();
    for (const pass of this.groupLayerOverlayPasses) this.rebuildGroupLayerOverlayMeshes(pass);
    if (this.groupHighlightTexture && this.groupHighlightMaterial) this.rebuildGroupHighlightMeshes();
    if (this.transformIsolationMaterial) this.rebuildTransformIsolationMeshes();
    this.stickers.rebuildStickerPreviewMeshesIfLoaded();
    this.invalidate();
  }

  private clearModel() {
    this.teardownSheenMeshes();
    this.teardownEmissiveMeshes();
    this.stickers.clearStickerPreview();
    this.clearGroupLayerOverlay();
    // A group map belongs to the previous weapon/paint pairing. Do not retain
    // its GPU texture after a failed or explicit model clear.
    this.clearGroupHighlight();
    this.clearModelPartHover();
    this.teardownModelPartOutlines();
    this.clearTransformIsolation();
    for (const mesh of this.meshes) {
      this.centerGroup.remove(mesh);
    }
    for (const cullable of this.cullableGeometries) cullable.dispose();
    this.meshes = [];
    this.paintableMeshes = [];
    this.cullableGeometries = [];
    this.setAttachments([]);
    this.stickers.resetStickerUvTopology();
    this.meshIsLens = [];
    this.currentModelUrl = null;
    this.invalidate();
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
      const attached = (await Promise.all(attachments.map((attachment) => this.loadAttachment(attachment))))
        .filter((attachment) => attachment !== null);
      if (token !== this.loadToken || this.disposed) {
        attached.forEach(disposeAttachment);
        return;
      }
      this.setMeshGeometries(geometries, initialView);
      this.setAttachments(attached);
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
    // The inspect pose keeps a weapon's longest axis mostly horizontal, so fit
    // that axis against the horizontal fov and the next-largest against the
    // vertical one. Fitting everything against the vertical fov (the old
    // sphere fit) framed long weapons far too small on wide canvases.
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
    this.sheenFrameData = computeSheenFrameData(box.min, box.max);
    this.updateSheenFrameUniforms();

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

    // A centered 3D bounding box can still look off-center after perspective
    // projection (especially long, deep weapons such as the rocket launcher).
    // Measure the actual projected vertices and make that visual center the
    // controls' reset position.
    const projectedMin = new THREE.Vector2(Infinity, Infinity);
    const projectedMax = new THREE.Vector2(-Infinity, -Infinity);
    const point = new THREE.Vector3();
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
    this.teardownSheenMeshes();
    this.stickers.dispose();
    this.clearGroupLayerOverlay();
    this.clearGroupHighlight();
    this.clearModelPartHover();
    this.teardownModelPartOutlines();
    this.clearTransformIsolation();
    this.groupHighlightMaterial?.dispose();
    this.groupHighlightMaterial = null;
    this.sheenMaterial?.dispose();
    this.sheenMaterial = null;
    this.sheenAssets?.maskTexture.dispose();
    this.sheenAssets?.cubeTexture.dispose();
    this.sheenAssets = null;
    this.material.dispose();
    this.lensMaterial.dispose();
    this.modelPartOutlineMaterial.dispose();
    this.modelPartOutlineHoverMaterial.dispose();
    this.modelPartHoverMaterial.dispose();
    this.lensNormalTexture?.dispose();
    this.backplateLoadToken++;
    this.backplateTexture?.dispose();
    this.materialLoadToken++;
    this.normalTexture?.dispose();
    this.exponentTexture?.dispose();
    this.lightwarpTexture?.dispose();
    this.selfIllumTexture?.dispose();
    this.detailTexture?.dispose();
    this.emissiveMaterial?.dispose();
    for (const texture of this.emissiveTextures) texture.dispose();
    this.environmentLoadToken++;
    this.customEnvMap?.dispose();
    if (this.mapEnvMap && this.mapEnvMap !== this.defaultEnvMap) this.mapEnvMap.dispose();
    if (this.editorEnvMap !== this.defaultEnvMap && this.editorEnvMap !== this.mapEnvMap) this.editorEnvMap.dispose();
    this.defaultEnvMap.dispose();
    for (const cullable of this.cullableGeometries) cullable.dispose();
    this.cullableGeometries = [];
    this.attachments.forEach(disposeAttachment);
    this.attachments = [];
    this.modelLoader.dispose();
    this.renderer.dispose();
  }
}
