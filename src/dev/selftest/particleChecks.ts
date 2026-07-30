import * as THREE from 'three';

export interface PointsStats {
  name: string;
  alive: number;
  nan: number;
  mean: [number, number, number];
  livePoints: Array<[number, number, number]>;
  meanAbsOffset: (origin: [number, number, number]) => [number, number, number];
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
    const mean: [number, number, number] = [0, 0, 0];
    for (const point of live) {
      mean[0] += point[0];
      mean[1] += point[1];
      mean[2] += point[2];
    }
    if (live.length) {
      mean[0] /= live.length;
      mean[1] /= live.length;
      mean[2] /= live.length;
    }
    out.push({
      name: points.name || '(unnamed)',
      alive: live.length,
      nan,
      mean,
      livePoints: live,
      meanAbsOffset: (origin) => {
        const offset: [number, number, number] = [0, 0, 0];
        for (const point of live) {
          offset[0] += Math.abs(point[0] - origin[0]);
          offset[1] += Math.abs(point[1] - origin[1]);
          offset[2] += Math.abs(point[2] - origin[2]);
        }
        if (live.length) {
          offset[0] /= live.length;
          offset[1] /= live.length;
          offset[2] /= live.length;
        }
        return offset;
      },
      maxDist: (origin) => Math.max(0, ...live.map((point) => Math.hypot(
        point[0] - origin[0], point[1] - origin[1], point[2] - origin[2],
      ))),
    });
  });
  return out;
}
