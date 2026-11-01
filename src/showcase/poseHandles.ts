import * as THREE from 'three';
import { POSE_RIGS, type PoseControl } from './poseRigs';
import type { ItemRuntime, PoseHandle, ShowcaseBoardOptions } from './showcaseTypes';
import { dominantBones } from './weaponGeometry';

// Pose handles for the selected weapon: where each control's handle sits on screen and the path it travels.

/** What pose handles read from the board that owns them. */
export interface PoseHandlesHost {
  readonly options: ShowcaseBoardOptions;
  readonly camera: THREE.OrthographicCamera;
  readonly runtimes: ReadonlyMap<string, ItemRuntime>;
}

export class PoseHandles {
  private readonly host: PoseHandlesHost;
  readonly #anchors = new Map<string, { meshIndex: number; vertex: number } | null>();

  constructor(host: PoseHandlesHost) {
    this.host = host;
  }

  /** Where the selected item sits on screen, for the HTML rotation gizmo. */
  screenInfo(id: string): { x: number; y: number; radius: number } | null {
    const runtime = this.host.runtimes.get(id);
    const footprint = runtime?.footprint;
    if (!runtime || !footprint) return null;
    const canvas = this.host.options.canvas;
    const unitsPerPx = (this.host.camera.right - this.host.camera.left) / canvas.clientWidth;
    const corners = [
      [footprint.originX, footprint.originY],
      [footprint.originX + footprint.width, footprint.originY + footprint.height],
    ];
    const reach = Math.max(...corners.flat().map(Math.abs));
    const point = new THREE.Vector3(runtime.item.x, runtime.item.y, 0).project(this.host.camera);
    return {
      x: (point.x + 1) / 2 * canvas.clientWidth,
      y: (1 - point.y) / 2 * canvas.clientHeight,
      radius: Math.min(reach * 0.75, 60) / unitsPerPx,
    };
  }

  /** Drag handles for the selected weapon's pose controls, at the parts they move. */
  poseHandles(id: string): PoseHandle[] {
    const runtime = this.host.runtimes.get(id);
    const rig = runtime && !runtime.item.part ? POSE_RIGS[runtime.item.weaponKey] : undefined;
    if (!runtime || !rig || runtime.item.hidden) return [];
    runtime.root.updateMatrixWorld(true);
    const handles: PoseHandle[] = [];
    for (const control of rig.controls) {
      const point = this.#handlePoint(runtime, control);
      if (point) handles.push({ controlId: control.id, ...point });
    }
    return handles;
  }

  /**
   * Where a handle travels as its control runs from min to max, sampled in
   * canvas pixels. Dragging a handle picks the value whose point is nearest.
   */
  poseHandlePath(id: string, controlId: string): { values: number[]; points: { x: number; y: number }[] } | null {
    const runtime = this.host.runtimes.get(id);
    const rig = runtime && !runtime.item.part ? POSE_RIGS[runtime.item.weaponKey] : undefined;
    const control = rig?.controls.find((entry) => entry.id === controlId);
    if (!runtime || !rig || !control) return null;
    const values: number[] = [];
    const points: { x: number; y: number }[] = [];
    const steps = Math.min(180, Math.max(24, Math.round((control.max - control.min) / control.step)));
    for (let step = 0; step <= steps; step += 1) {
      const value = control.min + ((control.max - control.min) * step) / steps;
      rig.apply(runtime.bones, { ...runtime.item.pose, [control.id]: value });
      runtime.root.updateMatrixWorld(true);
      const point = this.#handlePoint(runtime, control);
      if (!point) continue;
      values.push(value);
      points.push(point);
    }
    rig.apply(runtime.bones, runtime.item.pose);
    runtime.root.updateMatrixWorld(true);
    return points.length ? { values, points } : null;
  }

  #handlePoint(runtime: ItemRuntime, control: PoseControl): { x: number; y: number } | null {
    const anchor = control.handle ? this.#handleAnchor(runtime, control.handle) : null;
    if (!anchor) return null;
    // A skinned mesh's vertex position already includes the bone transform.
    const point = anchor.mesh.getVertexPosition(anchor.vertex, new THREE.Vector3());
    point.applyMatrix4(anchor.mesh.matrixWorld).project(this.host.camera);
    const canvas = this.host.options.canvas;
    return { x: (point.x + 1) / 2 * canvas.clientWidth, y: (1 - point.y) / 2 * canvas.clientHeight };
  }

  /** The vertex of a moving part farthest from its pivot, which travels the most. */
  #handleAnchor(runtime: ItemRuntime, boneName: string): { mesh: THREE.SkinnedMesh; vertex: number } | null {
    const cacheKey = `${runtime.item.weaponKey}|${boneName}`;
    const cached = this.#anchors.get(cacheKey);
    if (cached !== undefined) {
      const mesh = cached && runtime.meshes[cached.meshIndex];
      return mesh instanceof THREE.SkinnedMesh && cached ? { mesh, vertex: cached.vertex } : null;
    }
    const pivot = runtime.bones.get(boneName)?.bone;
    const search: { best: { meshIndex: number; vertex: number } | null; farthest: number } = { best: null, farthest: -1 };
    if (pivot) {
      const restWorld = new THREE.Vector3();
      const target = new THREE.Vector3();
      runtime.meshes.forEach((mesh, meshIndex) => {
        if (!(mesh instanceof THREE.SkinnedMesh)) return;
        const owner = dominantBones(mesh);
        const boneIndex = mesh.skeleton.bones.findIndex((bone) => bone.name === boneName);
        if (boneIndex < 0) return;
        // Pivot and vertices compared in bind space, where the mesh rests.
        restWorld.setFromMatrixPosition(mesh.skeleton.boneInverses[boneIndex].clone().invert());
        owner.forEach((name, vertex) => {
          if (name !== boneName) return;
          target.fromBufferAttribute(mesh.geometry.getAttribute('position'), vertex).applyMatrix4(mesh.bindMatrix);
          const distance = target.distanceToSquared(restWorld);
          if (distance > search.farthest) {
            search.farthest = distance;
            search.best = { meshIndex, vertex };
          }
        });
      });
    }
    this.#anchors.set(cacheKey, search.best);
    const found = search.best;
    const mesh = found ? runtime.meshes[found.meshIndex] : null;
    return found && mesh instanceof THREE.SkinnedMesh ? { mesh, vertex: found.vertex } : null;
  }
}
