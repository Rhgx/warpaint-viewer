import * as THREE from 'three';
import type { Tf2Uniforms } from '../materialConfig';
import {
  moveStickerQuadToUv,
  stickerQuadCenter,
  type StickerPlacementQuad,
} from '../../editor/sticker/viewerStickerPlacement';
import { stickerCoverageQuad } from '../../editor/sticker/stickerGeometry';
import {
  deriveStickerGizmoScreenCentre,
  hasUsableStickerGizmoScaleDirection,
  moveStickerQuadByUvDelta,
  rotateStickerQuadByDegrees,
  scaleStickerQuadAxisAroundCentre,
  scaleStickerQuadAroundCentre,
  stickerGizmoScreenAxisRatio,
  stickerGizmoFallbackHandles,
  stickerGizmoIntentForHandle,
  type StickerGizmoHandleKind,
  type StickerGizmoIntent,
  type StickerGizmoScreenPoint,
  type StickerGizmoTool,
  stickerGizmoTurnHandle,
} from '../../editor/sticker/stickerGizmo';
import { createStickerPreviewMaterial } from './stickerPreviewMaterial';
import { StickerGizmoChartResolver } from './stickerGizmoChart';

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

/** Last projected gizmo controls, used for hit-testing and starting a drag. */
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

// The editor's sticker preview decal and transform gizmo. The Viewer owns the scene; this
// class adds and removes only its own preview meshes and SVG overlay, reading the rest via host.
export class StickerOverlay {
  private readonly host: StickerOverlayHost;
  private texLoader = new THREE.TextureLoader();
  private raycaster = new THREE.Raycaster();
  private pickNdc = new THREE.Vector2();

  // Preview is a copy of the actual weapon geometry, not a world-space plane. The fragment shader
  // maps each mesh UV back to the sticker's local UV, matching the placement that gets exported.
  private stickerPreviewMaterial: THREE.ShaderMaterial | null = null;
  private stickerPreviewMeshes: THREE.Mesh[] = [];
  private stickerPreviewTexture: THREE.Texture | null = null;
  private stickerPreviewSpecTexture: THREE.Texture | null = null;
  private stickerPreviewUrl: string | null = null;
  private stickerPreviewSpecUrl: string | null = null;
  private stickerPreviewMode: 'decal' | 'group' | null = null;
  private stickerPreviewLoadToken = 0;

  // The gizmo lives in an SVG sibling above the canvas so handles keep a recognisable screen size,
  // but every point comes from the weapon's UV geometry and transforms return authored UVs.
  private stickerGizmoQuad: StickerPlacementQuad | null = null;
  private stickerGizmoTool: StickerGizmoTool = 'move';
  private stickerGizmoState: StickerGizmoState | null = null;
  private stickerGizmoOverlay: SVGSVGElement | null = null;
  private stickerGizmoProjectionKey = '';
  private stickerGizmoPointerId: number | null = null;
  private readonly chartResolver: StickerGizmoChartResolver;

  constructor(host: StickerOverlayHost) {
    this.host = host;
    this.chartResolver = new StickerGizmoChartResolver({ getPaintableMeshes: () => this.host.getPaintableMeshes() });
    this.host.canvas.addEventListener('pointermove', this.onStickerGizmoPointerMove);
    this.host.canvas.addEventListener('pointerdown', this.onStickerGizmoPointerDown);
    // React captures editor drags on the canvas wrapper, so the matching up/cancel may miss the canvas.
    // Listening on window keeps cursor state in sync without competing with the gesture.
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
   * Returns the first weapon surface under a viewport point, as the geometry's unmodified UV.
   * Weapon textures upload with `flipY = false`, so V increases downward in the image data.
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
    // Input can arrive between renders, so refresh matrixWorld before hit-testing.
    this.host.scene.updateMatrixWorld(true);
    const camera = this.host.getActiveProjectionCamera();
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pickNdc, camera);
    const hit = this.raycaster.intersectObjects<THREE.Mesh>(this.host.getPaintableMeshes(), false)[0];
    if (!hit?.uv || !Number.isFinite(hit.uv.x) || !Number.isFinite(hit.uv.y)) return null;
    return { uv: [hit.uv.x, hit.uv.y], chartId: this.chartResolver.chartIdForRaycastHit(hit) };
  }

  /**
   * Raycasts a pointer into a translated sticker destination without moving the camera.
   * The editor decides when to call it, normally during its placement gesture.
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
   * Sets or clears the on-model transform controls for a sticker destination. Unlike
   * setStickerPreview it loads no image, so it suits a panel changing selection.
   */
  setStickerGizmo(quad: StickerPlacementQuad | null, tool: StickerGizmoTool = 'move'): void {
    const toolChanged = this.stickerGizmoTool !== tool;
    this.stickerGizmoQuad = quad && this.isUsableStickerQuad(quad) ? quad : null;
    this.stickerGizmoTool = tool;
    if (!this.stickerGizmoQuad || toolChanged) {
      this.stickerGizmoPointerId = null;
      this.host.canvas.style.cursor = '';
    }
    // Projection walks every paintable UV triangle. A live 2D edit already re-renders, which does
    // this work once; doing it here too scans the mesh twice per pointer move.
    this.host.invalidate();
  }

  /** Forget the selected physical UV copy when the edited sticker changes. */
  resetStickerGizmoAnchor(): void {
    this.chartResolver.clearAnchor();
    this.stickerGizmoProjectionKey = '';
    this.stickerGizmoState = null;
    this.stickerGizmoPointerId = null;
    this.host.canvas.style.cursor = '';
    this.host.invalidate();
  }

  /** Hit-test a viewport pointer against the compact, screen-space handles. */
  hitTestStickerGizmo(clientX: number, clientY: number): StickerGizmoHandleKind | null {
    // Runs on pointer down, before InspectControls claims the gesture. Use only the last rendered
    // projection: a pointer down must not trigger a DOM read or a full UV-triangle walk.
    const state = this.stickerGizmoState;
    if (!state || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    // Check only the active tool's precise controls, leaving empty canvas to InspectControls and
    // stopping inactive affordances from taking a drag.
    const ordered = state.handles;
    for (const handle of ordered) {
      const radius = handle.kind === 'move' ? 11 : handle.kind === 'rotate' ? 12 : 10;
      if (Math.hypot(clientX - handle.clientX, clientY - handle.clientY) <= radius) return handle.kind;
    }
    // The outline is visual context, not a drag target. Only the attached center grip is reserved,
    // so a click on an occluded body still goes to InspectControls.
    return null;
  }

  /**
   * Captures a transform baseline. Pass it back to updateStickerGizmoDrag(); the caller owns
   * pointer capture, so no inspect orbit starts underneath the drag.
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
   * Applies a live gizmo drag and returns UV-space destination points. It has no side effects:
   * callers preview with setStickerPreview and commit one undoable edit on release.
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
      // A direct 3D move explicitly picks a physical surface. Carry that into the controls so they
      // follow across disconnected UV charts rather than staying on the starting island.
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
   * Shows a temporary sticker in weapon UV space; the composed paint is unchanged. Callers
   * commit the returned quad from `moveStickerQuadToClientPoint` once the gesture completes.
   * Overlapping UV islands cannot be disambiguated by raycast, since Source draws the same
   * sticker on every face sharing those UVs.
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
   * Previews a group sticker from its original mask and cached selector endpoints. Moving it
   * changes only destination uniforms, so nearby stickers are not baked in.
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

  /** Detach any decal preview from the model's shared material uniforms. */
  private resetStickerUniforms(): void {
    this.host.tf2Uniforms.uTf2StickerPreview.value = 0;
    this.host.tf2Uniforms.uTf2StickerMap.value = null;
    this.host.tf2Uniforms.uTf2StickerSpecMap.value = null;
    this.host.tf2Uniforms.uTf2StickerHasSpec.value = 0;
  }

  private loadStickerPreviewTexture(textureUrl: string, mode: 'decal' | 'group'): void {
    const material = this.ensureStickerPreviewMaterial();
    this.resetStickerUniforms();
    this.stickerPreviewSpecTexture?.dispose();
    this.stickerPreviewSpecTexture = null;
    this.stickerPreviewSpecUrl = null;

    if (textureUrl === this.stickerPreviewUrl && mode === this.stickerPreviewMode && this.stickerPreviewTexture) {
      // Position lives in shader uniforms, so a drag must not recreate every overlay mesh per pointer
      // event. Rebuild only if a model replacement removed them.
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
    this.resetStickerUniforms();

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
    this.resetStickerUniforms();
    if (this.stickerPreviewMaterial) {
      this.stickerPreviewMaterial.uniforms.uStickerMap.value = null;
      this.stickerPreviewMaterial.uniforms.uSelectorBase.value = null;
      this.stickerPreviewMaterial.uniforms.uEndpointZero.value = null;
      this.stickerPreviewMaterial.uniforms.uEndpointOne.value = null;
    }
    this.chartResolver.clearAnchor();
    this.setStickerGizmo(null);
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
    this.stickerPreviewMaterial = createStickerPreviewMaterial(this.host.getMaterialSide());
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
      // Draw above the all-layer cue (1) and group cue (2), keeping normal depth testing.
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

  resetStickerUvTopology() {
    this.chartResolver.reset();
    this.stickerGizmoProjectionKey = '';
  }

  private setStickerGizmoAnchorChart(chartId: number | null) {
    if (this.chartResolver.selectAnchor(chartId)) {
      this.stickerGizmoProjectionKey = '';
      this.host.invalidate();
    }
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
    // A reopened session can show the same quad and camera, so clear the projection key or the
    // hidden SVG looks unchanged.
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
    // Visible points need a UV-triangle lookup, so skip it during unrelated animated passes
    // (sheens, unusuals) when the camera, model, quad and viewport are unchanged.
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
    const visibleChart = this.chartResolver.findVisibleChart(
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
    // Direct manipulation must stay on the actual UV-space center. A boundary-derived substitute
    // looks plausible but puts the transform origin off the authored decal's center.
    const centrePoint = projectedCentre;
    // If another weapon detail covers the exact center, attach to the nearest visible sample on the
    // same chart. Scale and turn use it only as a screen-space origin; their UV math stays on the center.
    const moveGripPoint = centrePoint ?? deriveStickerGizmoScreenCentre(
      null,
      centreUv,
      visibleBoundary.map((sample) => ({ uv: sample.uv, point: sample.point })),
    );
    const boundaryByKind = new Map(visibleBoundary.flatMap((sample) => sample.point ? [[sample.kind, sample.point] as const] : []));
    // A partial convex hull can join unrelated edge samples into a false triangle. Draw the outline
    // only when this chart supplies all four decal corners in authored order.
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
      // These grips all start at a visible sample on the selected chart, so they recover without
      // pretending an occluded boundary was projected onscreen.
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
      // A center fallback can coincide with the only visible boundary point. That scale handle has no
      // screen direction and would always yield a ratio of one, so leave it out.
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
