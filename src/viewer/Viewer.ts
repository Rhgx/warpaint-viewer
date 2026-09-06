import * as THREE from 'three';
import { getPreset, LEGACY_PAINTKIT_ICON_LIGHTING_ID } from './lighting';
import {
  CUSTOM_LIGHTING_ID,
  CUSTOM_LIGHT_POSITION_LIMIT,
  createDefaultCustomLightingRig,
  validateCustomLightingRig,
  type CustomLightingRig,
} from './customLighting';
import { LightEditor } from './lightEditor';
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
import type { WeaponMaterial } from '../data/types';
import {
  fitScreenshotCapture,
  resolveScreenshotCapture,
  screenshotPixelsToBlob,
  type ScreenshotSize,
} from './capture';
import { computeModelBounds, ModelLoader, type ModelPart } from './modelLoader';
import { CullableGeometry } from './modelCulling';
import { configureTf2Material, createTf2Uniforms } from './materialConfig';
import { EDITOR_LAYER_MAP_COLORS } from '../editor/layerMap';
import {
  moveStickerQuadToUv,
  stickerQuadCenter,
  type StickerPlacementQuad,
} from '../editor/viewerStickerPlacement';
import {
  deriveStickerGizmoScreenCentre,
  hasUsableStickerGizmoScaleDirection,
  moveStickerQuadByUvDelta,
  rotateStickerQuadByDegrees,
  scaleStickerQuadAxisAroundCentre,
  scaleStickerQuadAroundCentre,
  stickerGizmoScreenAxisRatio,
  stickerGizmoAnchorContainsCentre,
  stickerGizmoFallbackHandles,
  stickerGizmoIntentForHandle,
  type StickerGizmoHandleKind,
  type StickerGizmoIntent,
  type StickerGizmoScreenPoint,
  type StickerGizmoTool,
  stickerGizmoTurnHandle,
} from '../editor/stickerGizmo';
import {
  buildStickerUvTopology,
  type StickerUvCandidate,
  type StickerUvTopology,
  type StickerUvTopologyTriangle,
} from '../editor/stickerUvTopology';
import { visibleStickerEditorMap } from './stickerEditorMap';

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

/** Controls the temporary UV-space sticker shown during an editor gesture. */
export interface StickerPreviewOptions {
  /** Opacity of the decal preview. Defaults to the authored sticker alpha. */
  readonly opacity?: number;
  /** Optional linear specular mask paired with an ordinary sticker. */
  readonly specularUrl?: string | null;
  /** Active direct-manipulation affordance shown on the model. */
  readonly tool?: StickerGizmoTool;
}

/** Cached compositor inputs used to move a selector-writing group sticker. */
export interface GroupStickerPreviewResources {
  readonly selectorBase: THREE.Texture;
  readonly endpointZero: THREE.Texture;
  readonly endpointOne: THREE.Texture;
  readonly levels: readonly [black: number, white: number, gamma: number];
}

/** A projected, visible sticker transform control. Client coordinates match pointer events. */
interface StickerGizmoHandle {
  readonly kind: StickerGizmoHandleKind;
  readonly clientX: number;
  readonly clientY: number;
}

/** Snapshot consumed by the workbench when routing pointer gestures to Viewer. */
export interface StickerGizmoState {
  readonly tool: StickerGizmoTool;
  readonly handles: readonly StickerGizmoHandle[];
  /** Full projected decal outline, present only when all four corners are visible. */
  readonly outline: readonly StickerGizmoHandle[];
  readonly centre: StickerGizmoHandle | null;
}

export interface StickerGizmoDrag {
  readonly handle: StickerGizmoHandleKind;
  readonly intent: StickerGizmoIntent;
  readonly baseQuad: StickerPlacementQuad;
  readonly startClientX: number;
  readonly startClientY: number;
  /** Required by move; absent for screen-space scale/turn controls. */
  readonly startUv?: readonly [number, number];
  readonly centreClientX: number;
  readonly centreClientY: number;
  readonly handleClientX: number;
  readonly handleClientY: number;
  readonly startAngleRadians: number;
}

export interface StickerGizmoDragResult {
  readonly intent: StickerGizmoIntent;
  readonly quad: StickerPlacementQuad;
}

interface VisibleStickerGizmoPoint {
  readonly point: THREE.Vector3 | null;
  /** Camera-space distance used only to resolve equivalent chart scores. */
  readonly depth: number;
  /** Distance from the authored base UV tile. Zero is the direct model copy. */
  readonly tileDistance: number;
}

interface VisibleStickerGizmoChart {
  readonly chartId: number;
  readonly points: readonly VisibleStickerGizmoPoint[];
  /** Whether each requested UV is actually contained by this physical chart. */
  readonly containedTargets: readonly boolean[];
}

interface StickerGizmoChartScore {
  readonly centre: number;
  readonly centreTile: number;
  readonly corners: number;
  readonly edges: number;
  readonly tileDistance: number;
  readonly depth: number;
}

function compareStickerGizmoChartScores(left: StickerGizmoChartScore, right: StickerGizmoChartScore): number {
  return right.centre - left.centre
    || left.centreTile - right.centreTile
    || right.corners - left.corners
    || right.edges - left.edges
    || left.tileDistance - right.tileDistance
    || left.depth - right.depth;
}

// three.js viewer with TF2's important VertexLitGeneric/Skin controls layered
// onto MeshPhongMaterial: base-alpha phong mask, exponent/lightwarp textures,
// optional tangent normal, albedo tint, Fresnel, rim light, and env-map mask.
// Interaction is handled by InspectControls (model rotates, camera stays fixed,
// like the in-game inspect panel). The model never moves on its own.
export class Viewer {
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
  // Gizmo visibility samples set a short far plane; keep that mutable state
  // separate from normal pointer picking so a later move ray never inherits
  // the final control sample's range.
  private stickerGizmoRaycaster = new THREE.Raycaster();
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
  private defaultEnvMap: THREE.CubeTexture;
  private customEnvMap: THREE.CubeTexture | null = null;
  private backplateTexture: THREE.Texture | null = null;
  private backplateLoadToken = 0;
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
  private transformIsolationMaterial: THREE.MeshPhongMaterial | null = null;
  private transformIsolationMeshes: THREE.Mesh[] = [];
  private transformIsolationBaseState: {
    readonly opacity: number;
    readonly transparent: boolean;
    readonly depthWrite: boolean;
  } | null = null;

  // Editor sticker preview: another copy of the actual weapon geometry, not
  // a plane in world space. The fragment shader turns each mesh UV back into
  // the sticker's local UV, so a preview follows the same texture placement
  // that will be exported to the proto definition.
  private stickerPreviewMaterial: THREE.ShaderMaterial | null = null;
  private stickerPreviewMeshes: THREE.Mesh[] = [];
  private stickerPreviewTexture: THREE.Texture | null = null;
  private stickerPreviewSpecTexture: THREE.Texture | null = null;
  private stickerPreviewUrl: string | null = null;
  private stickerPreviewSpecUrl: string | null = null;
  private stickerPreviewMode: 'decal' | 'group' | null = null;
  private stickerPreviewLoadToken = 0;
  // The normal compositor map remains current even while the Sticker editor
  // temporarily shows the exact pre-sticker surface below its live decal.
  // Keeping these as separate sources prevents a late normal recomposition
  // from overwriting the editor base and exposing a stale baked sticker.
  private composedMap: THREE.Texture | null = null;
  private stickerEditorBaseMap: THREE.Texture | null = null;

  // The sticker gizmo deliberately lives in a tiny SVG sibling above the
  // canvas. It is screen-space for reliable, recognisable handle sizes, but
  // every point is derived from the weapon's UV geometry and all transforms
  // return authored UV coordinates.
  private stickerGizmoQuad: StickerPlacementQuad | null = null;
  private stickerGizmoTool: StickerGizmoTool = 'move';
  private stickerGizmoState: StickerGizmoState | null = null;
  private stickerGizmoOverlay: SVGSVGElement | null = null;
  private stickerGizmoProjectionKey = '';
  private stickerGizmoPointerId: number | null = null;
  // A decal must stay attached to one physical UV chart. This cache is built
  // only when model geometry changes; every live camera/drag frame queries it
  // rather than rediscovering overlapping UV instances independently.
  private stickerUvTopology: StickerUvTopology | null = null;
  private stickerUvTopologyTriangles = new Map<string, StickerUvTopologyTriangle>();
  private stickerGizmoAnchorChartId: number | null = null;

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
      (this.stickerGizmoQuad !== null
        && this.hitTestStickerGizmo(event.clientX, event.clientY) !== null)
      || this.lightEditor?.shouldExcludeCameraPointer(event) === true
    ));
    this.canvas.addEventListener('pointermove', this.onStickerGizmoPointerMove);
    this.canvas.addEventListener('pointerdown', this.onStickerGizmoPointerDown);
    // React captures editor drags on the canvas wrapper, which means the
    // matching up/cancel may no longer target the canvas itself. Window keeps
    // this small cursor state in sync without competing with the gesture.
    window.addEventListener('pointerup', this.onStickerGizmoPointerUp);
    window.addEventListener('pointercancel', this.onStickerGizmoPointerUp);

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

    this.texLoader.loadAsync('/data/textures/models/workshop/weapons/c_models/c_bazaar_sniper/c_bazaar_sniper_lens.webp').then((texture) => {
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
        this.envMap.dispose();
        this.envMap = texture;
        this.defaultEnvMap = texture;
        this.material.envMap = texture;
        this.material.needsUpdate = true;
        this.lensMaterial.envMap = texture;
        this.lensMaterial.needsUpdate = true;
        this.invalidate();
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
    this.resizeObserver = new ResizeObserver(() => {
      this.syncDisplayAspect();
      this.invalidate();
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

  private onStickerGizmoPointerMove = (event: PointerEvent) => {
    if (this.disposed || !this.stickerGizmoQuad) {
      this.canvas.style.cursor = '';
      return;
    }
    const handle = this.hitTestStickerGizmo(event.clientX, event.clientY);
    if (!handle) {
      if (this.stickerGizmoPointerId === null) this.canvas.style.cursor = '';
      return;
    }
    if (handle === 'move') {
      this.canvas.style.cursor = this.stickerGizmoPointerId !== null ? 'grabbing' : 'grab';
      return;
    }
    if (handle === 'rotate') {
      this.canvas.style.cursor = this.stickerGizmoPointerId !== null ? 'grabbing' : 'crosshair';
      return;
    }
    if (handle === 'scale-left' || handle === 'scale-right') {
      this.canvas.style.cursor = 'ew-resize';
      return;
    }
    if (handle === 'scale-top' || handle === 'scale-bottom') {
      this.canvas.style.cursor = 'ns-resize';
      return;
    }
    this.canvas.style.cursor = handle === 'scale-top-left' || handle === 'scale-bottom-right'
      ? 'nwse-resize'
      : 'nesw-resize';
  };

  private onStickerGizmoPointerDown = (event: PointerEvent) => {
    if (!this.stickerGizmoQuad || event.button !== 0) return;
    this.stickerGizmoPointerId = this.hitTestStickerGizmo(event.clientX, event.clientY) !== null ? event.pointerId : null;
    if (this.stickerGizmoPointerId !== null) this.onStickerGizmoPointerMove(event);
  };

  private onStickerGizmoPointerUp = (event: PointerEvent) => {
    if (this.stickerGizmoPointerId !== event.pointerId) return;
    this.stickerGizmoPointerId = null;
    this.canvas.style.cursor = '';
  };

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
    if (this.disposed || this.raf || document.hidden) return;
    this.raf = requestAnimationFrame(this.renderFrame);
  }

  private onVisibilityChange = () => {
    this.lastTime = performance.now();
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    this.invalidate();
  };

  private renderFrame = () => {
    this.raf = 0;
    if (this.disposed || document.hidden) return;
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const controlsAnimating = this.controls.update(dt);
    // The pass reads $time, which only moves the picture when the scroll
    // vector is non-zero. Wrapped so a long session cannot drift the sample
    // out of the range where float precision still resolves texels.
    const scroll: THREE.Vector2 | undefined = this.emissiveMaterial?.uniforms.uEmissiveScroll.value;
    const emissiveAnimating = this.emissiveEnabled && !!scroll && scroll.lengthSq() > 0;
    if (emissiveAnimating && this.emissiveMaterial) {
      const period = Math.max(1 / Math.max(Math.abs(scroll.x), Math.abs(scroll.y)), 1);
      this.emissiveElapsed = (this.emissiveElapsed + dt) % period;
      this.emissiveMaterial.uniforms.uEmissiveTime.value = this.emissiveElapsed;
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
    this.updateSheenAnimation(dt);
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
      this.updateStickerGizmoOverlay();
      this.renderer.render(this.scene, this.orthoCamera);
    } else {
      this.updateStickerGizmoOverlay();
      this.renderer.render(this.scene, this.camera);
    }
    const sheenAnimating = this.sheenId !== 'none' && this.sheenMaterial !== null && this.sheenMeshes.length > 0;
    if (controlsAnimating || sheenAnimating || emissiveAnimating || this.activeUnusual) this.invalidate();
  };

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
    this.material.map = visibleStickerEditorMap(this.composedMap, this.stickerEditorBaseMap);
    this.material.needsUpdate = true;
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
    if (wasOff) this.sheenElapsed = 0;
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
    for (const mesh of this.sheenMeshes) this.centerGroup.remove(mesh);
    this.sheenMeshes = [];
  }

  private rebuildSheenMeshes() {
    this.teardownSheenMeshes();
    if (this.sheenId === 'none' || !this.sheenMaterial) return;
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
  private updateSheenAnimation(dt: number) {
    if (this.sheenId === 'none' || !this.sheenMaterial || this.sheenMeshes.length === 0) return;
    this.sheenElapsed += dt;
    const cycle = SHEEN_SWEEP_SECONDS + SHEEN_PAUSE_SECONDS;
    const tInCycle = this.sheenElapsed % cycle;
    const sweeping = tInCycle < SHEEN_SWEEP_SECONDS;
    for (const mesh of this.sheenMeshes) mesh.visible = sweeping;
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

  /**
   * Returns the first current-weapon surface under a viewport client point.
   * The returned UV is the geometry's unmodified UV: U increases to the right
   * and, because the viewer uploads weapon textures with `flipY = false`, V
   * increases downward into the source image data.
  */
  pickWeaponUv(clientX: number, clientY: number): { uv: [number, number]; chartId: number | null } | null {
    if (this.disposed || this.meshes.length === 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0
      || clientX < rect.left || clientX > rect.right
      || clientY < rect.top || clientY > rect.bottom) return null;

    this.pickNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    // Input can arrive between renders, while InspectControls/model transforms
    // have changed but their cached matrixWorld values have not yet been used.
    this.scene.updateMatrixWorld(true);
    let camera: THREE.Camera = this.camera;
    if (this.projectionMode === 'orthographic') {
      this.syncOrthoCamera();
      camera = this.orthoCamera;
    }
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pickNdc, camera);
    const hit = this.raycaster.intersectObjects(this.paintableMeshes, false)[0];
    if (!hit?.uv || !Number.isFinite(hit.uv.x) || !Number.isFinite(hit.uv.y)) return null;
    return { uv: [hit.uv.x, hit.uv.y], chartId: this.stickerGizmoChartForRaycastHit(hit) };
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
    this.resetStickerUvTopology();
    this.stickerGizmoState = null;
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
    this.resetStickerUvTopology();
    this.stickerGizmoState = null;
    this.invalidate();
  }

  /**
   * Raycast a pointer into a translated sticker destination without changing
   * the camera or starting an orbit gesture. The editor owns when this method
   * is called (normally only while its explicit placement gesture is active).
   */
  moveStickerQuadToClientPoint(
    quad: StickerPlacementQuad,
    clientX: number,
    clientY: number,
  ): StickerPlacementQuad | null {
    const hit = this.pickWeaponUv(clientX, clientY);
    if (hit) this.setStickerGizmoAnchorChart(hit.chartId);
    return hit ? moveStickerQuadToUv(quad, hit.uv) : null;
  }

  /**
   * Set or clear the on-model transform controls for an authored sticker
   * destination. Unlike setStickerPreview this does not load an image, which
   * makes it suitable while a control panel changes selection.
   */
  setStickerGizmo(quad: StickerPlacementQuad | null, tool: StickerGizmoTool = 'move'): void {
    const toolChanged = this.stickerGizmoTool !== tool;
    this.stickerGizmoQuad = quad && this.isUsableStickerQuad(quad) ? quad : null;
    this.stickerGizmoTool = tool;
    if (!this.stickerGizmoQuad || toolChanged) {
      this.stickerGizmoPointerId = null;
      this.canvas.style.cursor = '';
    }
    this.stickerGizmoProjectionKey = '';
    // Projection walks paintable UV triangles. A live 2D edit already
    // invalidates the next render, whose normal overlay pass performs this
    // work once; doing it here as well makes every pointer move scan the mesh
    // twice and starves the DOM editor of paint time.
    this.invalidate();
  }

  /** Forget the selected physical UV copy when the edited sticker changes. */
  resetStickerGizmoAnchor(): void {
    this.stickerGizmoAnchorChartId = null;
    this.stickerGizmoProjectionKey = '';
    this.stickerGizmoState = null;
    this.stickerGizmoPointerId = null;
    this.canvas.style.cursor = '';
    this.invalidate();
  }

  /** Latest visible projected controls, or null when the sticker is obscured. */
  getStickerGizmoState(): StickerGizmoState | null {
    return this.stickerGizmoState;
  }

  /** Hit-test a viewport pointer against the compact, screen-space handles. */
  hitTestStickerGizmo(clientX: number, clientY: number): StickerGizmoHandleKind | null {
    // This path is called directly from InspectControls' native pointer
    // handler. It must consume the last rendered projection only: a pointer
    // down should never trigger a DOM read and a full UV-triangle walk before
    // the controls decide whether they own the gesture.
    const state = this.stickerGizmoState;
    if (!state || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    // Check only the active tool's small, precise controls. This leaves all
    // empty canvas space to InspectControls and prevents inactive affordances
    // from capturing a drag unexpectedly.
    const ordered = state.handles;
    for (const handle of ordered) {
      const radius = handle.kind === 'move' ? 11 : handle.kind === 'rotate' ? 12 : 10;
      if (Math.hypot(clientX - handle.clientX, clientY - handle.clientY) <= radius) return handle.kind;
    }
    // The outline is visual context, not a catch-all drag target. Reserving
    // only the attached centre grip keeps an occluded/empty body click with
    // InspectControls instead of beginning a move that has no UV hit.
    return null;
  }

  /**
   * Capture a transform baseline. The workbench owns pointer capture and can
   * safely pass this opaque value back to updateStickerGizmoDrag() without
   * risking an inspect-camera orbit underneath a direct manipulation.
   */
  beginStickerGizmoDrag(
    clientX: number,
    clientY: number,
    quad: StickerPlacementQuad,
  ): StickerGizmoDrag | null {
    if (!this.isUsableStickerQuad(quad)) return null;
    const handle = this.hitTestStickerGizmo(clientX, clientY);
    const state = this.stickerGizmoState;
    if (!handle || !state) return null;
    const centre = state.centre;
    if (!centre) return null;
    const activeHandle = state.handles.find((candidate) => candidate.kind === handle);
    if (!activeHandle) return null;
    const startHit = handle === 'move' ? this.pickWeaponUv(clientX, clientY) : null;
    if (startHit) this.setStickerGizmoAnchorChart(startHit.chartId);
    const startUv = startHit?.uv;
    // Only movement needs an initial UV hit. Screen-space scale and turn stay
    // active when their pointer leaves the weapon silhouette.
    if (handle === 'move' && !startUv) return null;
    return {
      handle,
      intent: stickerGizmoIntentForHandle(handle),
      baseQuad: quad,
      startClientX: clientX,
      startClientY: clientY,
      startUv,
      centreClientX: centre.clientX,
      centreClientY: centre.clientY,
      handleClientX: activeHandle.clientX,
      handleClientY: activeHandle.clientY,
      startAngleRadians: Math.atan2(clientY - centre.clientY, clientX - centre.clientX),
    };
  }

  /**
   * Apply a live gizmo drag and return only UV-space authored destination
   * points. The result is intentionally side-effect-free: caller previews it
   * with setStickerPreview and commits a single undoable proto edit on release.
   */
  updateStickerGizmoDrag(
    drag: StickerGizmoDrag,
    clientX: number,
    clientY: number,
    preserveAspect = false,
  ): StickerGizmoDragResult | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY) || !this.isUsableStickerQuad(drag.baseQuad)) return null;
    if (drag.intent === 'rotate') {
      const nextAngle = Math.atan2(clientY - drag.centreClientY, clientX - drag.centreClientX);
      const delta = THREE.MathUtils.radToDeg(nextAngle - drag.startAngleRadians);
      return { intent: 'rotate', quad: rotateStickerQuadByDegrees(drag.baseQuad, delta) };
    }
    if (drag.intent === 'move') {
      const hit = this.pickWeaponUv(clientX, clientY);
      if (!hit || !drag.startUv) return null;
      // A direct 3D move is an explicit choice of physical surface. Carry that
      // choice with the UV edit so the controls follow across disconnected UV
      // charts instead of remaining attached to the drag's starting island.
      this.setStickerGizmoAnchorChart(hit.chartId);
      return { intent: 'move', quad: moveStickerQuadByUvDelta(drag.baseQuad, drag.startUv, hit.uv) };
    }
    const ratio = stickerGizmoScreenAxisRatio(
      { x: drag.centreClientX, y: drag.centreClientY },
      { x: drag.handleClientX, y: drag.handleClientY },
      { x: drag.startClientX, y: drag.startClientY },
      { x: clientX, y: clientY },
    );
    if (preserveAspect) {
      return { intent: 'scale', quad: scaleStickerQuadAroundCentre(drag.baseQuad, ratio) };
    }
    if (drag.handle === 'scale-left' || drag.handle === 'scale-right') {
      return { intent: 'scale', quad: scaleStickerQuadAxisAroundCentre(drag.baseQuad, 'x', ratio) };
    }
    if (drag.handle === 'scale-top' || drag.handle === 'scale-bottom') {
      return { intent: 'scale', quad: scaleStickerQuadAxisAroundCentre(drag.baseQuad, 'y', ratio) };
    }
    return { intent: 'scale', quad: scaleStickerQuadAroundCentre(drag.baseQuad, ratio) };
  }

  /**
   * Show a temporary sticker exactly in weapon UV space. This does not change
   * the composed paint or source definition; callers commit the returned quad
   * from `moveStickerQuadToClientPoint` only after their gesture completes.
   *
   * Ordinary wrapping seams are handled in the preview shader by choosing the
   * nearest periodic UV copy. Mirrored or overlapping UV islands cannot be
   * made unambiguous by raycasting: Source will draw the same texture-space
   * sticker on every face that shares the relevant UVs.
   */
  setStickerPreview(
    textureUrl: string | null,
    quad: StickerPlacementQuad | null,
    options: StickerPreviewOptions = {},
  ): void {
    if (this.disposed || !textureUrl || !this.setStickerPreviewQuad(quad, options.opacity)) {
      this.clearStickerPreview();
      return;
    }
    this.setStickerGizmo(quad, options.tool ?? this.stickerGizmoTool);

    this.loadLitStickerPreviewTextures(textureUrl, options.specularUrl ?? null);
  }

  /**
   * Preview a group sticker from its original mask and cached selector
   * endpoints. Movement changes only destination uniforms, so it cannot bake
   * nearby stickers or lose pixels clipped at the authored destination.
   */
  setGroupStickerPreview(
    maskUrl: string | null,
    resources: GroupStickerPreviewResources | null,
    quad: StickerPlacementQuad | null,
    options: StickerPreviewOptions = {},
  ): void {
    if (this.disposed || !maskUrl || !resources || !this.setStickerPreviewQuad(quad, options.opacity)) {
      this.clearStickerPreview();
      return;
    }
    this.setStickerGizmo(quad, options.tool ?? this.stickerGizmoTool);
    const material = this.ensureStickerPreviewMaterial();
    material.uniforms.uPreviewMode.value = 1;
    material.uniforms.uSelectorBase.value = resources.selectorBase;
    material.uniforms.uEndpointZero.value = resources.endpointZero;
    material.uniforms.uEndpointOne.value = resources.endpointOne;
    (material.uniforms.uGroupLevels.value as THREE.Vector3).fromArray(resources.levels);
    this.loadStickerPreviewTexture(maskUrl, 'group');
  }

  private loadStickerPreviewTexture(textureUrl: string, mode: 'decal' | 'group'): void {
    const material = this.ensureStickerPreviewMaterial();
    this.tf2Uniforms.uTf2StickerPreview.value = 0;
    this.tf2Uniforms.uTf2StickerMap.value = null;
    this.tf2Uniforms.uTf2StickerSpecMap.value = null;
    this.tf2Uniforms.uTf2StickerHasSpec.value = 0;
    this.stickerPreviewSpecTexture?.dispose();
    this.stickerPreviewSpecTexture = null;
    this.stickerPreviewSpecUrl = null;

    if (textureUrl === this.stickerPreviewUrl && mode === this.stickerPreviewMode && this.stickerPreviewTexture) {
      // Position lives in shader uniforms, so a transform drag must not tear
      // down and recreate one overlay mesh per paintable sub-mesh on every
      // pointer event. Rebuild only if a model replacement removed them.
      if (this.stickerPreviewMeshes.length === 0) this.rebuildStickerPreviewMeshes();
      this.invalidate();
      return;
    }

    const token = ++this.stickerPreviewLoadToken;
    this.stickerPreviewUrl = textureUrl;
    this.stickerPreviewMode = mode;
    this.teardownStickerPreviewMeshes();
    this.stickerPreviewTexture?.dispose();
    this.stickerPreviewTexture = null;
    material.uniforms.uStickerMap.value = null;
    this.texLoader.loadAsync(textureUrl).then((texture) => {
      if (token !== this.stickerPreviewLoadToken || this.disposed || textureUrl !== this.stickerPreviewUrl
        || mode !== this.stickerPreviewMode) {
        texture.dispose();
        return;
      }
      texture.colorSpace = mode === 'group' ? THREE.NoColorSpace : THREE.SRGBColorSpace;
      texture.flipY = false; // Same convention as the composited weapon texture.
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      this.stickerPreviewTexture = texture;
      const material = this.ensureStickerPreviewMaterial();
      material.uniforms.uStickerMap.value = texture;
      this.rebuildStickerPreviewMeshes();
      this.invalidate();
    }).catch(() => {
      // A broken optional preview source must not leave stale artwork attached
      // to the model. The editor still retains its authored values.
      if (token !== this.stickerPreviewLoadToken) return;
      this.stickerPreviewUrl = null;
      this.clearStickerPreview();
    });
  }

  private loadLitStickerPreviewTextures(textureUrl: string, specularUrl: string | null): void {
    if (textureUrl === this.stickerPreviewUrl
      && specularUrl === this.stickerPreviewSpecUrl
      && this.stickerPreviewMode === 'decal'
      && this.stickerPreviewTexture) {
      this.tf2Uniforms.uTf2StickerPreview.value = 1;
      this.tf2Uniforms.uTf2StickerMap.value = this.stickerPreviewTexture;
      this.tf2Uniforms.uTf2StickerSpecMap.value = this.stickerPreviewSpecTexture ?? this.stickerPreviewTexture;
      this.tf2Uniforms.uTf2StickerHasSpec.value = this.stickerPreviewSpecTexture ? 1 : 0;
      this.teardownStickerPreviewMeshes();
      this.invalidate();
      return;
    }

    const token = ++this.stickerPreviewLoadToken;
    this.stickerPreviewUrl = textureUrl;
    this.stickerPreviewSpecUrl = specularUrl;
    this.stickerPreviewMode = 'decal';
    this.teardownStickerPreviewMeshes();
    this.stickerPreviewTexture?.dispose();
    this.stickerPreviewSpecTexture?.dispose();
    this.stickerPreviewTexture = null;
    this.stickerPreviewSpecTexture = null;
    this.tf2Uniforms.uTf2StickerPreview.value = 0;
    this.tf2Uniforms.uTf2StickerMap.value = null;
    this.tf2Uniforms.uTf2StickerSpecMap.value = null;
    this.tf2Uniforms.uTf2StickerHasSpec.value = 0;

    const base = this.texLoader.loadAsync(textureUrl);
    const spec = specularUrl ? this.texLoader.loadAsync(specularUrl).catch(() => null) : Promise.resolve(null);
    void Promise.all([base, spec]).then(([texture, specular]) => {
      if (token !== this.stickerPreviewLoadToken || this.disposed
        || textureUrl !== this.stickerPreviewUrl || specularUrl !== this.stickerPreviewSpecUrl
        || this.stickerPreviewMode !== 'decal') {
        texture.dispose();
        specular?.dispose();
        return;
      }
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.flipY = false;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      if (specular) {
        specular.colorSpace = THREE.NoColorSpace;
        specular.flipY = false;
        specular.wrapS = specular.wrapT = THREE.RepeatWrapping;
      }
      this.stickerPreviewTexture = texture;
      this.stickerPreviewSpecTexture = specular;
      this.tf2Uniforms.uTf2StickerMap.value = texture;
      this.tf2Uniforms.uTf2StickerSpecMap.value = specular ?? texture;
      this.tf2Uniforms.uTf2StickerHasSpec.value = specular ? 1 : 0;
      this.tf2Uniforms.uTf2StickerPreview.value = 1;
      this.invalidate();
    }).catch(() => {
      if (token !== this.stickerPreviewLoadToken) return;
      this.clearStickerPreview();
    });
  }

  /** Remove the temporary UV decal and release its GPU texture. */
  clearStickerPreview(): void {
    this.stickerPreviewLoadToken++;
    this.stickerPreviewUrl = null;
    this.stickerPreviewSpecUrl = null;
    this.stickerPreviewMode = null;
    this.teardownStickerPreviewMeshes();
    this.stickerPreviewTexture?.dispose();
    this.stickerPreviewSpecTexture?.dispose();
    this.stickerPreviewTexture = null;
    this.stickerPreviewSpecTexture = null;
    this.tf2Uniforms.uTf2StickerPreview.value = 0;
    this.tf2Uniforms.uTf2StickerMap.value = null;
    this.tf2Uniforms.uTf2StickerSpecMap.value = null;
    this.tf2Uniforms.uTf2StickerHasSpec.value = 0;
    if (this.stickerPreviewMaterial) {
      this.stickerPreviewMaterial.uniforms.uStickerMap.value = null;
      this.stickerPreviewMaterial.uniforms.uSelectorBase.value = null;
      this.stickerPreviewMaterial.uniforms.uEndpointZero.value = null;
      this.stickerPreviewMaterial.uniforms.uEndpointOne.value = null;
    }
    this.stickerGizmoAnchorChartId = null;
    this.setStickerGizmo(null);
    this.invalidate();
  }

  private setStickerPreviewQuad(quad: StickerPlacementQuad | null, opacity: number | undefined): boolean {
    if (!quad || ![quad.tl, quad.tr, quad.bl].every((uv) => Number.isFinite(uv[0]) && Number.isFinite(uv[1]))) return false;
    const x0 = quad.tr[0] - quad.tl[0];
    const y0 = quad.tr[1] - quad.tl[1];
    const x1 = quad.bl[0] - quad.tl[0];
    const y1 = quad.bl[1] - quad.tl[1];
    if (Math.abs(x0 * y1 - y0 * x1) < 1e-8) return false;
    const material = this.ensureStickerPreviewMaterial();
    material.uniforms.uStickerTl.value.set(quad.tl[0], quad.tl[1]);
    material.uniforms.uStickerTr.value.set(quad.tr[0], quad.tr[1]);
    material.uniforms.uStickerBl.value.set(quad.bl[0], quad.bl[1]);
    material.uniforms.uStickerCenter.value.set(
      quad.tl[0] + (x0 + x1) * 0.5,
      quad.tl[1] + (y0 + y1) * 0.5,
    );
    material.uniforms.uStickerOpacity.value = THREE.MathUtils.clamp(opacity ?? 1, 0, 1);
    this.tf2Uniforms.uTf2StickerTl.value.copy(material.uniforms.uStickerTl.value);
    this.tf2Uniforms.uTf2StickerTr.value.copy(material.uniforms.uStickerTr.value);
    this.tf2Uniforms.uTf2StickerBl.value.copy(material.uniforms.uStickerBl.value);
    this.tf2Uniforms.uTf2StickerCenter.value.copy(material.uniforms.uStickerCenter.value);
    this.tf2Uniforms.uTf2StickerOpacity.value = material.uniforms.uStickerOpacity.value;
    return true;
  }

  private ensureStickerPreviewMaterial(): THREE.ShaderMaterial {
    if (this.stickerPreviewMaterial) return this.stickerPreviewMaterial;
    this.stickerPreviewMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uStickerMap: { value: null as THREE.Texture | null },
        uSelectorBase: { value: null as THREE.Texture | null },
        uEndpointZero: { value: null as THREE.Texture | null },
        uEndpointOne: { value: null as THREE.Texture | null },
        uPreviewMode: { value: 0 },
        uGroupLevels: { value: new THREE.Vector3(0, 1, 1) },
        uStickerTl: { value: new THREE.Vector2() },
        uStickerTr: { value: new THREE.Vector2(1, 0) },
        uStickerBl: { value: new THREE.Vector2(0, 1) },
        uStickerCenter: { value: new THREE.Vector2(0.5, 0.5) },
        uStickerOpacity: { value: 1 },
      },
      vertexShader: `
        varying vec2 vStickerUv;
        void main() {
          vStickerUv = uv;
          #include <begin_vertex>
          #include <project_vertex>
        }
      `,
      fragmentShader: `
        #include <common>
        uniform sampler2D uStickerMap;
        uniform sampler2D uSelectorBase;
        uniform sampler2D uEndpointZero;
        uniform sampler2D uEndpointOne;
        uniform float uPreviewMode;
        uniform vec3 uGroupLevels;
        uniform vec2 uStickerTl;
        uniform vec2 uStickerTr;
        uniform vec2 uStickerBl;
        uniform vec2 uStickerCenter;
        uniform float uStickerOpacity;
        varying vec2 vStickerUv;

        vec4 adjustGroupMask(vec4 source) {
          float black = uGroupLevels.x;
          float white = uGroupLevels.y;
          float gamma = uGroupLevels.z;
          vec4 normalized;
          if (white == black) {
            normalized = vec4(greaterThan(source, vec4(black)));
          } else {
            normalized = clamp((source - black) / (white - black), 0.0, 1.0);
          }
          return pow(normalized, vec4(gamma));
        }

        void main() {
          // Select the nearest periodic copy first, allowing a compact decal
          // to straddle the 0/1 seam instead of spanning the whole texture.
          vec2 sourceUv = vStickerUv + floor(uStickerCenter - vStickerUv + vec2(0.5));
          vec2 axisX = uStickerTr - uStickerTl;
          vec2 axisY = uStickerBl - uStickerTl;
          vec2 local = sourceUv - uStickerTl;
          float determinant = axisX.x * axisY.y - axisX.y * axisY.x;
          if (abs(determinant) < 0.00000001) discard;
          vec2 stickerUv = vec2(
            (local.x * axisY.y - local.y * axisY.x) / determinant,
            (axisX.x * local.y - axisX.y * local.x) / determinant
          );
          if (stickerUv.x < 0.0 || stickerUv.x > 1.0 || stickerUv.y < 0.0 || stickerUv.y > 1.0) discard;
          vec4 sticker = texture2D(uStickerMap, stickerUv);
          if (uPreviewMode > 0.5) {
            vec4 mask = adjustGroupMask(sticker);
            if (mask.a <= 0.001) discard;
            float selectorBase = sRGBTransferEOTF(texture2D(uSelectorBase, vStickerUv)).r;
            float selector = mix(selectorBase, mask.r, mask.a);
            vec4 endpointZero = sRGBTransferEOTF(texture2D(uEndpointZero, vStickerUv));
            vec4 endpointOne = sRGBTransferEOTF(texture2D(uEndpointOne, vStickerUv));
            vec3 desired = mix(endpointZero.rgb, endpointOne.rgb, selector);
            gl_FragColor = vec4(desired, uStickerOpacity);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
            return;
          }
          if (sticker.a <= 0.001) discard;
          gl_FragColor = vec4(sRGBTransferEOTF(sticker).rgb, sticker.a * uStickerOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: this.material.side,
    });
    return this.stickerPreviewMaterial;
  }

  private teardownStickerPreviewMeshes() {
    for (const mesh of this.stickerPreviewMeshes) this.centerGroup.remove(mesh);
    this.stickerPreviewMeshes = [];
  }

  private rebuildStickerPreviewMeshes() {
    this.teardownStickerPreviewMeshes();
    if (this.stickerPreviewMode !== 'group' || !this.stickerPreviewTexture || !this.stickerPreviewMaterial) return;
    this.stickerPreviewMaterial.side = this.material.side;
    for (const mesh of this.paintableMeshes) {
      const preview = new THREE.Mesh(mesh.geometry, this.stickerPreviewMaterial);
      // Draw above the all-layer cue (1) and focused group cue (2), while
      // retaining normal depth testing against the weapon itself.
      preview.renderOrder = 3;
      this.centerGroup.add(preview);
      this.stickerPreviewMeshes.push(preview);
    }
  }

  private isUsableStickerQuad(quad: StickerPlacementQuad): boolean {
    if (![quad.tl, quad.tr, quad.bl].every((uv) => Number.isFinite(uv[0]) && Number.isFinite(uv[1]))) return false;
    const axisX = new THREE.Vector2(quad.tr[0] - quad.tl[0], quad.tr[1] - quad.tl[1]);
    const axisY = new THREE.Vector2(quad.bl[0] - quad.tl[0], quad.bl[1] - quad.tl[1]);
    return Math.abs(axisX.cross(axisY)) >= 1e-8;
  }

  private getActiveProjectionCamera(): THREE.Camera {
    if (this.projectionMode === 'orthographic') {
      this.syncOrthoCamera();
      return this.orthoCamera;
    }
    return this.camera;
  }

  private stickerTopologyFaceKey(meshIndex: number, triangleIndex: number): string {
    return `${meshIndex}:${triangleIndex}`;
  }

  private resetStickerUvTopology() {
    this.stickerGizmoAnchorChartId = null;
    this.stickerUvTopologyTriangles.clear();
    this.stickerUvTopology = this.paintableMeshes.length > 0
      ? buildStickerUvTopology(this.paintableMeshes.map((mesh) => mesh.geometry))
      : null;
    for (const triangle of this.stickerUvTopology?.triangles ?? []) {
      this.stickerUvTopologyTriangles.set(
        this.stickerTopologyFaceKey(triangle.meshIndex, triangle.triangleIndex),
        triangle,
      );
    }
    this.stickerGizmoProjectionKey = '';
  }

  private stickerGizmoChartForRaycastHit(hit: THREE.Intersection<THREE.Object3D>): number | null {
    const faceIndex = hit.faceIndex;
    if (!this.stickerUvTopology || faceIndex === undefined || faceIndex === null || !Number.isInteger(faceIndex)) return null;
    const meshIndex = this.paintableMeshes.indexOf(hit.object as THREE.Mesh);
    return meshIndex < 0 ? null : this.stickerUvTopology.chartIdForFace(meshIndex, faceIndex);
  }

  private setStickerGizmoAnchorChart(chartId: number | null) {
    if (chartId === null || !this.stickerUvTopology?.charts.some((chart) => chart.id === chartId)) return;
    if (this.stickerGizmoAnchorChartId === chartId) return;
    this.stickerGizmoAnchorChartId = chartId;
    this.stickerGizmoProjectionKey = '';
    this.invalidate();
  }

  private stickerGizmoCandidatePoint(candidate: StickerUvCandidate): THREE.Vector3 | null {
    const triangle = this.stickerUvTopologyTriangles.get(
      this.stickerTopologyFaceKey(candidate.meshIndex, candidate.triangleIndex),
    );
    const mesh = this.paintableMeshes[candidate.meshIndex];
    if (!triangle || !mesh) return null;
    const [a, b, c] = triangle.positions;
    const [weightA, weightB, weightC] = candidate.barycentric;
    if (![...a, ...b, ...c, weightA, weightB, weightC].every(Number.isFinite)) return null;
    return new THREE.Vector3(...a)
      .multiplyScalar(weightA)
      .addScaledVector(new THREE.Vector3(...b), weightB)
      .addScaledVector(new THREE.Vector3(...c), weightC)
      .applyMatrix4(mesh.matrixWorld);
  }

  /**
   * Resolve all requested sticker UV samples against exactly one physical UV
   * chart. The initial frame scores visible centre, corner, then edge samples
   * to choose an anchor. Afterwards that anchor is deliberately sticky: if it
   * becomes occluded we hide controls instead of teleporting them to another
   * overlapping UV island.
   */
  private findVisibleStickerGizmoChart(
    targets: readonly (readonly [number, number])[],
    camera: THREE.Camera,
  ): VisibleStickerGizmoChart | null {
    const topology = this.stickerUvTopology;
    if (!topology || topology.charts.length === 0) return null;
    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);
    const resolveChart = (chartId: number): VisibleStickerGizmoChart => {
      const candidatesByTarget = topology.findCandidates(targets, chartId);
      const containedTargets = candidatesByTarget.map((candidates) => candidates.length > 0);
      const points = candidatesByTarget.map((targetCandidates): VisibleStickerGizmoPoint => {
        const candidates = targetCandidates
          .flatMap((topologyCandidate) => {
            const point = this.stickerGizmoCandidatePoint(topologyCandidate);
            const [tileU, tileV] = topologyCandidate.periodicOffset;
            return point ? [{
              topologyCandidate,
              point,
              depth: point.distanceTo(cameraPosition),
              tileDistance: Math.abs(tileU) + Math.abs(tileV),
            }] : [];
          })
          .sort((a, b) => a.tileDistance - b.tileDistance || a.depth - b.depth);
        for (const candidate of candidates) {
          // Ray through the candidate's projected screen point rather than
          // from the camera position. Orthographic rays are parallel, and a
          // perspective-style origin would select a different surface.
          const ndc = candidate.point.clone().project(camera);
          if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)
            || ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1 || ndc.z < -1 || ndc.z > 1) continue;
          this.stickerGizmoRaycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
          this.stickerGizmoRaycaster.near = 0;
          this.stickerGizmoRaycaster.far = Number.POSITIVE_INFINITY;
          const visibleHit = this.stickerGizmoRaycaster.intersectObjects(this.paintableMeshes, false)[0];
          const hitMeshIndex = visibleHit ? this.paintableMeshes.indexOf(visibleHit.object as THREE.Mesh) : -1;
          const hitChartId = visibleHit ? this.stickerGizmoChartForRaycastHit(visibleHit) : null;
          // An equal depth alone is not identity: overlapping UV islands can
          // occupy the same ray. The resolved hit must belong to this mesh and
          // physical chart before it is allowed to make a control visible.
          if (visibleHit
            && hitMeshIndex === candidate.topologyCandidate.meshIndex
            && hitChartId === candidate.topologyCandidate.chartId
            && visibleHit.point.distanceTo(candidate.point) <= 0.01) {
            return {
              point: candidate.point,
              depth: candidate.depth,
              tileDistance: candidate.tileDistance,
            };
          }
        }
        return { point: null, depth: Number.POSITIVE_INFINITY, tileDistance: Number.POSITIVE_INFINITY };
      });
      return { chartId, points, containedTargets };
    };

    if (this.stickerGizmoAnchorChartId !== null) {
      const anchored = resolveChart(this.stickerGizmoAnchorChartId);
      // Occlusion must not make the gizmo jump to a duplicated UV copy. But
      // edits from the UV view, undo/revert, and direct movement can put the
      // authored centre outside the old chart altogether. That is not
      // occlusion: the anchor is geometrically stale and must be reacquired.
      // Target zero is always the sticker centre.
      if (stickerGizmoAnchorContainsCentre(anchored.containedTargets)) return anchored;
      this.stickerGizmoAnchorChartId = null;
    }

    const score = (chart: VisibleStickerGizmoChart): StickerGizmoChartScore => {
      const visible = (index: number) => chart.points[index]?.point ? 1 : 0;
      const corners = visible(1) + visible(3) + visible(5) + visible(7);
      const edges = visible(2) + visible(4) + visible(6) + visible(8);
      const depth = chart.points.reduce((nearest, point) => Math.min(nearest, point.depth), Number.POSITIVE_INFINITY);
      const centreTile = chart.points[0]?.point ? chart.points[0].tileDistance : Number.POSITIVE_INFINITY;
      const tileDistance = chart.points.reduce((total, point) => (
        point.point ? total + point.tileDistance : total
      ), 0);
      return { centre: visible(0), centreTile, corners, edges, tileDistance, depth };
    };
    const selected = topology.charts
      .map((chart) => resolveChart(chart.id))
      .filter((chart) => chart.points.some((point) => point.point !== null))
      .map((chart) => ({ chart, score: score(chart) }))
      .sort((left, right) => compareStickerGizmoChartScores(left.score, right.score))[0]?.chart ?? null;
    if (selected) this.stickerGizmoAnchorChartId = selected.chartId;
    return selected;
  }

  private ensureStickerGizmoOverlay(): SVGSVGElement | null {
    if (this.stickerGizmoOverlay?.isConnected) return this.stickerGizmoOverlay;
    const host = this.canvas.parentElement;
    if (!host) return null;
    const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.setAttribute('aria-hidden', 'true');
    overlay.setAttribute('focusable', 'false');
    overlay.style.cssText = 'position:absolute;inset:0;z-index:2;overflow:visible;pointer-events:none;';
    host.append(overlay);
    this.stickerGizmoOverlay = overlay;
    return overlay;
  }

  private hideStickerGizmoOverlay() {
    this.stickerGizmoState = null;
    // A later edit session may show the same quad with the same camera. The
    // old projection key must not make that valid re-open look unchanged
    // while the SVG is still hidden.
    this.stickerGizmoProjectionKey = '';
    if (!this.stickerGizmoOverlay) return;
    this.stickerGizmoOverlay.replaceChildren();
    this.stickerGizmoOverlay.style.display = 'none';
  }

  private appendStickerGizmoElement(
    overlay: SVGSVGElement,
    name: string,
    attributes: Record<string, string>,
  ) {
    const element = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
    overlay.append(element);
  }

  private updateStickerGizmoOverlay() {
    const quad = this.stickerGizmoQuad;
    if (this.disposed || !quad || !this.isUsableStickerQuad(quad)) {
      this.hideStickerGizmoOverlay();
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || this.paintableMeshes.length === 0) {
      this.hideStickerGizmoOverlay();
      return;
    }
    this.scene.updateMatrixWorld(true);
    const camera = this.getActiveProjectionCamera();
    camera.updateMatrixWorld();
    // Visible points require a UV-triangle lookup, so skip it during unrelated
    // animated passes (sheens/unusuals) when the camera, model, quad, and
    // viewport have not changed.
    const key = [
      rect.left, rect.top, rect.width, rect.height,
      ...quad.tl, ...quad.tr, ...quad.bl,
      this.stickerGizmoTool,
      ...camera.matrixWorld.elements,
      ...camera.projectionMatrix.elements,
      ...this.centerGroup.matrixWorld.elements,
    ].join(',');
    if (key === this.stickerGizmoProjectionKey) return;
    this.stickerGizmoProjectionKey = key;
    const br: [number, number] = [quad.tr[0] + quad.bl[0] - quad.tl[0], quad.tr[1] + quad.bl[1] - quad.tl[1]];
    const centreUv = stickerQuadCenter(quad);
    const midpointUv = (first: readonly [number, number], second: readonly [number, number]): [number, number] => [
      (first[0] + second[0]) * 0.5,
      (first[1] + second[1]) * 0.5,
    ];
    const boundarySamples: readonly { kind: Exclude<StickerGizmoHandleKind, 'move' | 'rotate'>; uv: readonly [number, number] }[] = [
      { kind: 'scale-top-left', uv: quad.tl },
      { kind: 'scale-top', uv: midpointUv(quad.tl, quad.tr) },
      { kind: 'scale-top-right', uv: quad.tr },
      { kind: 'scale-right', uv: midpointUv(quad.tr, br) },
      { kind: 'scale-bottom-right', uv: br },
      { kind: 'scale-bottom', uv: midpointUv(quad.bl, br) },
      { kind: 'scale-bottom-left', uv: quad.bl },
      { kind: 'scale-left', uv: midpointUv(quad.tl, quad.bl) },
    ];
    const project = (point: THREE.Vector3 | null): StickerGizmoScreenPoint | null => {
      if (!point) return null;
      const ndc = point.clone().project(camera);
      if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || ndc.z < -1 || ndc.z > 1) return null;
      const x = rect.left + (ndc.x + 1) * rect.width * 0.5;
      const y = rect.top + (1 - ndc.y) * rect.height * 0.5;
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom ? { x, y } : null;
    };
    const visibleChart = this.findVisibleStickerGizmoChart(
      [centreUv, ...boundarySamples.map((sample) => sample.uv)],
      camera,
    );
    if (!visibleChart) {
      this.hideStickerGizmoOverlay();
      return;
    }
    const projected = visibleChart.points.map((sample) => project(sample.point));
    const [projectedCentre, ...projectedBoundary] = projected;
    const visibleBoundary = boundarySamples.map((sample, index) => ({ ...sample, point: projectedBoundary[index] ?? null }));
    // Direct manipulation must remain attached to the actual UV-space centre.
    // A boundary-derived substitute looks plausible but puts the transform
    // origin somewhere the authored decal does not have one.
    const centrePoint = projectedCentre;
    // When the exact centre is covered by another weapon detail, keep direct
    // manipulation attached to the nearest visible sample on this same
    // coherent chart. Scale and turn can use it as a screen-space gesture
    // origin while their UV transforms still operate around the authored
    // sticker centre.
    const moveGripPoint = centrePoint ?? deriveStickerGizmoScreenCentre(
      null,
      centreUv,
      visibleBoundary.map((sample) => ({ uv: sample.uv, point: sample.point })),
    );
    const boundaryByKind = new Map(visibleBoundary.flatMap((sample) => sample.point ? [[sample.kind, sample.point] as const] : []));
    // A partial convex hull can join unrelated edge samples into a misleading
    // triangle. Draw an outline only when this anchored chart supplies the
    // four actual decal corners in their authored order.
    const outlineCornerKinds = ['scale-top-left', 'scale-top-right', 'scale-bottom-right', 'scale-bottom-left'] as const;
    const outlinePoints = outlineCornerKinds.map((kind) => boundaryByKind.get(kind));
    const fullOutline = outlinePoints.every((point): point is StickerGizmoScreenPoint => point !== undefined)
      ? outlinePoints
      : [];
    const handle = (kind: StickerGizmoHandleKind, point: StickerGizmoScreenPoint): StickerGizmoHandle => ({
      kind,
      clientX: point.x,
      clientY: point.y,
    });
    const fallbackHandles = moveGripPoint ? stickerGizmoFallbackHandles(moveGripPoint) : null;
    if (fallbackHandles) {
      // These compact grips all originate at a real visible sample on the
      // already selected physical chart. They provide recovery without
      // pretending that an occluded decal boundary was projected onscreen.
      if (!hasUsableStickerGizmoScaleDirection(moveGripPoint, boundaryByKind.get('scale-right'))) {
        boundaryByKind.set('scale-right', fallbackHandles.x);
      }
      if (!hasUsableStickerGizmoScaleDirection(moveGripPoint, boundaryByKind.get('scale-bottom'))) {
        boundaryByKind.set('scale-bottom', fallbackHandles.y);
      }
      if (!hasUsableStickerGizmoScaleDirection(moveGripPoint, boundaryByKind.get('scale-bottom-right'))) {
        boundaryByKind.set('scale-bottom-right', fallbackHandles.uniform);
      }
    }
    const activeHandleKinds: readonly StickerGizmoHandleKind[] = this.stickerGizmoTool === 'move'
      ? ['move']
      : this.stickerGizmoTool === 'scale'
        ? ['scale-top-left', 'scale-top', 'scale-top-right', 'scale-right', 'scale-bottom-right', 'scale-bottom', 'scale-bottom-left', 'scale-left']
        : ['rotate'];
    const transformOrigin = centrePoint ?? moveGripPoint;
    const rotatePoint = transformOrigin
      ? (boundaryByKind.get('scale-top')
        ? stickerGizmoTurnHandle(transformOrigin, boundaryByKind.get('scale-top'))
        : fallbackHandles?.turn ?? stickerGizmoTurnHandle(transformOrigin, null))
      : null;
    const activeHandles = activeHandleKinds.flatMap((kind) => {
      if (kind === 'move') return moveGripPoint ? [handle(kind, moveGripPoint)] : [];
      if (kind === 'rotate') return rotatePoint ? [handle(kind, rotatePoint)] : [];
      const point = boundaryByKind.get(kind);
      // A centre fallback can coincide with the only visible boundary point.
      // Such a scale handle has no screen direction, so it would look active
      // yet always produce a ratio of one. Keep it out of the truthful set.
      if (!point || !hasUsableStickerGizmoScaleDirection(transformOrigin, point)) return [];
      return [handle(kind, point)];
    });
    if (activeHandles.length === 0) {
      this.hideStickerGizmoOverlay();
      return;
    }
    const interactionCentre = transformOrigin;
    this.stickerGizmoState = {
      tool: this.stickerGizmoTool,
      handles: activeHandles,
      outline: fullOutline.map((point) => handle('scale-top-left', point)),
      centre: interactionCentre ? handle('move', interactionCentre) : null,
    };
    const overlay = this.ensureStickerGizmoOverlay();
    if (!overlay) return;
    overlay.style.display = '';
    overlay.setAttribute('viewBox', `0 0 ${rect.width} ${rect.height}`);
    overlay.setAttribute('width', `${rect.width}`);
    overlay.setAttribute('height', `${rect.height}`);
    overlay.replaceChildren();
    const local = (point: StickerGizmoScreenPoint) => ({ x: point.x - rect.left, y: point.y - rect.top });
    const localOutline = fullOutline.map(local);
    if (localOutline.length === 4) {
      this.appendStickerGizmoElement(overlay, 'polyline', {
        points: [...localOutline, localOutline[0]].map((point) => `${point.x},${point.y}`).join(' '),
        fill: this.stickerGizmoTool === 'move' ? 'rgb(47 111 219 / 10%)' : 'none', stroke: '#8fb6ff', 'stroke-width': '1.5',
      });
    }
    if (this.stickerGizmoTool === 'turn') {
      if (!interactionCentre || !rotatePoint) return;
      const localCentre = local(interactionCentre);
      const localRotate = local(rotatePoint);
      this.appendStickerGizmoElement(overlay, 'line', {
        x1: `${localCentre.x}`, y1: `${localCentre.y}`,
        x2: `${localRotate.x}`, y2: `${localRotate.y}`,
        stroke: '#d5a13b', 'stroke-width': '1.5',
      });
      this.appendStickerGizmoElement(overlay, 'circle', {
        cx: `${localRotate.x}`, cy: `${localRotate.y}`, r: '6', fill: '#1c1f24', stroke: '#d5a13b', 'stroke-width': '2',
      });
    } else if (this.stickerGizmoTool === 'scale') {
      const activeScaleHandles = new Map(
        activeHandles
          .filter((handle) => handle.kind.startsWith('scale-'))
          .map((handle) => [handle.kind, { x: handle.clientX, y: handle.clientY }] as const),
      );
      for (const kind of ['scale-top-left', 'scale-top-right', 'scale-bottom-right', 'scale-bottom-left'] as const) {
        const point = activeScaleHandles.get(kind);
        if (!point) continue;
        const localPoint = local(point);
        this.appendStickerGizmoElement(overlay, 'rect', {
          x: `${localPoint.x - 3.5}`, y: `${localPoint.y - 3.5}`, width: '7', height: '7', rx: '1', fill: '#1c1f24', stroke: '#83bfa5', 'stroke-width': '1.5',
        });
      }
      for (const kind of ['scale-top', 'scale-right', 'scale-bottom', 'scale-left'] as const) {
        const point = activeScaleHandles.get(kind);
        if (!point) continue;
        const localPoint = local(point);
        this.appendStickerGizmoElement(overlay, 'circle', {
          cx: `${localPoint.x}`, cy: `${localPoint.y}`, r: '2.75', fill: '#1c1f24', stroke: '#718496', 'stroke-width': '1.25',
        });
      }
    } else {
      if (!moveGripPoint) return;
      const move = local(moveGripPoint);
      this.appendStickerGizmoElement(overlay, 'circle', { cx: `${move.x}`, cy: `${move.y}`, r: '6', fill: '#2f6fdb', stroke: '#d9e7ff', 'stroke-width': '1.5' });
      this.appendStickerGizmoElement(overlay, 'path', {
        d: `M ${move.x - 9} ${move.y} H ${move.x + 9} M ${move.x} ${move.y - 9} V ${move.y + 9}`,
        stroke: '#8fb6ff', 'stroke-width': '1.25', 'stroke-linecap': 'round',
      });
    }
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
      if (this.projectionMode === 'orthographic') {
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

    return screenshotPixelsToBlob(raw, width, height, paddingScale, outputMaxEdge);
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
  ): Promise<void> {
    await this.envReady;
    if (this.disposed) return;
    const u = this.tf2Uniforms;
    configureTf2Material(mat, this.material, u);
    this.materialRimLight = u.uTf2RimLight.value;
    this.syncMaterialRimLight();
    this.invalidate();

    const token = ++this.materialLoadToken;
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
    for (const mesh of this.emissiveMeshes) this.centerGroup.remove(mesh);
    this.emissiveMeshes = [];
  }

  private rebuildEmissiveMeshes() {
    this.teardownEmissiveMeshes();
    if (!this.emissiveEnabled || !this.emissiveMaterial) return;
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

  private setMeshGeometries(parts: ModelPart[], initialView?: ViewAnglePreset) {
    this.teardownSheenMeshes();
    this.teardownEmissiveMeshes();
    this.teardownGroupLayerOverlayMeshes();
    this.teardownGroupHighlightMeshes();
    this.clearModelPartHover();
    this.teardownModelPartOutlines();
    this.teardownTransformIsolationMeshes();
    this.teardownStickerPreviewMeshes();
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
    this.resetStickerUvTopology();
    this.centerGroup.add(...this.meshes);
    this.frameCamera(this.cullableGeometries.map(({ geometry }) => geometry), initialView);
    if (this.sheenId !== 'none' && this.sheenMaterial) this.rebuildSheenMeshes();
    if (this.emissiveEnabled) this.rebuildEmissiveMeshes();
    for (const pass of this.groupLayerOverlayPasses) this.rebuildGroupLayerOverlayMeshes(pass);
    if (this.groupHighlightTexture && this.groupHighlightMaterial) this.rebuildGroupHighlightMeshes();
    if (this.transformIsolationMaterial) this.rebuildTransformIsolationMeshes();
    if (this.stickerPreviewTexture && this.stickerPreviewMaterial) this.rebuildStickerPreviewMeshes();
    this.invalidate();
  }

  private clearModel() {
    this.teardownSheenMeshes();
    this.teardownEmissiveMeshes();
    this.clearStickerPreview();
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
    this.resetStickerUvTopology();
    this.meshIsLens = [];
    this.currentModelUrl = null;
    this.invalidate();
  }

  // Load a weapon GLB. Concurrent calls resolve in call order via a token so a
  // stale load never wins; missing models leave the stage empty.
  async loadModel(url: string | null, initialView?: ViewAnglePreset): Promise<void> {
    if (url && url === this.currentModelUrl && this.meshes.length > 0) return;
    const token = ++this.loadToken;
    if (!url) {
      this.clearModel();
      return;
    }
    try {
      const geometries = await this.modelLoader.load(url);
      if (token !== this.loadToken || this.disposed) return;
      this.setMeshGeometries(geometries, initialView);
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
    cancelAnimationFrame(this.raf);
    this.canvas.removeEventListener('pointermove', this.onStickerGizmoPointerMove);
    this.canvas.removeEventListener('pointerdown', this.onStickerGizmoPointerDown);
    window.removeEventListener('pointerup', this.onStickerGizmoPointerUp);
    window.removeEventListener('pointercancel', this.onStickerGizmoPointerUp);
    this.canvas.style.cursor = '';
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
    this.clearStickerPreview();
    this.stickerGizmoOverlay?.remove();
    this.stickerGizmoOverlay = null;
    this.stickerPreviewMaterial?.dispose();
    this.stickerPreviewMaterial = null;
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
    this.customEnvMap?.dispose();
    this.defaultEnvMap.dispose();
    for (const cullable of this.cullableGeometries) cullable.dispose();
    this.cullableGeometries = [];
    this.modelLoader.dispose();
    this.renderer.dispose();
  }
}
