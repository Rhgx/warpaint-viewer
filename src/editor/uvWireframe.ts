import type * as THREE from 'three';

/**
 * A transparent drawing of the UV islands used by the paintable weapon mesh.
 * It is deliberately an SVG rather than a WebGL readback: callers can put it
 * over any 2D texture preview without allocating another GPU target or
 * stalling the renderer.
 */
export interface UvWireframe {
  /** SVG markup, useful when an editor wants to inline the wireframe. */
  readonly svg: string;
  /** Safe for an <img> source or a CSS background image. */
  readonly dataUrl: string;
  /** Number of mesh geometries that supplied usable UVs. */
  readonly meshCount: number;
  /** Number of valid triangles examined before their edges were deduplicated. */
  readonly triangleCount: number;
  /** Number of unique UV-space line segments in the SVG. */
  readonly edgeCount: number;
}

export interface UvWireframeOptions {
  /**
   * Stroke width in normalized UV space. The default remains legible over a
   * textured 2D preview without hiding sticker artwork.
   */
  readonly strokeWidth?: number;
  /** CSS colour for the wireframe. Keep it opaque: the host can control the
   * entire overlay's opacity without weakening dense island boundaries. */
  readonly stroke?: string;
}

type UvAttribute = Pick<THREE.BufferAttribute, 'count' | 'getX' | 'getY'>;
type UvGeometry = Pick<THREE.BufferGeometry, 'getAttribute' | 'getIndex'>;

interface UvPoint {
  readonly u: number;
  readonly v: number;
}

interface UvEdge {
  readonly a: UvPoint;
  readonly b: UvPoint;
}

const DEFAULT_STROKE_WIDTH = 0.0015;
const DEFAULT_STROKE = '#93b7ef';

function finiteUv(attribute: UvAttribute, index: number): UvPoint | null {
  if (!Number.isInteger(index) || index < 0 || index >= attribute.count) return null;
  const u = attribute.getX(index);
  const v = attribute.getY(index);
  return Number.isFinite(u) && Number.isFinite(v) ? { u, v } : null;
}

// Source models commonly share the mathematically same edge using distinct
// vertices. Quantizing only for the map key makes those edges one SVG segment
// while preserving the original coordinates in the rendered path.
function pointKey(point: UvPoint): string {
  return `${Math.round(point.u * 1_000_000)},${Math.round(point.v * 1_000_000)}`;
}

function edgeKey(a: UvPoint, b: UvPoint): string {
  const aKey = pointKey(a);
  const bKey = pointKey(b);
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}

function coordinate(value: number): string {
  // Six decimal places match the deduplication precision and avoid expanding
  // a large weapon's wireframe into a multi-megabyte data URL.
  return Number(value.toFixed(6)).toString();
}

function svgEscapeColor(color: string): string {
  // CSS colours are user-facing options. Attribute escaping keeps the output
  // safe if a caller supplies a named/functional colour instead of a hex one.
  return color.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&apos;',
    '"': '&quot;',
  })[character] ?? character);
}

function appendTriangleEdges(edges: Map<string, UvEdge>, a: UvPoint, b: UvPoint, c: UvPoint) {
  for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
    const key = edgeKey(from, to);
    // A degenerate UV triangle has no useful line at this edge.
    if (pointKey(from) === pointKey(to) || edges.has(key)) continue;
    edges.set(key, { a: from, b: to });
  }
}

/**
 * Build the real paintable mesh UV wireframe. Coordinates intentionally stay
 * in the viewer's UV convention (u right, v down): Source/VTF inputs and the
 * compositor both use that convention, so it aligns with an unflipped 2D
 * texture preview.
 *
 * Returns null when the model has no usable UV triangles. This is preferable
 * to an invented grid because a placement editor must not imply an island
 * layout that the weapon does not have.
 */
export function createUvWireframe(
  geometries: readonly UvGeometry[],
  options: UvWireframeOptions = {},
): UvWireframe | null {
  const edges = new Map<string, UvEdge>();
  let meshCount = 0;
  let triangleCount = 0;

  for (const geometry of geometries) {
    const candidate = geometry.getAttribute('uv');
    if (!candidate || !('getX' in candidate) || !('getY' in candidate)) continue;
    const uv = candidate as UvAttribute;
    if (!Number.isSafeInteger(uv.count) || uv.count < 3) continue;

    const index = geometry.getIndex();
    const count = index?.count ?? uv.count;
    let geometryHasTriangle = false;
    for (let offset = 0; offset + 2 < count; offset += 3) {
      const vertexIndexes = index
        ? [index.getX(offset), index.getX(offset + 1), index.getX(offset + 2)]
        : [offset, offset + 1, offset + 2];
      const points = vertexIndexes.map((vertexIndex) => finiteUv(uv, vertexIndex));
      if (!points[0] || !points[1] || !points[2]) continue;
      appendTriangleEdges(edges, points[0], points[1], points[2]);
      triangleCount++;
      geometryHasTriangle = true;
    }
    if (geometryHasTriangle) meshCount++;
  }

  if (triangleCount === 0 || edges.size === 0) return null;
  const strokeWidth = Number.isFinite(options.strokeWidth)
    ? Math.min(0.05, Math.max(0.0001, options.strokeWidth!))
    : DEFAULT_STROKE_WIDTH;
  const stroke = svgEscapeColor(options.stroke?.trim() || DEFAULT_STROKE);
  const path = [...edges.values()]
    .map(({ a, b }) => `M${coordinate(a.u)} ${coordinate(a.v)}L${coordinate(b.u)} ${coordinate(b.v)}`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" fill="none" stroke="${stroke}" stroke-width="${coordinate(strokeWidth)}" vector-effect="non-scaling-stroke"/></svg>`;
  return {
    svg,
    dataUrl: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    meshCount,
    triangleCount,
    edgeCount: edges.size,
  };
}
