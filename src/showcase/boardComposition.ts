import * as THREE from 'three';

import { LAYOUT_SCALE, type BoardLayoutHost } from './boardLayout';
import { BOARD_HEIGHT, BOARD_WIDTH, GRID_CELL, LOGO_SPACE } from './boardMetrics';
import { HANGING_PARTS } from './poseRigs';
import type { ItemRuntime } from './showcaseTypes';
import { FACES_RIGHT, restingRoll, shownSideFlip } from './weaponGeometry';

// Composes a case board the way Valve's are: long weapons down the outer columns, short ones in the centre or paired up.

type RegionKind = 'left' | 'right' | 'top' | 'bottom' | 'middle';

interface Shelf {
  weapons: ItemRuntime[];
  width: number;
  height: number;
}

/** Part of the board that stacks shelves of weapons; x runs from the left edge and y from the top. */
interface Region {
  kind: RegionKind;
  left: number;
  right: number;
  top: number;
  bottom: number;
  shelves: Shelf[];
}

/** Centre column widths to try. A logo needs at least its own width; without one, 0 is two columns and the full width is one. */
const LOGO_CENTERS = [LOGO_SPACE.width, 50, 60, 70, 80, 90];
const OPEN_CENTERS = [0, 40, 50, 60, 70, 80, 90, BOARD_WIDTH];
/** A wider centre has to fit the weapons this much larger to be picked over a narrower one. */
const MEANINGFUL_GROWTH = 0.02;
/** Sizes are tried from the largest down: shelves change with size, so a smaller size is not always the one that fits. */
const SIZE_STEP = 0.02;

function spread(start: number, end: number, sizes: readonly number[]): number[] {
  const free = Math.max(0, end - start - sizes.reduce((sum, size) => sum + size, 0)) / (sizes.length + 1);
  let at = start + free;
  return sizes.map((size) => {
    const center = at + size / 2;
    at += size + free;
    return center;
  });
}

function regionsFor(center: number, logoSpace: boolean): Region[] {
  const side = (BOARD_WIDTH - center) / 2;
  const region = (kind: RegionKind, left: number, right: number, top: number, bottom: number): Region => ({ kind, left, right, top, bottom, shelves: [] });
  const regions: Region[] = [];
  if (side > 0) regions.push(region('left', 0, side, 0, BOARD_HEIGHT), region('right', BOARD_WIDTH - side, BOARD_WIDTH, 0, BOARD_HEIGHT));
  if (logoSpace) {
    const above = (BOARD_HEIGHT - LOGO_SPACE.height) / 2;
    regions.push(region('top', side, side + center, 0, above), region('bottom', side, side + center, BOARD_HEIGHT - above, BOARD_HEIGHT));
  } else if (center > 0) {
    regions.push(region('middle', side, side + center, 0, BOARD_HEIGHT));
  }
  return regions;
}

function flippedToFace(runtime: ItemRuntime, towards: 'left' | 'right'): boolean {
  const { weaponKey, part } = runtime.item;
  const shown = shownSideFlip(weaponKey, part);
  if (shown !== undefined) return shown;
  // A weapon resting upright would turn its back to the viewer.
  if (restingRoll(weaponKey, part)) return false;
  // Muzzles point left unflipped, except for those that rest pointing right.
  return FACES_RIGHT.has(weaponKey) && !part ? towards === 'left' : towards === 'right';
}

export function compose(host: BoardLayoutHost, weapons: ItemRuntime[], logoSpace: boolean): void {
  const cell = GRID_CELL[host.grid()];
  const gap = (host.keepApart() ? host.spacing() + 1 : 1) * cell;
  const hangs = (runtime: ItemRuntime) => runtime.item.weaponKey in HANGING_PARTS && !runtime.item.part;

  // Measured unflipped at 100%. Height leaves out a hanging piece, which runs off the bottom.
  for (const runtime of weapons) {
    Object.assign(runtime.item, { roll: restingRoll(runtime.item.weaponKey, runtime.item.part), tilt: 0, turn: 0, scale: 1, flipped: false });
    const hanging = HANGING_PARTS[runtime.item.weaponKey];
    if (hanging && !runtime.item.part) runtime.item.pose = { ...runtime.item.pose, ...hanging.pose };
    host.reshape(runtime);
  }
  const outline = (runtime: ItemRuntime) => {
    const footprint = runtime.footprint;
    if (!footprint) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const box = { minX: footprint.originX, maxX: footprint.originX + footprint.width, minY: footprint.originY, maxY: footprint.originY + footprint.height };
    if (!hangs(runtime)) return box;
    return { ...box, minY: footprint.body.minY, maxY: footprint.body.maxY };
  };
  const sizes = new Map(weapons.map((runtime) => {
    const box = outline(runtime);
    return [runtime, { width: box.maxX - box.minX, height: box.maxY - box.minY }];
  }));
  const sizeOf = (runtime: ItemRuntime) => sizes.get(runtime) ?? { width: 0, height: 0 };

  // Hanging weapons claim the bottom of a region first; then longest first, so the long ones get the outer columns.
  const placingOrder = [...weapons.filter(hangs), ...weapons.filter((runtime) => !hangs(runtime)).sort((a, b) => sizeOf(b).width - sizeOf(a).width)];

  /** Each weapon goes where it leaves the board most evenly filled. */
  const pack = (factor: number, center: number): Region[] | null => {
    const regions = regionsFor(center, logoSpace);
    const usedHeight = (region: Region) => region.shelves.reduce((sum, shelf) => sum + shelf.height, 0) + gap * (region.shelves.length + 1);
    for (const runtime of placingOrder) {
      const width = sizeOf(runtime).width * factor;
      const height = sizeOf(runtime).height * factor;
      let best: { region: Region; shelf: Shelf | null; fill: number } | null = null;
      for (const region of regions) {
        if (hangs(runtime) && region.bottom !== BOARD_HEIGHT) continue;
        // That side faces the middle from one outer column only. A weapon alone just takes the middle.
        const shown = shownSideFlip(runtime.item.weaponKey, runtime.item.part);
        if (shown !== undefined && weapons.length > 1 && region.kind !== (shown ? 'left' : 'right')) continue;
        const roomWide = region.right - region.left;
        const roomTall = region.bottom - region.top;
        const consider = (shelf: Shelf | null, grownHeight: number) => {
          if (grownHeight > roomTall) return;
          const fill = grownHeight / roomTall;
          if (!best || fill < best.fill) best = { region, shelf, fill };
        };
        for (const shelf of region.shelves) {
          if (shelf.width + width + gap * (shelf.weapons.length + 2) <= roomWide) consider(shelf, usedHeight(region) + Math.max(0, height - shelf.height));
        }
        if (width + gap * 2 <= roomWide) consider(null, usedHeight(region) + height + gap);
      }
      const chosen = best as { region: Region; shelf: Shelf | null; fill: number } | null;
      if (!chosen) return null;
      if (chosen.shelf) {
        chosen.shelf.weapons.push(runtime);
        chosen.shelf.width += width;
        chosen.shelf.height = Math.max(chosen.shelf.height, height);
      } else {
        chosen.region.shelves.push({ weapons: [runtime], width, height });
      }
    }
    return regions;
  };

  let chosen: { regions: Region[]; factor: number } | null = null;
  for (const center of logoSpace ? LOGO_CENTERS : OPEN_CENTERS) {
    const steps = Math.ceil((LAYOUT_SCALE.max - LAYOUT_SCALE.min) / SIZE_STEP);
    for (let step = 0; step <= steps; step += 1) {
      const size = Math.max(LAYOUT_SCALE.min, LAYOUT_SCALE.max - step * SIZE_STEP);
      if (chosen && size <= chosen.factor + MEANINGFUL_GROWTH) break;
      const found = pack(size, center);
      if (found) {
        chosen = { regions: found, factor: size };
        break;
      }
    }
  }
  // Too many to fit at the smallest size: they overlap, marked as conflicts, clear of any logo space.
  const regions = chosen?.regions ?? regionsFor(logoSpace ? LOGO_SPACE.width : 0, logoSpace);
  if (!chosen) {
    placingOrder.forEach((runtime, index) => {
      const shown = shownSideFlip(runtime.item.weaponKey, runtime.item.part);
      regions[shown === undefined ? index % 2 : Number(!shown)].shelves.push({ weapons: [runtime], width: 0, height: 0 });
    });
  }

  const factor = THREE.MathUtils.clamp(Math.floor(Math.min(chosen?.factor ?? LAYOUT_SCALE.min, LAYOUT_SCALE.max) * host.layoutSize() * 100) / 100, LAYOUT_SCALE.min, LAYOUT_SCALE.max);

  const towardsOf = (region: Region, index: number, count: number): 'left' | 'right' => {
    if (region.kind === 'left') return 'right';
    if (region.kind === 'right') return 'left';
    if (count > 1) return index < count / 2 ? 'right' : 'left';
    return region.kind === 'top' ? 'right' : 'left';
  };
  for (const region of regions) {
    for (const shelf of region.shelves) {
      shelf.weapons.forEach((runtime, index) => {
        runtime.item.scale = factor;
        runtime.item.flipped = flippedToFace(runtime, towardsOf(region, index, shelf.weapons.length));
        host.reshape(runtime);
      });
    }
  }

  for (const region of regions) {
    const measured = region.shelves.map((shelf) => {
      const boxes = shelf.weapons.map(outline);
      return { shelf, boxes, width: boxes.map((box) => box.maxX - box.minX), height: Math.max(...boxes.map((box) => box.maxY - box.minY)) };
    });
    // Heavy at the top on the left and at the bottom on the right, so the board balances across its diagonal.
    const heavyFirst = region.kind !== 'right' && region.kind !== 'top';
    measured.sort((a, b) => (a.shelf.weapons.some(hangs) ? 1 : 0) - (b.shelf.weapons.some(hangs) ? 1 : 0) || (heavyFirst ? b.height - a.height : a.height - b.height));
    const rows = spread(region.top, region.bottom, measured.map((entry) => entry.height));
    measured.forEach(({ shelf, boxes, width }, rowIndex) => {
      const across = shelf.weapons.length > 1 || region.kind === 'middle' || region.kind === 'top' || region.kind === 'bottom'
        ? spread(region.left, region.right, width)
        // Keeping to the outer edge leaves an uneven inner edge rather than a stack of centred bars.
        : [region.kind === 'left' ? region.left + gap + width[0] / 2 : region.right - gap - width[0] / 2];
      shelf.weapons.forEach((runtime, index) => {
        const box = boxes[index];
        const centerX = -BOARD_WIDTH / 2 + across[index];
        const centerY = BOARD_HEIGHT / 2 - rows[rowIndex];
        const x = Math.round((centerX - (box.minX + box.maxX) / 2) / cell) * cell;
        const y = hangs(runtime)
          ? Math.round((-BOARD_HEIGHT / 2 + gap - box.minY) / cell) * cell
          : Math.round((centerY - (box.minY + box.maxY) / 2) / cell) * cell;
        // Rounding to the grid can still bring two weapons a cell too close.
        const spot = host.problemAt(runtime.item.id, x, y) ? host.nearestFreeSpot(runtime.item.id, x, y, 4) ?? { x, y } : { x, y };
        runtime.item.x = spot.x;
        runtime.item.y = spot.y;
        runtime.root.visible = true;
        if (!runtime.root.parent) host.scene.add(runtime.root);
        host.applyTransform(runtime);
        host.rememberValid(runtime);
        host.appendItem(runtime.item);
      });
    });
  }
}
