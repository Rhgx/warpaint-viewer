import * as THREE from 'three';
import type { CullableGeometry } from './modelCulling';
import type { StickerOverlay } from './overlays/stickerOverlay';

export interface ModelPartPick {
  readonly meshIndex: number;
  readonly componentIndex: number;
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

/** What model-part picking reads from the Viewer that owns it. */
export interface ModelPartPickingHost {
  readonly canvas: HTMLCanvasElement;
  readonly scene: THREE.Scene;
  readonly centerGroup: THREE.Group;
  /** The arrays are replaced on every model load, so read them on each use. */
  readonly getMeshes: () => THREE.Mesh[];
  readonly getCullableGeometries: () => CullableGeometry[];
  readonly getFramedRadius: () => number;
  /** The camera the canvas renders with, already synced for the current projection. */
  readonly getActiveProjectionCamera: () => THREE.Camera;
  readonly stickers: Pick<StickerOverlay, 'resetStickerUvTopology' | 'clearStickerGizmoState'>;
  readonly invalidate: () => void;
  readonly isDisposed: () => boolean;
}

export class ModelPartPicking {
  private readonly host: ModelPartPickingHost;
  private raycaster = new THREE.Raycaster();
  private pickNdc = new THREE.Vector2();
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

  constructor(host: ModelPartPickingHost) {
    this.host = host;
  }

  pickModelPartAt(clientX: number, clientY: number): ModelPartPick | null {
    if (this.host.isDisposed() || this.host.getMeshes().length === 0 || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
    const rect = this.host.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0
      || clientX < rect.left || clientX > rect.right
      || clientY < rect.top || clientY > rect.bottom) return null;

    this.pickNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    // Pointer input can arrive before the next render has refreshed the
    // model/control matrices, so make the hit test use the current pose.
    this.host.scene.updateMatrixWorld(true);
    const camera = this.host.getActiveProjectionCamera();
    camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.pickNdc, camera);
    // Line raycasts use world-space tolerance. Scale it to the framed model so
    // the x-ray remains easy to hit without swallowing nearby surfaces.
    this.raycaster.params.Line.threshold = Math.max(this.host.getFramedRadius() * 0.014, 1e-4);
    const outlines = [...this.modelPartOutlines.values()];
    const outlineHit = this.raycaster.intersectObjects(outlines, false)[0];
    const visibleHit = this.raycaster.intersectObjects<THREE.Mesh>(this.host.getMeshes(), false)[0];
    const outline = outlineHit?.object instanceof ModelPartOutline ? outlineHit.object : null;
    // Keep the front-most hit authoritative; bias coplanar and near-equal hits
    // toward visible geometry so stacked surfaces do not restore by accident.
    const coplanarEpsilon = Math.max(this.host.getFramedRadius() * 0.001, 1e-4);
    if (outline && (!visibleHit || outlineHit.distance + coplanarEpsilon < visibleHit.distance)) {
      return outline.pick;
    }
    if (typeof visibleHit?.faceIndex !== 'number' || !Number.isInteger(visibleHit.faceIndex)) return null;
    const meshIndex = this.host.getMeshes().indexOf(visibleHit.object);
    const cullable = meshIndex >= 0 ? this.host.getCullableGeometries()[meshIndex] : undefined;
    if (!cullable) return null;
    const componentIndex = cullable.componentForVisibleFace(visibleHit.faceIndex);
    if (componentIndex === null) return null;
    return { meshIndex, componentIndex };
  }

  setModelPartHover(pick: ModelPartPick | null): void {
    if (modelPartPicksEqual(this.modelPartHover, pick)) return;
    this.clearModelPartHover();
    if (!pick) return;

    const cullable = this.host.getCullableGeometries()[pick.meshIndex];
    if (!cullable || pick.componentIndex < 0 || pick.componentIndex >= cullable.componentCount) return;
    const hidden = cullable.isComponentHidden(pick.componentIndex);
    this.modelPartHover = pick;
    if (hidden) {
      const outline = this.modelPartOutlines.get(modelPartKey(pick.meshIndex, pick.componentIndex));
      if (outline) outline.material = this.modelPartOutlineHoverMaterial;
      this.host.invalidate();
      return;
    }

    const componentGeometry = cullable.getComponentGeometry(pick.componentIndex);
    if (!componentGeometry) {
      this.host.invalidate();
      return;
    }
    this.modelPartHoverMesh = new THREE.Mesh(componentGeometry, this.modelPartHoverMaterial);
    this.modelPartHoverMesh.renderOrder = 3;
    this.host.centerGroup.add(this.modelPartHoverMesh);
    this.host.invalidate();
  }

  toggleModelPart(pick: ModelPartPick): number | null {
    if (this.host.isDisposed()) return null;
    const cullable = this.host.getCullableGeometries()[pick.meshIndex];
    if (!cullable) return null;
    this.clearModelPartHover();
    const hidden = cullable.isComponentHidden(pick.componentIndex);
    const changed = hidden
      ? cullable.restoreComponent(pick.componentIndex)
      : cullable.hideComponent(pick.componentIndex);
    if (!changed) return null;

    if (hidden) this.removeModelPartOutline(pick.meshIndex, pick.componentIndex);
    else this.addModelPartOutline(pick.meshIndex, pick.componentIndex);
    this.host.stickers.resetStickerUvTopology();
    this.host.stickers.clearStickerGizmoState();
    if (!hidden) this.setModelPartHover(pick);
    this.host.invalidate();
    return this.host.getCullableGeometries().reduce((count, geometry) => count + geometry.hiddenCount, 0);
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
    if (this.modelPartHoverMesh) this.host.centerGroup.remove(this.modelPartHoverMesh);
    this.modelPartHoverMesh = null;
    this.host.invalidate();
  }

  restoreHiddenModelParts(): void {
    if (this.host.isDisposed()) return;
    let restored = false;
    for (const cullable of this.host.getCullableGeometries()) restored = cullable.restore() || restored;
    if (!restored) return;
    this.teardownModelPartOutlines();
    this.clearModelPartHover();
    this.host.stickers.resetStickerUvTopology();
    this.host.stickers.clearStickerGizmoState();
    this.host.invalidate();
  }

  private addModelPartOutline(meshIndex: number, componentIndex: number): void {
    const key = modelPartKey(meshIndex, componentIndex);
    if (this.modelPartOutlines.has(key)) return;
    const cullable = this.host.getCullableGeometries()[meshIndex];
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
    this.host.centerGroup.add(line);
    this.modelPartOutlines.set(key, line);
  }

  private removeModelPartOutline(meshIndex: number, componentIndex: number): void {
    const key = modelPartKey(meshIndex, componentIndex);
    const outline = this.modelPartOutlines.get(key);
    if (!outline) return;
    this.modelPartOutlines.delete(key);
    this.host.centerGroup.remove(outline);
    outline.geometry.dispose();
  }

  teardownModelPartOutlines(): void {
    for (const outline of this.modelPartOutlines.values()) {
      this.host.centerGroup.remove(outline);
      outline.geometry.dispose();
    }
    this.modelPartOutlines.clear();
  }

  disposeModelPartMaterials(): void {
    this.modelPartOutlineMaterial.dispose();
    this.modelPartOutlineHoverMaterial.dispose();
    this.modelPartHoverMaterial.dispose();
  }
}
