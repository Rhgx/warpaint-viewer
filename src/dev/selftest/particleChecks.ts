import * as THREE from 'three';

export interface PointsStats {
  name: string;
  alive: number;
  nan: number;
  livePoints: Array<[number, number, number]>;
  maxDist: (origin: [number, number, number]) => number;
}

export function collectPointsStats(group: THREE.Object3D): PointsStats[] {
  const out: PointsStats[] = [];
  group.traverse((object) => {
    const points = object as THREE.Points;
    if (!points.isPoints) return;
    const geometry = points.geometry as THREE.BufferGeometry;
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;
    const size = geometry.getAttribute('aSize') as THREE.BufferAttribute;
    const live: Array<[number, number, number]> = [];
    let nan = 0;
    for (let index = 0; index < position.count; index += 1) {
      const point: [number, number, number] = [
        position.getX(index), position.getY(index), position.getZ(index),
      ];
      if (!point.every(Number.isFinite)) {
        nan += 1;
      } else if (size.getX(index) > 0) {
        live.push(point);
      }
    }
    out.push({
      name: points.name || '(unnamed)',
      alive: live.length,
      nan,
      livePoints: live,
      maxDist: (origin) => Math.max(0, ...live.map((point) => Math.hypot(
        point[0] - origin[0], point[1] - origin[1], point[2] - origin[2],
      ))),
    });
  });
  return out;
}
