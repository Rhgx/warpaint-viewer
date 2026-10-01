import * as THREE from 'three';
import type { Tf2Uniforms } from './materialConfig';
import {
  moveStickerQuadToUv,
  stickerQuadCenter,
  type StickerPlacementQuad,
} from '../editor/sticker/viewerStickerPlacement';
import { stickerCoverageQuad } from '../editor/sticker/stickerGeometry';
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
} from '../editor/sticker/stickerGizmo';
import {
  buildStickerUvTopology,
  type StickerUvCandidate,
  type StickerUvTopology,
  type StickerUvTopologyTriangle,
} from '../editor/sticker/stickerUvTopology';

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

/** What the overlay reads from the Viewer that owns it. */
export interface StickerOverlayHost {
  readonly canvas: HTMLCanvasElement;
  readonly scene: THREE.Scene;
  readonly centerGroup: THREE.Group;
  readonly tf2Uniforms: Tf2Uniforms;
  /** The array is replaced on every model load, so read it on each use. */
  readonly getPaintableMeshes: () => THREE.Mesh[];
  readonly getMaterialSide: () => THREE.Side;
  /** The camera the canvas renders with, already synced for the current projection. */
  readonly getActiveProjectionCamera: () => THREE.Camera;
  readonly invalidate: () => void;
  readonly isDisposed: () => boolean;
}

// The editor's sticker preview decal and transform gizmo for the weapon the
// Viewer shows. The Viewer owns the scene; this class adds and removes its own
// preview meshes and SVG overlay and reads everything else through the host.
export class StickerOverlay {
  private readonly host: StickerOverlayHost;
  private texLoader = new THREE.TextureLoader();
  private raycaster = new THREE.Raycaster();
  // Gizmo visibility samples set a short far plane; keep that mutable state
  // separate from normal pointer picking so a later move ray never inherits
  // the final control sample's range.
  private stickerGizmoRaycaster = new THREE.Raycaster();
  private pickNdc = new THREE.Vector2();

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
  // on first use after model geometry changes; live camera/drag frames query it
  // rather than rediscovering overlapping UV instances independently.
  private cachedStickerUvTopology: StickerUvTopology | null = null;
  private stickerUvTopologyTriangles = new Map<string, StickerUvTopologyTriangle>();
  private stickerGizmoAnchorChartId: number | null = null;

  constructor(host: StickerOverlayHost) {
    this.host = host;
    this.host.canvas.addEventListener('pointermove', this.onStickerGizmoPointerMove);
    this.host.canvas.addEventListener('pointerdown', this.onStickerGizmoPointerDown);
    // React captures editor drags on the canvas wrapper, which means the
    // matching up/cancel may no longer target the canvas itself. Window keeps
    // this small cursor state in sync without competing with the gesture.
    window.addEventListener('pointerup', this.onStickerGizmoPointerUp);
    window.addEventListener('pointercancel', this.onStickerGizmoPointerUp);
  }

  private onStickerGizmoPointerMove = (event: PointerEvent) => {
    if (this.host.isDisposed() || !this.stickerGizmoQuad) {
      this.host.canvas.style.cursor = '';
      return;
    }
    const handle = this.hitTestStickerGizmo(event.clientX, event.clientY);
    if (!handle) {
      if (this.stickerGizmoPointerId === null) this.host.canvas.style.cursor = '';
      return;
    }
    if (handle === 'move') {
      this.host.canvas.style.cursor = this.stickerGizmoPointerId !== null ? 'grabbing' : 'grab';
      return;
    }
    if (handle === 'rotate') {
      this.host.canvas.style.cursor = this.stickerGizmoPointerId !== null ? 'grabbing' : 'crosshair';
      return;
    }
    if (handle === 'scale-left' || handle === 'scale-right') {
      this.host.canvas.style.cursor = 'ew-resize';
      return;
    }
    if (handle === 'scale-top' || handle === 'scale-bottom') {
      this.host.canvas.style.cursor = 'ns-resize';
      return;
    }
    this.host.canvas.style.cursor = handle === 'scale-top-left' || handle === 'scale-bottom-right'
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
    this.host.canvas.style.cursor = '';
  };

  /**
   * Returns the first current-weapon surface under a viewport client point.
   * The returned UV is the geometry's unmodified UV: U increases to the right
   * and, because the viewer uploads weapon textures with `flipY = false`, V
   * increases downward into the source image data.
  */
  pickWeaponUv(clientX: number, clientY: number): { uv: [number, number]; chartId: number | null } | null {
    if (this.host.isDisposed() || this.host.getPaintableMeshes().length === 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = this.host.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0
      || clientX < rect.left || clientX > rect.right
      || clientY < rect.top || clientY > rect.bottom) return null;

    this.pickNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    // Input can arrive between renders, while InspectControls/model transforms
    // have changed but their cached matrixWorld values have not yet been used.
    this.host.scene.updateMatrixWorld(true);
    const camera = this.host.getActiveProjectionCamera();
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pickNdc, camera);
    const hit = this.raycaster.intersectObjects(this.host.getPaintableMeshes(), false)[0];
    if (!hit?.uv || !Number.isFinite(hit.uv.x) || !Number.isFinite(hit.uv.y)) return null;
    return { uv: [hit.uv.x, hit.uv.y], chartId: this.stickerGizmoChartForRaycastHit(hit) };
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
      this.host.canvas.style.cursor = '';
    }
    // Projection walks paintable UV triangles. A live 2D edit already
    // invalidates the next render, whose normal overlay pass performs this
    // work once; doing it here as well makes every pointer move scan the mesh
    // twice and starves the DOM editor of paint time.
    this.host.invalidate();
  }

  /** Forget the selected physical UV copy when the edited sticker changes. */
  resetStickerGizmoAnchor(): void {
    this.stickerGizmoAnchorChartId = null;
    this.stickerGizmoProjectionKey = '';
    this.stickerGizmoState = null;
    this.stickerGizmoPointerId = null;
    this.host.canvas.style.cursor = '';
    this.host.invalidate();
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
    if (this.host.isDisposed() || !textureUrl || !this.setStickerPreviewQuad(quad, options.opacity)) {
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
    if (this.host.isDisposed() || !maskUrl || !resources || !this.setStickerPreviewQuad(quad, options.opacity)) {
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
    this.host.tf2Uniforms.uTf2StickerPreview.value = 0;
    this.host.tf2Uniforms.uTf2StickerMap.value = null;
    this.host.tf2Uniforms.uTf2StickerSpecMap.value = null;
    this.host.tf2Uniforms.uTf2StickerHasSpec.value = 0;
    this.stickerPreviewSpecTexture?.dispose();
    this.stickerPreviewSpecTexture = null;
    this.stickerPreviewSpecUrl = null;

    if (textureUrl === this.stickerPreviewUrl && mode === this.stickerPreviewMode && this.stickerPreviewTexture) {
      // Position lives in shader uniforms, so a transform drag must not tear
      // down and recreate one overlay mesh per paintable sub-mesh on every
      // pointer event. Rebuild only if a model replacement removed them.
      if (this.stickerPreviewMeshes.length === 0) this.rebuildStickerPreviewMeshes();
      this.host.invalidate();
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
      if (token !== this.stickerPreviewLoadToken || this.host.isDisposed() || textureUrl !== this.stickerPreviewUrl
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
      this.host.invalidate();
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
      this.host.tf2Uniforms.uTf2StickerPreview.value = 1;
      this.host.tf2Uniforms.uTf2StickerMap.value = this.stickerPreviewTexture;
      this.host.tf2Uniforms.uTf2StickerSpecMap.value = this.stickerPreviewSpecTexture ?? this.stickerPreviewTexture;
      this.host.tf2Uniforms.uTf2StickerHasSpec.value = this.stickerPreviewSpecTexture ? 1 : 0;
      this.teardownStickerPreviewMeshes();
      this.host.invalidate();
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
    this.host.tf2Uniforms.uTf2StickerPreview.value = 0;
    this.host.tf2Uniforms.uTf2StickerMap.value = null;
    this.host.tf2Uniforms.uTf2StickerSpecMap.value = null;
    this.host.tf2Uniforms.uTf2StickerHasSpec.value = 0;

    const base = this.texLoader.loadAsync(textureUrl);
    const spec = specularUrl ? this.texLoader.loadAsync(specularUrl).catch(() => null) : Promise.resolve(null);
    void Promise.all([base, spec]).then(([texture, specular]) => {
      if (token !== this.stickerPreviewLoadToken || this.host.isDisposed()
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
      this.host.tf2Uniforms.uTf2StickerMap.value = texture;
      this.host.tf2Uniforms.uTf2StickerSpecMap.value = specular ?? texture;
      this.host.tf2Uniforms.uTf2StickerHasSpec.value = specular ? 1 : 0;
      this.host.tf2Uniforms.uTf2StickerPreview.value = 1;
      this.host.invalidate();
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
    this.host.tf2Uniforms.uTf2StickerPreview.value = 0;
    this.host.tf2Uniforms.uTf2StickerMap.value = null;
    this.host.tf2Uniforms.uTf2StickerSpecMap.value = null;
    this.host.tf2Uniforms.uTf2StickerHasSpec.value = 0;
    if (this.stickerPreviewMaterial) {
      this.stickerPreviewMaterial.uniforms.uStickerMap.value = null;
      this.stickerPreviewMaterial.uniforms.uSelectorBase.value = null;
      this.stickerPreviewMaterial.uniforms.uEndpointZero.value = null;
      this.stickerPreviewMaterial.uniforms.uEndpointOne.value = null;
    }
    this.stickerGizmoAnchorChartId = null;
    this.setStickerGizmo(null);
    this.host.invalidate();
  }

  private setStickerPreviewQuad(authored: StickerPlacementQuad | null, opacity: number | undefined): boolean {
    if (!authored || ![authored.tl, authored.tr, authored.bl].every((uv) => Number.isFinite(uv[0]) && Number.isFinite(uv[1]))) return false;
    const quad = stickerCoverageQuad(authored);
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
    this.host.tf2Uniforms.uTf2StickerTl.value.copy(material.uniforms.uStickerTl.value);
    this.host.tf2Uniforms.uTf2StickerTr.value.copy(material.uniforms.uStickerTr.value);
    this.host.tf2Uniforms.uTf2StickerBl.value.copy(material.uniforms.uStickerBl.value);
    this.host.tf2Uniforms.uTf2StickerCenter.value.copy(material.uniforms.uStickerCenter.value);
    this.host.tf2Uniforms.uTf2StickerOpacity.value = material.uniforms.uStickerOpacity.value;
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
      side: this.host.getMaterialSide(),
    });
    return this.stickerPreviewMaterial;
  }

  teardownStickerPreviewMeshes() {
    for (const mesh of this.stickerPreviewMeshes) this.host.centerGroup.remove(mesh);
    this.stickerPreviewMeshes = [];
  }

  private rebuildStickerPreviewMeshes() {
    this.teardownStickerPreviewMeshes();
    if (this.stickerPreviewMode !== 'group' || !this.stickerPreviewTexture || !this.stickerPreviewMaterial) return;
    this.stickerPreviewMaterial.side = this.host.getMaterialSide();
    for (const mesh of this.host.getPaintableMeshes()) {
      const preview = new THREE.Mesh(mesh.geometry, this.stickerPreviewMaterial);
      // Draw above the all-layer cue (1) and focused group cue (2), while
      // retaining normal depth testing against the weapon itself.
      preview.renderOrder = 3;
      this.host.centerGroup.add(preview);
      this.stickerPreviewMeshes.push(preview);
    }
  }

  private isUsableStickerQuad(quad: StickerPlacementQuad): boolean {
    if (![quad.tl, quad.tr, quad.bl].every((uv) => Number.isFinite(uv[0]) && Number.isFinite(uv[1]))) return false;
    const axisX = new THREE.Vector2(quad.tr[0] - quad.tl[0], quad.tr[1] - quad.tl[1]);
    const axisY = new THREE.Vector2(quad.bl[0] - quad.tl[0], quad.bl[1] - quad.tl[1]);
    return Math.abs(axisX.cross(axisY)) >= 1e-8;
  }

  private stickerTopologyFaceKey(meshIndex: number, triangleIndex: number): string {
    return `${meshIndex}:${triangleIndex}`;
  }

  resetStickerUvTopology() {
    this.stickerGizmoAnchorChartId = null;
    this.stickerUvTopologyTriangles.clear();
    this.cachedStickerUvTopology = null;
    this.stickerGizmoProjectionKey = '';
  }

  private get stickerUvTopology(): StickerUvTopology | null {
    if (this.cachedStickerUvTopology) return this.cachedStickerUvTopology;
    // Build only when sticker picking/projection needs the current mesh.
    this.cachedStickerUvTopology = this.host.getPaintableMeshes().length > 0
      ? buildStickerUvTopology(this.host.getPaintableMeshes().map((mesh) => mesh.geometry))
      : null;
    for (const triangle of this.cachedStickerUvTopology?.triangles ?? []) {
      this.stickerUvTopologyTriangles.set(
        this.stickerTopologyFaceKey(triangle.meshIndex, triangle.triangleIndex),
        triangle,
      );
    }
    return this.cachedStickerUvTopology;
  }

  private stickerGizmoChartForRaycastHit(hit: THREE.Intersection<THREE.Object3D>): number | null {
    const faceIndex = hit.faceIndex;
    if (!this.stickerUvTopology || faceIndex === undefined || faceIndex === null || !Number.isInteger(faceIndex)) return null;
    const meshIndex = this.host.getPaintableMeshes().indexOf(hit.object as THREE.Mesh);
    return meshIndex < 0 ? null : this.stickerUvTopology.chartIdForFace(meshIndex, faceIndex);
  }

  private setStickerGizmoAnchorChart(chartId: number | null) {
    if (chartId === null || !this.stickerUvTopology?.charts.some((chart) => chart.id === chartId)) return;
    if (this.stickerGizmoAnchorChartId === chartId) return;
    this.stickerGizmoAnchorChartId = chartId;
    this.stickerGizmoProjectionKey = '';
    this.host.invalidate();
  }

  private stickerGizmoCandidatePoint(candidate: StickerUvCandidate): THREE.Vector3 | null {
    const triangle = this.stickerUvTopologyTriangles.get(
      this.stickerTopologyFaceKey(candidate.meshIndex, candidate.triangleIndex),
    );
    const mesh = this.host.getPaintableMeshes()[candidate.meshIndex];
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
          const visibleHit = this.stickerGizmoRaycaster.intersectObjects(this.host.getPaintableMeshes(), false)[0];
          const hitMeshIndex = visibleHit ? this.host.getPaintableMeshes().indexOf(visibleHit.object as THREE.Mesh) : -1;
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
    const host = this.host.canvas.parentElement;
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

  updateStickerGizmoOverlay() {
    const authored = this.stickerGizmoQuad;
    if (this.host.isDisposed() || !authored || !this.isUsableStickerQuad(authored)) {
      this.hideStickerGizmoOverlay();
      return;
    }
    const quad = stickerCoverageQuad(authored);
    const rect = this.host.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || this.host.getPaintableMeshes().length === 0) {
      this.hideStickerGizmoOverlay();
      return;
    }
    this.host.scene.updateMatrixWorld(true);
    const camera = this.host.getActiveProjectionCamera();
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
      ...this.host.centerGroup.matrixWorld.elements,
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

  /** Whether a gizmo handle is under the pointer, so InspectControls leaves the gesture to the editor. */
  shouldExcludeCameraPointer(event: PointerEvent): boolean {
    return this.stickerGizmoQuad !== null
      && this.hitTestStickerGizmo(event.clientX, event.clientY) !== null;
  }

  /** Drop the last projected controls, for example after a part was hidden or restored. */
  clearStickerGizmoState(): void {
    this.stickerGizmoState = null;
  }

  /** Re-attach a loaded group preview to the meshes of a newly loaded model. */
  rebuildStickerPreviewMeshesIfLoaded(): void {
    if (this.stickerPreviewTexture && this.stickerPreviewMaterial) this.rebuildStickerPreviewMeshes();
  }

  dispose(): void {
    this.host.canvas.removeEventListener('pointermove', this.onStickerGizmoPointerMove);
    this.host.canvas.removeEventListener('pointerdown', this.onStickerGizmoPointerDown);
    window.removeEventListener('pointerup', this.onStickerGizmoPointerUp);
    window.removeEventListener('pointercancel', this.onStickerGizmoPointerUp);
    this.host.canvas.style.cursor = '';
    this.clearStickerPreview();
    this.stickerGizmoOverlay?.remove();
    this.stickerGizmoOverlay = null;
    this.stickerPreviewMaterial?.dispose();
    this.stickerPreviewMaterial = null;
  }
}
