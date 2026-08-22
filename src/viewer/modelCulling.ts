import * as THREE from 'three';

const POSITION_WELD_EPSILON = 1e-5;
const POSITION_WELD_EPSILON_SQUARED = POSITION_WELD_EPSILON * POSITION_WELD_EPSILON;

class DisjointSet {
  readonly #parent: Int32Array;

  constructor(size: number) {
    this.#parent = new Int32Array(size);
    for (let index = 0; index < size; index += 1) this.#parent[index] = index;
  }

  find(value: number): number {
    let root = value;
    while (this.#parent[root] !== root) root = this.#parent[root];
    while (this.#parent[value] !== value) {
      const parent = this.#parent[value];
      this.#parent[value] = root;
      value = parent;
    }
    return root;
  }

  union(first: number, second: number): void {
    const firstRoot = this.find(first);
    const secondRoot = this.find(second);
    if (firstRoot === secondRoot) return;
    this.#parent[secondRoot] = firstRoot;
  }
}

interface CullMap {
  readonly originalIndices: number[];
  readonly faceComponents: number[];
  readonly componentIndices: number[][];
}

function spatialKey(x: number, y: number, z: number): string {
  return `${Math.floor(x / POSITION_WELD_EPSILON)},${Math.floor(y / POSITION_WELD_EPSILON)},${Math.floor(z / POSITION_WELD_EPSILON)}`;
}

function buildCullMap(source: THREE.BufferGeometry): CullMap | null {
  const index = source.getIndex();
  const position = source.getAttribute('position');
  if (!index || !position || position.itemSize < 3 || index.count < 3 || index.count % 3 !== 0) return null;

  const originalIndices = Array.from({ length: index.count }, (_, offset) => index.getX(offset));
  const referencedVertices = new Set<number>();
  for (const value of originalIndices) {
    if (!Number.isInteger(value) || value < 0 || value >= position.count) return null;
    referencedVertices.add(value);
  }

  const vertexConnectivity = new DisjointSet(position.count);
  const buckets = new Map<string, number[]>();
  for (const vertex of referencedVertices) {
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;

    const cellX = Math.floor(x / POSITION_WELD_EPSILON);
    const cellY = Math.floor(y / POSITION_WELD_EPSILON);
    const cellZ = Math.floor(z / POSITION_WELD_EPSILON);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
          const candidates = buckets.get(`${cellX + offsetX},${cellY + offsetY},${cellZ + offsetZ}`);
          if (!candidates) continue;
          for (const candidate of candidates) {
            const dx = x - position.getX(candidate);
            const dy = y - position.getY(candidate);
            const dz = z - position.getZ(candidate);
            if (dx * dx + dy * dy + dz * dz <= POSITION_WELD_EPSILON_SQUARED) {
              vertexConnectivity.union(vertex, candidate);
            }
          }
        }
      }
    }

    const key = spatialKey(x, y, z);
    const cell = buckets.get(key);
    if (cell) cell.push(vertex);
    else buckets.set(key, [vertex]);
  }

  const faceCount = index.count / 3;
  const faceConnectivity = new DisjointSet(faceCount);
  const firstFaceByVertex = new Map<number, number>();
  for (let face = 0; face < faceCount; face += 1) {
    const firstIndex = face * 3;
    for (let corner = 0; corner < 3; corner += 1) {
      const weldedVertex = vertexConnectivity.find(originalIndices[firstIndex + corner]!);
      const firstFace = firstFaceByVertex.get(weldedVertex);
      if (firstFace === undefined) firstFaceByVertex.set(weldedVertex, face);
      else faceConnectivity.union(face, firstFace);
    }
  }

  const componentIds = new Map<number, number>();
  const faceComponents = new Array<number>(faceCount);
  for (let face = 0; face < faceCount; face += 1) {
    const root = faceConnectivity.find(face);
    let component = componentIds.get(root);
    if (component === undefined) {
      component = componentIds.size;
      componentIds.set(root, component);
    }
    faceComponents[face] = component;
  }
  const componentIndices = Array.from({ length: componentIds.size }, () => [] as number[]);
  for (let face = 0; face < faceCount; face += 1) {
    const component = faceComponents[face]!;
    const offset = face * 3;
    componentIndices[component]!.push(
      originalIndices[offset]!,
      originalIndices[offset + 1]!,
      originalIndices[offset + 2]!,
    );
  }
  return { originalIndices, faceComponents, componentIndices };
}

/** Mutable connected-component index over an owned geometry clone. */
export class CullableGeometry {
  readonly geometry: THREE.BufferGeometry;

  readonly #cullMap: CullMap | null;
  readonly #activeFaces: number[];
  readonly #componentGeometries: Array<THREE.BufferGeometry | null>;
  readonly #hiddenComponents = new Set<number>();
  #disposed = false;

  constructor(source: THREE.BufferGeometry) {
    this.geometry = source.clone();
    this.#cullMap = buildCullMap(this.geometry);
    this.#componentGeometries = this.#cullMap
      ? Array.from({ length: this.#cullMap.componentIndices.length }, () => null)
      : [];
    this.#activeFaces = this.#cullMap
      ? Array.from({ length: this.#cullMap.faceComponents.length }, (_, face) => face)
      : [];
  }

  get componentCount(): number {
    return this.#cullMap?.componentIndices.length ?? 0;
  }

  get hiddenCount(): number {
    return this.#hiddenComponents.size;
  }

  /** Resolve a filtered raycast face to its stable component. */
  componentForVisibleFace(faceIndex: number): number | null {
    if (this.#disposed || !this.#cullMap || !Number.isInteger(faceIndex)) return null;
    const face = this.#activeFaces[faceIndex];
    if (face === undefined) return null;
    const component = this.#cullMap.faceComponents[face];
    return component === undefined ? null : component;
  }

  hideComponent(component: number): boolean {
    if (!this.#isValidComponent(component) || this.#hiddenComponents.has(component)) return false;
    this.#hiddenComponents.add(component);
    this.#syncVisibleIndex();
    return true;
  }

  restoreComponent(component: number): boolean {
    if (!this.#isValidComponent(component) || !this.#hiddenComponents.delete(component)) return false;
    this.#syncVisibleIndex();
    return true;
  }

  isComponentHidden(component: number): boolean {
    return this.#isValidComponent(component) && this.#hiddenComponents.has(component);
  }

  /** Cached position-only geometry borrowed by the viewer's hover and edge passes. */
  getComponentGeometry(component: number): THREE.BufferGeometry | null {
    if (!this.#isValidComponent(component)) return null;
    const cached = this.#componentGeometries[component];
    if (cached) return cached;

    const cullMap = this.#cullMap!;
    const componentIndices = cullMap.componentIndices[component];
    if (!componentIndices) return null;

    const componentGeometry = new THREE.BufferGeometry()
      .setAttribute('position', this.geometry.getAttribute('position'))
      .setIndex(componentIndices);
    this.#componentGeometries[component] = componentGeometry;
    return componentGeometry;
  }

  restore(): boolean {
    if (this.#disposed || !this.#cullMap || this.#hiddenComponents.size === 0) return false;
    this.#hiddenComponents.clear();
    this.#syncVisibleIndex();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const componentGeometry of this.#componentGeometries) componentGeometry?.dispose();
    this.geometry.dispose();
    this.#disposed = true;
  }

  #isValidComponent(component: number): boolean {
    return !this.#disposed
      && Number.isInteger(component)
      && component >= 0
      && component < this.componentCount;
  }

  #syncVisibleIndex(): void {
    if (!this.#cullMap) return;
    this.#activeFaces.length = 0;
    for (let face = 0; face < this.#cullMap.faceComponents.length; face += 1) {
      if (!this.#hiddenComponents.has(this.#cullMap.faceComponents[face]!)) this.#activeFaces.push(face);
    }

    if (this.#hiddenComponents.size === 0) {
      this.geometry.setIndex(this.#cullMap.originalIndices);
      return;
    }

    const filteredIndices: number[] = [];
    for (const activeFace of this.#activeFaces) {
      const offset = activeFace * 3;
      filteredIndices.push(
        this.#cullMap.originalIndices[offset]!,
        this.#cullMap.originalIndices[offset + 1]!,
        this.#cullMap.originalIndices[offset + 2]!,
      );
    }
    this.geometry.setIndex(filteredIndices);
  }
}
