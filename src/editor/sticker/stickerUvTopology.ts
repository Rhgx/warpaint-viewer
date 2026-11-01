/**
 * Static UV topology for picking one physical instance of a sticker when a model reuses UVs on several parts.
 * Triangles join only across a shared edge whose UVs also agree (modulo wrapping).
 */

export type StickerUv = readonly [number, number];
export type StickerVec3 = readonly [number, number, number];

export interface StickerUvTopologyAttribute {
  readonly count: number;
  getX(index: number): number;
  getY(index: number): number;
  getZ?(index: number): number;
}

export interface StickerUvTopologyIndex {
  readonly count: number;
  getX(index: number): number;
}

/** Structural on purpose: THREE.BufferGeometry satisfies this without a hard runtime dependency. */
export interface StickerUvTopologyGeometry {
  getAttribute(name: 'position' | 'uv'): StickerUvTopologyAttribute | undefined;
  getIndex(): StickerUvTopologyIndex | null;
}

export interface StickerUvTopologyTriangle {
  readonly meshIndex: number;
  /** Face index in the mesh's indexed/non-indexed triangle stream. */
  readonly triangleIndex: number;
  readonly chartId: number;
  readonly vertexIndices: readonly [number, number, number];
  readonly positions: readonly [StickerVec3, StickerVec3, StickerVec3];
  readonly uvs: readonly [StickerUv, StickerUv, StickerUv];
}

interface StickerUvChart {
  readonly id: number;
  readonly meshIndex: number;
  readonly triangleIndexes: readonly number[];
}

export interface StickerUvCandidate {
  readonly chartId: number;
  readonly meshIndex: number;
  readonly triangleIndex: number;
  /** Index of this target in the query passed to findCandidates(). */
  readonly targetIndex: number;
  /** The periodic copy of the query point inside this triangle's UV basis. */
  readonly uv: StickerUv;
  /** Integer UV-tile offset from the authored query to this physical copy. */
  readonly periodicOffset: readonly [number, number];
  /** Barycentric weights for the returned triangle, in vertexIndices order. */
  readonly barycentric: readonly [number, number, number];
}

export interface StickerUvTopology {
  readonly triangles: readonly StickerUvTopologyTriangle[];
  readonly charts: readonly StickerUvChart[];
  /** Resolve a THREE raycaster-style mesh/face identity to its physical chart. */
  chartIdForFace(meshIndex: number, triangleIndex: number): number | null;
  /** Resolve targets against all charts, or one chart (the fast live-gizmo path). */
  findCandidates(targets: readonly StickerUv[], chartId?: number): readonly (readonly StickerUvCandidate[])[];
}

interface RawTriangle {
  readonly meshIndex: number;
  readonly triangleIndex: number;
  readonly vertexIndices: readonly [number, number, number];
  readonly positions: readonly [StickerVec3, StickerVec3, StickerVec3];
  readonly uvs: readonly [StickerUv, StickerUv, StickerUv];
}

const QUANTIZE = 1_000_000;
const EPSILON = 1e-7;

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function quantized(value: number): string {
  return String(Math.round(value * QUANTIZE));
}

function periodic(value: number): number {
  const result = value - Math.floor(value);
  // Snap float noise at a wrap seam so 0 and 1 quantize identically.
  return Math.abs(result - 1) < EPSILON || Math.abs(result) < EPSILON ? 0 : result;
}

function positionKey(position: StickerVec3): string {
  return `${quantized(position[0])},${quantized(position[1])},${quantized(position[2])}`;
}

function uvKey(uv: StickerUv): string {
  return `${quantized(periodic(uv[0]))},${quantized(periodic(uv[1]))}`;
}

/** A shared edge is physical position plus the UV assigned at each endpoint. */
function edgeKey(positionA: StickerVec3, uvA: StickerUv, positionB: StickerVec3, uvB: StickerUv): string {
  const a = `${positionKey(positionA)}@${uvKey(uvA)}`;
  const b = `${positionKey(positionB)}@${uvKey(uvB)}`;
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

class UnionFind {
  private parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(value: number): number {
    let root = value;
    while (this.parents[root] !== root) root = this.parents[root];
    while (this.parents[value] !== value) {
      const parent = this.parents[value];
      this.parents[value] = root;
      value = parent;
    }
    return root;
  }

  join(a: number, b: number) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parents[rootB] = rootA;
  }
}

function readTriangle(
  geometry: StickerUvTopologyGeometry,
  meshIndex: number,
  triangleIndex: number,
): RawTriangle | null {
  const position = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const index = geometry.getIndex();
  if (!position || !uv || !position.getZ) return null;
  const offset = triangleIndex * 3;
  const vertexIndices = index
    ? [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)] as const
    : [offset, offset + 1, offset + 2] as const;
  if (vertexIndices.some((vertex) => !Number.isInteger(vertex) || vertex < 0 || vertex >= position.count || vertex >= uv.count)) return null;
  const positions = vertexIndices.map((vertex) => [position.getX(vertex), position.getY(vertex), position.getZ!(vertex)] as const);
  const uvs = vertexIndices.map((vertex) => [uv.getX(vertex), uv.getY(vertex)] as const);
  if (![...positions.flat(), ...uvs.flat()].every(finite)) return null;
  return {
    meshIndex,
    triangleIndex,
    vertexIndices,
    positions: [positions[0], positions[1], positions[2]],
    uvs: [uvs[0], uvs[1], uvs[2]],
  };
}

function unwrapAround(reference: StickerUv, point: StickerUv): StickerUv {
  const unwrap = (origin: number, value: number) => {
    const difference = value - origin;
    // A 0 to 1 edge spans the full texture; only unwrap near-full-range jumps at a wrap seam.
    if (difference > 0.5 && difference < 1 - EPSILON) return value - 1;
    if (difference < -0.5 && difference > -1 + EPSILON) return value + 1;
    return value;
  };
  return [
    unwrap(reference[0], point[0]),
    unwrap(reference[1], point[1]),
  ];
}

function candidateForTarget(
  triangle: StickerUvTopologyTriangle,
  target: StickerUv,
  targetIndex: number,
): StickerUvCandidate | null {
  if (![target[0], target[1]].every(finite)) return null;
  const [a, rawB, rawC] = triangle.uvs;
  const b = unwrapAround(a, rawB);
  const c = unwrapAround(a, rawC);
  const centroid: StickerUv = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3];
  const denominator = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(denominator) < 1e-12) return null;
  let best: { uv: StickerUv; barycentric: readonly [number, number, number]; distance: number } | null = null;
  // Authored destinations may be unwrapped (1.02 at a 0/1 seam). Test nearby periodic copies and keep the in-triangle one nearest the chart centre.
  const baseU = Math.round(centroid[0] - target[0]);
  const baseV = Math.round(centroid[1] - target[1]);
  for (let offsetU = -1; offsetU <= 1; offsetU += 1) {
    for (let offsetV = -1; offsetV <= 1; offsetV += 1) {
      const uv: StickerUv = [target[0] + baseU + offsetU, target[1] + baseV + offsetV];
      const weightA = ((b[1] - c[1]) * (uv[0] - c[0]) + (c[0] - b[0]) * (uv[1] - c[1])) / denominator;
      const weightB = ((c[1] - a[1]) * (uv[0] - c[0]) + (a[0] - c[0]) * (uv[1] - c[1])) / denominator;
      const weightC = 1 - weightA - weightB;
      if (weightA < -EPSILON || weightB < -EPSILON || weightC < -EPSILON) continue;
      const distance = (uv[0] - centroid[0]) ** 2 + (uv[1] - centroid[1]) ** 2;
      if (!best || distance < best.distance) best = { uv, barycentric: [weightA, weightB, weightC], distance };
    }
  }
  if (!best) return null;
  return {
    chartId: triangle.chartId,
    meshIndex: triangle.meshIndex,
    triangleIndex: triangle.triangleIndex,
    targetIndex,
    uv: best.uv,
    periodicOffset: [Math.round(best.uv[0] - target[0]), Math.round(best.uv[1] - target[1])],
    barycentric: best.barycentric,
  };
}

/** Build periodic UV charts for static paintable meshes. Invalid triangles are skipped rather than failing the model. */
export function buildStickerUvTopology(
  geometries: readonly StickerUvTopologyGeometry[],
): StickerUvTopology {
  const rawTriangles: RawTriangle[] = [];
  for (let meshIndex = 0; meshIndex < geometries.length; meshIndex += 1) {
    const geometry = geometries[meshIndex];
    const position = geometry?.getAttribute('position');
    const uv = geometry?.getAttribute('uv');
    if (!position || !uv || !position.getZ || position.count < 3 || uv.count < 3) continue;
    const index = geometry.getIndex();
    const triangleCount = Math.floor((index?.count ?? Math.min(position.count, uv.count)) / 3);
    for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex += 1) {
      const triangle = readTriangle(geometry, meshIndex, triangleIndex);
      if (triangle) rawTriangles.push(triangle);
    }
  }

  const union = new UnionFind(rawTriangles.length);
  const edgeOwners = new Map<string, number>();
  for (let triangleOffset = 0; triangleOffset < rawTriangles.length; triangleOffset += 1) {
    const triangle = rawTriangles[triangleOffset];
    for (const [from, to] of [[0, 1], [1, 2], [2, 0]] as const) {
      // Include the mesh index: separate meshes can share positions and texture placement.
      const key = `${triangle.meshIndex}:${edgeKey(
        triangle.positions[from], triangle.uvs[from], triangle.positions[to], triangle.uvs[to],
      )}`;
      const previous = edgeOwners.get(key);
      if (previous === undefined) edgeOwners.set(key, triangleOffset);
      else union.join(previous, triangleOffset);
    }
  }

  const chartByRoot = new Map<number, number>();
  const chartTriangleIndexes = new Map<number, number[]>();
  const meshByChart = new Map<number, number>();
  const triangles = rawTriangles.map((raw, triangleOffset): StickerUvTopologyTriangle => {
    const root = union.find(triangleOffset);
    let chartId = chartByRoot.get(root);
    if (chartId === undefined) {
      chartId = chartByRoot.size;
      chartByRoot.set(root, chartId);
      chartTriangleIndexes.set(chartId, []);
      meshByChart.set(chartId, raw.meshIndex);
    }
    chartTriangleIndexes.get(chartId)!.push(triangleOffset);
    return { ...raw, chartId };
  });
  const charts = [...chartTriangleIndexes.entries()].map(([id, triangleIndexes]): StickerUvChart => ({
    id,
    meshIndex: meshByChart.get(id)!,
    triangleIndexes,
  }));
  const chartByFace = new Map<string, number>();
  for (const triangle of triangles) chartByFace.set(`${triangle.meshIndex}:${triangle.triangleIndex}`, triangle.chartId);

  // Bin chart UVs in wrapped cells so a live drag can query one chart cheaply across seams.
  const binSide = 16;
  const wrapCell = (cell: number) => ((cell % binSide) + binSide) % binSide;
  const chartBins = new Map<number, Map<number, StickerUvTopologyTriangle[]>>();
  for (const triangle of triangles) {
    const [a, rawB, rawC] = triangle.uvs;
    const b = unwrapAround(a, rawB);
    const c = unwrapAround(a, rawC);
    const minU = Math.min(a[0], b[0], c[0]);
    const maxU = Math.max(a[0], b[0], c[0]);
    const minV = Math.min(a[1], b[1], c[1]);
    const maxV = Math.max(a[1], b[1], c[1]);
    // Match the barycentric test's tolerance just beyond triangle edges.
    const padU = Math.max(1, maxU - minU) * EPSILON * 3;
    const padV = Math.max(1, maxV - minV) * EPSILON * 3;
    const firstU = Math.floor((minU - padU) * binSide);
    const firstV = Math.floor((minV - padV) * binSide);
    const lastU = Math.min(firstU + binSide - 1, Math.floor((maxU + padU) * binSide));
    const lastV = Math.min(firstV + binSide - 1, Math.floor((maxV + padV) * binSide));
    let bins = chartBins.get(triangle.chartId);
    if (!bins) { bins = new Map(); chartBins.set(triangle.chartId, bins); }
    for (let u = 0; u <= lastU - firstU; u += 1) {
      for (let v = 0; v <= lastV - firstV; v += 1) {
        const key = wrapCell(firstU + u) + wrapCell(firstV + v) * binSide;
        const bin = bins.get(key);
        if (bin) bin.push(triangle); else bins.set(key, [triangle]);
      }
    }
  }

  return {
    triangles,
    charts,
    chartIdForFace(meshIndex, triangleIndex) {
      if (!Number.isInteger(meshIndex) || !Number.isInteger(triangleIndex)) return null;
      return chartByFace.get(`${meshIndex}:${triangleIndex}`) ?? null;
    },
    findCandidates(targets, chartId) {
      return targets.map((target, targetIndex) => {
        const key = wrapCell(Math.floor(target[0] * binSide)) + wrapCell(Math.floor(target[1] * binSide)) * binSide;
        const source = chartId === undefined ? triangles : chartBins.get(chartId)?.get(key) ?? [];
        const candidates: StickerUvCandidate[] = [];
        for (const triangle of source) {
          const candidate = candidateForTarget(triangle, target, targetIndex);
          if (candidate) candidates.push(candidate);
        }
        return candidates;
      });
    },
  };
}
