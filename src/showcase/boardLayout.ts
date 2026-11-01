import * as THREE from 'three';

import { BOARD_HEIGHT, BOARD_WIDTH, GRID_CELL } from './boardMetrics';
import type { LayoutPacking } from './layouts';
import { HANGING_PARTS } from './poseRigs';
import type { FitProblem, GridSize, ItemRuntime, ShowcaseItem } from './showcaseTypes';
import { FACES_RIGHT, restingRoll } from './weaponGeometry';

// Lays weapons out on the board: rows or columns, the largest size that fits, and each weapon placed on the grid.
/** Sizes a layout may give its weapons: the size slider's top, and small enough for a full board. */
const LAYOUT_SCALE = { min: 0.25, max: 1.5 };

/** What the layout reads and changes on the board; the board builds it once and its accessors read live state. */
export interface BoardLayoutHost {
  grid(): GridSize;
  spacing(): number;
  keepApart(): boolean;
  readonly scene: THREE.Scene;
  appendItem(item: ShowcaseItem): void;
  reshape(runtime: ItemRuntime): void;
  problemAt(id: string, x: number, y: number): FitProblem;
  nearestFreeSpot(id: string, x: number, y: number, maxRing?: number): { x: number; y: number } | null;
  applyTransform(runtime: ItemRuntime): void;
  rememberValid(runtime: ItemRuntime): void;
}

export function arrange(host: BoardLayoutHost, rows: ItemRuntime[][], pack: LayoutPacking | undefined, inward: boolean, upright: boolean): void {
  const cell = GRID_CELL[host.grid()];
  // Space around and between weapons: the spacing rule plus a cell, so
  // rounding positions to the grid never brings two too close.
  const gap = (host.keepApart() ? host.spacing() + 1 : 1) * cell;
  const hangs = (runtime: ItemRuntime) => runtime.item.weaponKey in HANGING_PARTS && !runtime.item.part;
  /** Groups run across the board (rows) or down it (columns, `vertical`). */
  type Grouping = { groups: ItemRuntime[][]; vertical: boolean };
  type Box = { minX: number; maxX: number; minY: number; maxY: number };

  // Measured unflipped at 100%; flips mirror these outlines, so they serve every candidate.
  for (const runtime of rows.flat()) {
    Object.assign(runtime.item, { roll: restingRoll(runtime.item.weaponKey, runtime.item.part), tilt: 0, turn: 0, scale: 1, flipped: false });
    const hanging = HANGING_PARTS[runtime.item.weaponKey];
    if (hanging && !runtime.item.part) runtime.item.pose = { ...runtime.item.pose, ...hanging.pose };
    host.reshape(runtime);
  }
  const mirror = (box: Box, flip: boolean): Box => (flip ? { ...box, minX: -box.maxX, maxX: -box.minX } : box);
  // Outlines for a facing, mirrored when it differs from the one measured.
  const full = (runtime: ItemRuntime, flip: boolean): Box => {
    const footprint = runtime.footprint;
    if (!footprint) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const box = { minX: footprint.originX, maxX: footprint.originX + footprint.width, minY: footprint.originY, maxY: footprint.originY + footprint.height };
    return mirror(box, flip !== runtime.item.flipped);
  };
  const body = (runtime: ItemRuntime, flip: boolean): Box => (runtime.footprint ? mirror(runtime.footprint.body, flip !== runtime.item.flipped) : full(runtime, flip));
  // Muzzles point left unflipped. Facing inward, weapons left of the middle turn to face right,
  // and FACES_RIGHT weapons right of it turn to face left.
  let turnInward = inward;
  const flipOf = ({ groups, vertical }: Grouping, groupIndex: number, index: number) => {
    const { item } = groups[groupIndex][index];
    // A weapon resting upright would turn its back to the viewer.
    if (!turnInward || restingRoll(item.weaponKey, item.part)) return false;
    const [position, count] = vertical ? [groupIndex, groups.length] : [index, groups[groupIndex].length];
    const middle = (count - 1) / 2;
    return FACES_RIGHT.has(item.weaponKey) && !item.part ? position > middle + 0.01 : position < middle - 0.01;
  };
  // Height leaves out a hanging piece, which runs off the bottom. Width keeps it, unless the
  // weapon ends the bottom row with the piece on the outer side.
  const space = (grouping: Grouping, groupIndex: number, index: number): Box => {
    const runtime = grouping.groups[groupIndex][index];
    const flip = flipOf(grouping, groupIndex, index);
    const outline = full(runtime, flip);
    if (!hangs(runtime)) return outline;
    const own = body(runtime, flip);
    const box = { ...outline, minY: own.minY, maxY: own.maxY };
    const group = grouping.groups[groupIndex];
    if (!grouping.vertical && groupIndex === grouping.groups.length - 1) {
      if (index === 0) box.minX = Math.max(box.minX, own.minX);
      if (index === group.length - 1) box.maxX = Math.min(box.maxX, own.maxX);
    }
    return box;
  };
  const along = (box: Box, vertical: boolean) => (vertical ? box.maxY - box.minY : box.maxX - box.minX);
  // How much the weapons can grow before a group runs out of length or the groups out of room.
  const fit = (grouping: Grouping) => {
    const { groups, vertical } = grouping;
    const length = vertical ? BOARD_HEIGHT : BOARD_WIDTH;
    const breadth = vertical ? BOARD_WIDTH : BOARD_HEIGHT;
    let byLength = Infinity;
    let thickness = 0;
    groups.forEach((group, groupIndex) => {
      const boxes = group.map((_, index) => space(grouping, groupIndex, index));
      byLength = Math.min(byLength, (length - gap * (group.length + 1)) / Math.max(1, boxes.reduce((sum, box) => sum + along(box, vertical), 0)));
      thickness += Math.max(...boxes.map((box) => along(box, !vertical)));
    });
    return Math.min(byLength, (breadth - gap * (groups.length + 1)) / Math.max(1, thickness));
  };
  // Weapons with a hanging piece go along the bottom so it can run off the edge.
  const sinkHanging = (groups: ItemRuntime[][]): ItemRuntime[][] => {
    if (!groups.some((group) => group.some(hangs))) return groups;
    if (pack) {
      const rest = groups.map((group) => group.filter((runtime) => !hangs(runtime)));
      const bottom = [...rest.pop() ?? [], ...groups.flat().filter(hangs)];
      return [...rest, bottom].filter((group) => group.length > 0);
    }
    // A fixed layout keeps its rows together, such as a RED and BLU pair.
    return [...groups.filter((group) => !group.some(hangs)), ...groups.filter((group) => group.some(hangs))];
  };

  const search = (): { grouping: Grouping; score: number } => {
    let best: Grouping = { groups: sinkHanging(rows), vertical: false };
    let bestFit = pack ? 0 : fit(best);
    if (pack) {
      const all = rows.flat();
      // Columns would hang a piece over the weapon below, so a board with one sticks to rows.
      for (const vertical of all.some(hangs) ? [false] : [false, true]) {
        const size = (runtime: ItemRuntime, alongGroup: boolean) => along(full(runtime, false), alongGroup === vertical);
        // Sorted by size so each group holds similar sizes; either way cut into runs of about equal length.
        const sorted = pack === 'size' ? [...all].sort((a, b) => size(b, false) - size(a, false)) : all;
        const total = sorted.reduce((sum, runtime) => sum + size(runtime, true), 0);
        for (let count = 1; count <= Math.min(6, sorted.length); count += 1) {
          const groups: ItemRuntime[][] = [[]];
          let length = 0;
          for (const runtime of sorted) {
            const extent = size(runtime, true);
            if (groups.length < count && groups[groups.length - 1].length && length + extent / 2 > (total * groups.length) / count) groups.push([]);
            groups[groups.length - 1].push(runtime);
            length += extent;
          }
          const candidate = { groups: vertical ? groups : sinkHanging(groups), vertical };
          const candidateFit = fit(candidate);
          if (candidateFit > bestFit) {
            best = candidate;
            bestFit = candidateFit;
          }
        }
      }
    }
    return { grouping: best, score: bestFit };
  };
  // Weapons already resting upright keep their roll either way.
  const setRoll = (standing: boolean) => {
    for (const runtime of rows.flat()) {
      const rest = restingRoll(runtime.item.weaponKey, runtime.item.part);
      runtime.item.roll = standing && !rest ? -90 : rest;
      host.reshape(runtime);
    }
  };
  let { grouping: best } = search();
  if (upright && !rows.flat().some(hangs)) {
    // Standing upright, tips up like a weapon rack. Turning round would only
    // show the other side there, so nothing faces inward.
    const lying = fit(best);
    setRoll(true);
    turnInward = false;
    const standing = search();
    if (Math.min(standing.score, LAYOUT_SCALE.max) > Math.min(lying, LAYOUT_SCALE.max)) best = standing.grouping;
    else {
      setRoll(false);
      turnInward = inward;
    }
  }
  const factor = THREE.MathUtils.clamp(Math.floor(Math.min(fit(best), LAYOUT_SCALE.max) * 100) / 100, LAYOUT_SCALE.min, LAYOUT_SCALE.max);
  const { groups, vertical } = best;
  // Weapons whose hanging piece runs straight off a side edge, by that edge.
  const sideways = new Map<ItemRuntime, 'left' | 'right'>();
  groups.forEach((group, groupIndex) => group.forEach((runtime, index) => {
    runtime.item.scale = factor;
    runtime.item.flipped = flipOf(best, groupIndex, index);
    host.reshape(runtime);
    const hanging = HANGING_PARTS[runtime.item.weaponKey];
    if (!hanging || runtime.item.part || vertical || groupIndex !== groups.length - 1) return;
    const outline = full(runtime, runtime.item.flipped);
    const own = body(runtime, runtime.item.flipped);
    const side = outline.maxX - own.maxX > own.minX - outline.minX ? 'right' : 'left';
    if ((side === 'left' && index === 0) || (side === 'right' && index === group.length - 1)) {
      runtime.item.pose = { ...runtime.item.pose, ...hanging.sidePose };
      host.reshape(runtime);
      sideways.set(runtime, side);
    }
  }));

  // Measured again at the final size and facing.
  const boxes = groups.map((group, groupIndex) => group.map((_, index) => space(best, groupIndex, index)));
  const length = vertical ? BOARD_HEIGHT : BOARD_WIDTH;
  const breadth = vertical ? BOARD_WIDTH : BOARD_HEIGHT;
  const thickness = boxes.map((group) => Math.max(...group.map((box) => along(box, !vertical))));
  const freeAcross = Math.max(0, breadth - thickness.reduce((sum, value) => sum + value, 0)) / (groups.length + 1);
  // Rows fill from the top, columns from the left; positions run from the board's corner.
  let groupStart = freeAcross;
  groups.forEach((group, groupIndex) => {
    const groupCenter = groupStart + thickness[groupIndex] / 2;
    groupStart += thickness[groupIndex] + freeAcross;
    const freeAlong = Math.max(0, length - boxes[groupIndex].reduce((sum, box) => sum + along(box, vertical), 0)) / (group.length + 1);
    let itemStart = freeAlong;
    group.forEach((runtime, index) => {
      const box = boxes[groupIndex][index];
      const itemCenter = itemStart + along(box, vertical) / 2;
      itemStart += along(box, vertical) + freeAlong;
      const centerX = -BOARD_WIDTH / 2 + (vertical ? groupCenter : itemCenter);
      const centerY = BOARD_HEIGHT / 2 - (vertical ? itemCenter : groupCenter);
      // A hanging piece's weapon sits against the edge the piece runs off.
      const side = sideways.get(runtime);
      const x = side === 'right' ? Math.floor((BOARD_WIDTH / 2 - gap - box.maxX) / cell) * cell
        : side === 'left' ? Math.ceil((-BOARD_WIDTH / 2 + gap - box.minX) / cell) * cell
          : Math.round((centerX - (box.minX + box.maxX) / 2) / cell) * cell;
      const y = hangs(runtime) && !side && !vertical && groupIndex === groups.length - 1
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
