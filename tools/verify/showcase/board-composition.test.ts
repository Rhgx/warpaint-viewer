import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import { compose } from '../../../src/showcase/boardComposition';
import type { BoardLayoutHost } from '../../../src/showcase/boardLayout';
import { BOARD_HEIGHT, BOARD_WIDTH, LOGO_SPACE } from '../../../src/showcase/boardMetrics';
import type { ItemRuntime, ShowcaseItem } from '../../../src/showcase/showcaseTypes';

/** Width and height at 100%, roughly as the stock weapons measure on the board. */
const STOCK: Record<string, [number, number]> = {
  c_rocketlauncher: [88, 34], c_minigun: [94, 62], c_sniperrifle: [105, 34], c_flamethrower: [112, 42], c_grenadelauncher: [80, 34],
  c_scattergun: [70, 18], c_shotgun: [72, 18], c_stickybomb_launcher: [52, 30], c_smg: [56, 32], c_medigun: [96, 30],
  c_pistol: [20, 18], c_revolver: [32, 18], c_knife: [28, 5], c_wrench: [50, 16],
};

function fakeRuntime(weaponKey: string, [width, height]: [number, number]): ItemRuntime {
  const item = { id: weaponKey, weaponKey, weaponName: weaponKey, part: null, pose: {}, scale: 1, flipped: false, roll: 0, tilt: 0, turn: 0, x: 0, y: 0 } as unknown as ShowcaseItem;
  return { item, root: new THREE.Group(), footprint: { width, height } } as unknown as ItemRuntime;
}

/** The weapon's box as the footprint would measure it at its size; a hanging piece runs below the weapon. */
function remeasure(runtime: ItemRuntime, base: [number, number]): void {
  const { scale } = runtime.item;
  const [width, height] = [base[0] * scale, base[1] * scale];
  runtime.footprint = {
    originX: -width / 2, originY: -height / 2, width, height: runtime.item.weaponKey === 'c_medigun' ? height * 2 : height,
    body: { minX: -width / 2, maxX: width / 2, minY: -height / 2, maxY: height / 2 },
  } as unknown as ItemRuntime['footprint'];
}

function layOut(sizes: Record<string, [number, number]>, logoSpace: boolean, layoutSize = 1, crowded = false): ItemRuntime[] {
  const runtimes = Object.entries(sizes).map(([key, size]) => fakeRuntime(key, size));
  const host: BoardLayoutHost = {
    grid: () => (crowded ? 'coarse' : 'normal'),
    spacing: () => (crowded ? 2 : 1),
    keepApart: () => true,
    layoutSize: () => layoutSize,
    scene: new THREE.Scene(),
    appendItem: () => undefined,
    reshape: (runtime) => remeasure(runtime, sizes[runtime.item.weaponKey]),
    problemAt: () => null,
    nearestFreeSpot: () => null,
    applyTransform: () => undefined,
    rememberValid: () => undefined,
  };
  compose(host, runtimes, logoSpace);
  return runtimes;
}

function boxOf(runtime: ItemRuntime) {
  const { item, footprint } = runtime;
  const body = footprint!.body;
  return { minX: item.x + body.minX, maxX: item.x + body.maxX, minY: item.y + body.minY, maxY: item.y + body.maxY };
}

const overlap = (a: ReturnType<typeof boxOf>, b: ReturnType<typeof boxOf>) => a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

describe('showcase board composition', () => {
  for (const logoSpace of [false, true]) {
    it(`places every stock weapon on the board without overlaps${logoSpace ? ' around a logo' : ''}`, () => {
      const boxes = layOut(STOCK, logoSpace).map(boxOf);
      // One grid cell of slack: positions round to the grid.
      for (const box of boxes) {
        expect(box.minX).toBeGreaterThanOrEqual(-BOARD_WIDTH / 2 - 2.5);
        expect(box.maxX).toBeLessThanOrEqual(BOARD_WIDTH / 2 + 2.5);
        expect(box.maxY).toBeLessThanOrEqual(BOARD_HEIGHT / 2 + 2.5);
      }
      boxes.forEach((box, index) => boxes.slice(index + 1).forEach((other) => expect(overlap(box, other)).toBe(false)));
    });
  }

  it('keeps the logo space free', () => {
    const logo = { minX: -LOGO_SPACE.width / 2, maxX: LOGO_SPACE.width / 2, minY: -LOGO_SPACE.height / 2, maxY: LOGO_SPACE.height / 2 };
    // Half a grid cell of slack on each side: positions round to the grid.
    const inner = { minX: logo.minX + 1.25, maxX: logo.maxX - 1.25, minY: logo.minY + 1.25, maxY: logo.maxY - 1.25 };
    for (const runtime of layOut(STOCK, true)) expect(overlap(boxOf(runtime), inner)).toBe(false);
  });

  it('does not sort the weapons into rows that shrink down the board', () => {
    const runtimes = layOut(STOCK, false);
    const largest = runtimes.filter((runtime) => ['c_minigun', 'c_flamethrower'].includes(runtime.item.weaponKey));
    // The heaviest weapons are not all at the top.
    expect(Math.min(...largest.map((runtime) => runtime.item.y))).toBeLessThan(0);
  });

  it('keeps the side meant to be seen, in the column where it faces the middle', () => {
    const sizes = { ...STOCK, c_gatling_gun: [96, 58] as [number, number] };
    const byKey = new Map(layOut(sizes, false).map((runtime) => [runtime.item.weaponKey, runtime.item]));
    expect(byKey.get('c_minigun')?.flipped).toBe(false);
    expect(byKey.get('c_minigun')?.x).toBeGreaterThan(0);
    for (const key of ['c_flamethrower', 'c_gatling_gun']) {
      expect(byKey.get(key)?.flipped).toBe(true);
      expect(byKey.get(key)?.x).toBeLessThan(0);
    }
  });

  it('keeps those weapons in their column on a board with few weapons', () => {
    const runtimes = layOut({ c_flamethrower: STOCK.c_flamethrower, c_pistol: STOCK.c_pistol, c_revolver: STOCK.c_revolver }, false);
    expect(runtimes.find((runtime) => runtime.item.weaponKey === 'c_flamethrower')?.item.x).toBeLessThan(0);
  });

  it('keeps the logo space free when nothing fits at the smallest size', () => {
    const inner = { minX: -LOGO_SPACE.width / 2 + 5, maxX: LOGO_SPACE.width / 2 - 5, minY: -LOGO_SPACE.height / 2 + 5, maxY: LOGO_SPACE.height / 2 - 5 };
    for (const runtime of layOut(STOCK, true, 1, true)) expect(overlap(boxOf(runtime), inner)).toBe(false);
  });

  it('tries the smallest size before giving up on a fit', () => {
    const many = Object.fromEntries(Array.from({ length: 16 }, (_, index): [string, [number, number]] => [`weapon_${index}`, [70, 24]]));
    const boxes = layOut(many, true, 1, true).map(boxOf);
    boxes.forEach((box, index) => boxes.slice(index + 1).forEach((other) => expect(overlap(box, other)).toBe(false)));
  });

  it('sets a hanging weapon on the bottom edge, with its hose posed to run off it', () => {
    const medigun = layOut(STOCK, false).find((runtime) => runtime.item.weaponKey === 'c_medigun')!;
    expect(boxOf(medigun).minY).toBeLessThan(-BOARD_HEIGHT / 2 + 10);
    expect(medigun.item.pose.drop).toBeGreaterThan(0);
  });

  it('lays out two weapons, and the most a board holds, at a smaller Fill', () => {
    expect(layOut({ c_pistol: STOCK.c_pistol, c_revolver: STOCK.c_revolver }, true, 0.5)).toHaveLength(2);
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, index): [string, [number, number]] => [`weapon_${index}`, [70, 24]]));
    const boxes = layOut(many, false).map(boxOf);
    boxes.forEach((box, index) => boxes.slice(index + 1).forEach((other) => expect(overlap(box, other)).toBe(false)));
  });
});
