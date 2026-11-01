// Resolve seeded values exactly in the order used by TF2's compositor stages.
// A stage consumes several values from the current CUniformRandomStream, then
// advances to the other stream before its children are visited depth-first.

import type { PaintkitRandomState, UniformRandomStream } from './rng';
import { advancePaintkitStream, createPaintkitRandomState, resolveRange } from './rng';
import type { PaintSeed, RecipeNode, StageTransform } from './types';

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

export const IDENTITY_TRANSFORM: ResolvedTransform = {
  black: 0, white: 1, gamma: 1,
  rotationDeg: 0, translateU: 0, translateV: 0, scale: 1,
  flipU: false, flipV: false,
};

// A select node is active when any of its group ids is non-zero; zero marks an unused slot.
export function selectHasActiveGroup(values: readonly (number | string)[] | undefined): boolean {
  return (values ?? []).some((value) => {
    const parsed = typeof value === 'number' ? value : parseInt(value, 10);
    return Number.isFinite(parsed) && parsed !== 0;
  });
}

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

// Photoshop levels: black, then white = black + offset, then gamma. The draw order is part
// of the seeded output, so every stage resolves levels here.
function resolveLevels(node: StageTransform, rng: UniformRandomStream): { black: number; white: number; gamma: number } {
  const black = resolveRange(rng, node.adjustBlack, 0);
  const offset = resolveRange(rng, node.adjustOffset, 1);
  const gamma = resolveRange(rng, node.adjustGamma, 1);
  return { black, white: black + offset, gamma };
}

function resolveTextureTransform(node: StageTransform, rng: UniformRandomStream): ResolvedTransform {
  // TextureStage::ComputeRandomValuesThis: optional flips first, followed by UV
  // placement, then Photoshop levels.
  const resolveFlip = (range: StageTransform['flipU']): boolean => {
    if (typeof range === 'boolean') return range ? rng.randomInt(0, 1) !== 0 : false;
    const [low, high] = range ?? [0, 0];
    return rng.randomInt(Math.trunc(low), Math.trunc(high)) !== 0;
  };
  const flipU = resolveFlip(node.flipU);
  const flipV = resolveFlip(node.flipV);
  const translateU = resolveRange(rng, node.translateU, 0);
  const translateV = resolveRange(rng, node.translateV, 0);
  const rotationDeg = resolveRange(rng, node.rotation, 0);
  const scale = resolveRange(rng, node.scaleUV, 1);
  const levels = resolveLevels(node, rng);
  return {
    ...levels,
    rotationDeg,
    translateU,
    translateV,
    scale: scale === 0 ? 1 : scale,
    flipU,
    flipV,
  };
}

function resolveCombineTransform(node: StageTransform, rng: UniformRandomStream): ResolvedTransform {
  // CTCCombineStage parses UV fields but only resolves its three level ranges.
  // Its output record always carries an identity texture matrix.
  return { ...IDENTITY_TRANSFORM, ...resolveLevels(node, rng) };
}

function resolveNode(node: RecipeNode, state: PaintkitRandomState): ResolvedNode {
  const rng = state.streams[state.current];
  switch (node.type) {
    case 'texture_lookup': {
      const transform = resolveTextureTransform(node, rng);
      advancePaintkitStream(state);
      return {
        type: 'texture_lookup',
        texture: node.texture,
        ...transform,
      };
    }
    case 'combine_multiply':
    case 'combine_add':
    case 'combine_lerp': {
      if (node.rootCopy) {
        return {
          type: node.type,
          ...IDENTITY_TRANSFORM,
          nodes: node.nodes.map((n) => resolveNode(n, state)),
        };
      }
      const transform = resolveCombineTransform(node, rng);
      advancePaintkitStream(state);
      return {
        type: node.type,
        ...transform,
        nodes: node.nodes.map((n) => resolveNode(n, state)),
      };
    }
    case 'select':
      return {
        type: 'select',
        groups: node.groups,
        // atoi() semantics for junk-suffixed strings; unparsable entries become 0 (unused).
        select: (node.select ?? []).map((v) => {
          const n = typeof v === 'number' ? v : parseInt(v, 10);
          return Number.isFinite(n) ? n : 0;
        }),
      };
    case 'apply_sticker': {
      // Pick a sticker weighted by weight, consuming one draw.
      const stickers = node.stickers ?? [];
      const total = stickers.reduce((s, x) => s + (x.weight ?? 1), 0) || 1;
      let pick = rng.randomFloat(0, total);
      let chosen = stickers[0];
      for (const s of stickers) {
        const weight = s.weight ?? 1;
        if (pick < weight) {
          chosen = s;
          break;
        }
        pick -= weight;
      }
      const levels = resolveLevels(node, rng);
      advancePaintkitStream(state);
      return {
        type: 'apply_sticker',
        base: chosen ? chosen.base : '',
        spec: chosen ? chosen.spec : undefined,
        // Defaults are in v-down composite space (image top at v=0), as the game's UVs are.
        destTl: node.destTl ?? [0, 0],
        destTr: node.destTr ?? [1, 0],
        destBl: node.destBl ?? [0, 1],
        ...levels,
        nodes: node.nodes.map((n) => resolveNode(n, state)),
      };
    }
  }
}

export function resolveRecipe(root: RecipeNode, seed: PaintSeed): ResolvedNode {
  return resolveNode(root, createPaintkitRandomState(seed));
}
