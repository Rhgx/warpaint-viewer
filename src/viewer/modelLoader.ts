import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

const MODEL_CACHE_LIMIT = 8;

export interface ModelPart {
  geometry: THREE.BufferGeometry;
  materialName: string;
}

/**
 * Owns parsed GLB geometry and keeps it shared between weapon swaps.
 * Callers create their own Mesh instances around the cached geometry.
 */
export class ModelLoader {
  readonly #loader = new GLTFLoader();
  readonly #cache = new Map<string, Promise<ModelPart[]>>();

  load(url: string): Promise<ModelPart[]> {
    let pending = this.#cache.get(url);
    if (pending) {
      this.#cache.delete(url);
      this.#cache.set(url, pending);
    } else {
      pending = this.#loader.loadAsync(url).then((gltf) => {
        const parts: ModelPart[] = [];
        gltf.scene.traverse((object) => {
          if (!(object as THREE.Mesh).isMesh) return;
          const mesh = object as THREE.Mesh;
          const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
          parts.push({
            geometry: mesh.geometry as THREE.BufferGeometry,
            materialName: material?.name ?? '',
          });
        });
        if (!parts.length) throw new Error('no mesh in GLB');
        return parts;
      }).catch((error) => {
        if (this.#cache.get(url) === pending) this.#cache.delete(url);
        throw error;
      });
      this.#cache.set(url, pending);
      while (this.#cache.size > MODEL_CACHE_LIMIT) {
        const oldestUrl = this.#cache.keys().next().value;
        if (oldestUrl === undefined) break;
        const oldestPending = this.#cache.get(oldestUrl);
        this.#cache.delete(oldestUrl);
        if (!oldestPending) continue;
        oldestPending.then((parts) => {
          for (const part of parts) part.geometry.dispose();
        }).catch(() => undefined);
      }
    }
    return pending;
  }

  dispose(): void {
    for (const pending of this.#cache.values()) {
      pending.then((parts) => {
        for (const part of parts) part.geometry.dispose();
      }).catch(() => undefined);
    }
    this.#cache.clear();
  }
}

export interface ModelBounds {
  box: THREE.Box3;
  size: THREE.Vector3;
  center: THREE.Vector3;
  radius: number;
  dimensions: [number, number, number];
}

export function computeModelBounds(parts: readonly ModelPart[]): ModelBounds {
  const box = new THREE.Box3();
  for (const { geometry } of parts) {
    geometry.computeBoundingBox();
    if (geometry.boundingBox) box.union(geometry.boundingBox);
  }
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  return {
    box,
    size,
    center,
    radius: Math.max(size.x, size.y, size.z) * 0.5,
    dimensions: [size.x, size.y, size.z].sort((a, b) => b - a) as [number, number, number],
  };
}
