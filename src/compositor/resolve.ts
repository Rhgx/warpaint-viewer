// Pre-pass that walks the recipe tree and resolves every seeded [min,max] range
// into a concrete value, so GL evaluation is a pure function of the resolved
// tree. Traversal is depth-first PRE-ORDER: a node's own ranges are drawn first
// (fixed field order: adjustBlack, adjustOffset, adjustGamma, rotation,
// translateU, translateV, scaleUV), then its children in order. flipU/flipV are
// plain booleans in the data and consume no draws. Select is a leaf and consumes
// none. See rng.ts for the fidelity caveat about the generator itself.

import type { Rng } from './rng';
import { mulberry32, resolveRange } from './rng';
import type { RecipeNode, StageTransform } from './types';

export interface ResolvedTransform {
  black: number;
  white: number;
  gamma: number;
  rotationDeg: number;
  translateU: number;
  translateV: number;
  scale: number;
  flipU: boolean;
  flipV: boolean;
}

export interface ResolvedTexture extends ResolvedTransform {
  type: 'texture_lookup';
  texture: string;
}

export interface ResolvedCombine extends ResolvedTransform {
  type: 'combine_multiply' | 'combine_add' | 'combine_lerp';
  nodes: ResolvedNode[];
}

export interface ResolvedSelect {
  type: 'select';
  groups: string;
  select: number[];
}

export interface ResolvedSticker {
  type: 'apply_sticker';
  base: string;
  spec?: string;
  destTl: [number, number];
  destTr: [number, number];
  destBl: [number, number];
  black: number;
  white: number;
  gamma: number;
  nodes: ResolvedNode[];
}

export type ResolvedNode = ResolvedTexture | ResolvedCombine | ResolvedSelect | ResolvedSticker;

// Identity check used by the compositor to skip no-op output passes.
export function isIdentityTransform(t: ResolvedTransform): boolean {
  return (
    t.black === 0 &&
    t.white === 1 &&
    t.gamma === 1 &&
    t.rotationDeg === 0 &&
    t.translateU === 0 &&
    t.translateV === 0 &&
    t.scale === 1 &&
    !t.flipU &&
    !t.flipV
  );
}

function resolveTransform(node: StageTransform, rng: Rng): ResolvedTransform {
  // Fixed draw order; keep in sync with the header comment.
  const black = resolveRange(rng, node.adjustBlack, 0);
  const white = resolveRange(rng, node.adjustOffset, 1);
  const gamma = resolveRange(rng, node.adjustGamma, 1);
  const rotationDeg = resolveRange(rng, node.rotation, 0);
  const translateU = resolveRange(rng, node.translateU, 0);
  const translateV = resolveRange(rng, node.translateV, 0);
  const scale = resolveRange(rng, node.scaleUV, 1);
  return {
    black,
    white,
    gamma,
    rotationDeg,
    translateU,
    translateV,
    scale: scale === 0 ? 1 : scale,
    flipU: node.flipU === true,
    flipV: node.flipV === true,
  };
}

function resolveNode(node: RecipeNode, rng: Rng): ResolvedNode {
  switch (node.type) {
    case 'texture_lookup':
      return {
        type: 'texture_lookup',
        texture: node.texture,
        ...resolveTransform(node, rng),
      };
    case 'combine_multiply':
    case 'combine_add':
    case 'combine_lerp': {
      const transform = resolveTransform(node, rng);
      return {
        type: node.type,
        ...transform,
        nodes: node.nodes.map((n) => resolveNode(n, rng)),
      };
    }
    case 'select':
      return {
        type: 'select',
        groups: node.groups,
        // atoi() semantics for the occasional string value with trailing junk
        // (see SelectNode comment); non-parsable entries become 0 (= unused).
        select: (node.select ?? []).map((v) => {
          const n = typeof v === 'number' ? v : parseInt(v, 10);
          return Number.isFinite(n) ? n : 0;
        }),
      };
    case 'apply_sticker': {
      const black = resolveRange(rng, node.adjustBlack, 0);
      const white = resolveRange(rng, node.adjustOffset, 1);
      const gamma = resolveRange(rng, node.adjustGamma, 1);
      // Pick a sticker weighted by weight, consuming one draw.
      const stickers = node.stickers ?? [];
      const total = stickers.reduce((s, x) => s + (x.weight ?? 1), 0) || 1;
      let pick = rng() * total;
      let chosen = stickers[0];
      for (const s of stickers) {
        pick -= s.weight ?? 1;
        if (pick <= 0) {
          chosen = s;
          break;
        }
      }
      return {
        type: 'apply_sticker',
        base: chosen ? chosen.base : '',
        spec: chosen ? chosen.spec : undefined,
        // Defaults in v-down composite space (image top at v=0), matching the
        // game's UV convention; real data always provides all three corners.
        destTl: node.destTl ?? [0, 0],
        destTr: node.destTr ?? [1, 0],
        destBl: node.destBl ?? [0, 1],
        black,
        white,
        gamma,
        nodes: node.nodes.map((n) => resolveNode(n, rng)),
      };
    }
  }
}

export function resolveRecipe(root: RecipeNode, seed: number): ResolvedNode {
  const rng = mulberry32(seed >>> 0);
  return resolveNode(root, rng);
}
