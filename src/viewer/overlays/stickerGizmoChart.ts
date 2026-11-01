// Resolves sticker UV samples to one physical UV chart, so the gizmo never jumps between overlapping islands.
import * as THREE from 'three';
import { stickerGizmoAnchorContainsCentre } from '../../editor/sticker/stickerGizmo';
import {
  buildStickerUvTopology,
  type StickerUvCandidate,
  type StickerUvTopology,
  type StickerUvTopologyTriangle,
} from '../../editor/sticker/stickerUvTopology';

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

/** What the chart resolver reads from the overlay that owns it. */
export interface StickerGizmoChartHost {
  /** The array is replaced on every model load, so read it on each use. */
  readonly getPaintableMeshes: () => THREE.Mesh[];
}

export class StickerGizmoChartResolver {
  private readonly host: StickerGizmoChartHost;
  // Gizmo visibility samples set a short far plane. Keep that state apart from pointer picking so
  // a later move ray never inherits the sample's range.
  private stickerGizmoRaycaster = new THREE.Raycaster();
  // A decal must stay on one physical UV chart. Built on first use after a geometry change, so live
  // frames query it instead of rediscovering overlapping UV instances.
  private cachedStickerUvTopology: StickerUvTopology | null = null;
  private stickerUvTopologyTriangles = new Map<string, StickerUvTopologyTriangle>();
  private stickerGizmoAnchorChartId: number | null = null;

  constructor(host: StickerGizmoChartHost) {
    this.host = host;
  }

  /** Forget the anchor, triangle map and topology cache after the mesh geometry changes. */
  reset() {
    this.stickerGizmoAnchorChartId = null;
    this.stickerUvTopologyTriangles.clear();
    this.cachedStickerUvTopology = null;
  }

  clearAnchor(): void {
    this.stickerGizmoAnchorChartId = null;
  }

  private stickerTopologyFaceKey(meshIndex: number, triangleIndex: number): string {
    return `${meshIndex}:${triangleIndex}`;
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

  chartIdForRaycastHit(hit: THREE.Intersection<THREE.Mesh>): number | null {
    const faceIndex = hit.faceIndex;
    if (!this.stickerUvTopology || typeof faceIndex !== 'number' || !Number.isInteger(faceIndex)) return null;
    const meshIndex = this.host.getPaintableMeshes().indexOf(hit.object);
    return meshIndex < 0 ? null : this.stickerUvTopology.chartIdForFace(meshIndex, faceIndex);
  }

  /** Returns true only when the anchor changed, so the owner knows to invalidate its projection. */
  selectAnchor(chartId: number | null): boolean {
    if (chartId === null || !this.stickerUvTopology?.charts.some((chart) => chart.id === chartId)) return false;
    if (this.stickerGizmoAnchorChartId === chartId) return false;
    this.stickerGizmoAnchorChartId = chartId;
    return true;
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
   * Resolves the sticker's UV samples against one physical UV chart. The first frame scores
   * visible center, corner and edge samples to pick an anchor, which then sticks: if it is
   * occluded the controls hide rather than jump to an overlapping island.
   */
  findVisibleChart(
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
          // Cast through the candidate's projected screen point, not from the camera position: orthographic
          // rays are parallel, and a perspective-style origin would pick a different surface.
          const ndc = candidate.point.clone().project(camera);
          if (!Number.isFinite(ndc.x) || !Number.isFinite(ndc.y) || !Number.isFinite(ndc.z)
            || ndc.x < -1 || ndc.x > 1 || ndc.y < -1 || ndc.y > 1 || ndc.z < -1 || ndc.z > 1) continue;
          this.stickerGizmoRaycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
          this.stickerGizmoRaycaster.near = 0;
          this.stickerGizmoRaycaster.far = Number.POSITIVE_INFINITY;
          const visibleHit = this.stickerGizmoRaycaster.intersectObjects<THREE.Mesh>(this.host.getPaintableMeshes(), false)[0];
          const hitMeshIndex = visibleHit ? this.host.getPaintableMeshes().indexOf(visibleHit.object) : -1;
          const hitChartId = visibleHit ? this.chartIdForRaycastHit(visibleHit) : null;
          // Equal depth is not identity: overlapping UV islands can share a ray. The hit must belong to
          // this mesh and physical chart before it can show a control.
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
      // Occlusion must not jump the gizmo to a duplicate UV copy. But UV-view edits, undo and direct
      // moves can put the center outside the anchor's chart. That is stale geometry, not occlusion,
      // so the anchor is reacquired. Target zero is always the sticker center.
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
}
