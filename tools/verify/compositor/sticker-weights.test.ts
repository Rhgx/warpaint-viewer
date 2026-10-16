// A weighted sticker pick must follow its weights across seeds, and a variant
// weighted 0 must never be drawn while another variant has weight above 0.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveRecipe } from '../../../src/compositor/resolve';
import type { RecipeNode } from '../../../src/compositor/types';

const SEED_COUNT = 4000;

function stickerRecipe(stickers: { base: string; weight?: number }[]): RecipeNode {
  return {
    type: 'apply_sticker',
    stickers,
    destTl: [0, 0],
    destTr: [1, 0],
    destBl: [0, 1],
    nodes: [{ type: 'texture_lookup', texture: 'patterns/surface' }],
  };
}

// Paint seeds are full 64-bit values whose bits feed the two RNG streams, so
// spread the test seeds across that range instead of using 1, 2, 3...
function pickCounts(recipe: RecipeNode): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 1n; index <= BigInt(SEED_COUNT); index += 1n) {
    const seed = String((index * 0x9e3779b97f4a7c15n) % (1n << 64n));
    const resolved = resolveRecipe(recipe, seed);
    if (resolved.type !== 'apply_sticker') throw new Error('Expected an apply_sticker node.');
    counts.set(resolved.base, (counts.get(resolved.base) ?? 0) + 1);
  }
  return counts;
}

test('a weight of 1 against 3 is picked about 25% and 75% of the time', () => {
  const counts = pickCounts(stickerRecipe([{ base: 'stickers/light', weight: 1 }, { base: 'stickers/heavy', weight: 3 }]));
  const light = (counts.get('stickers/light') ?? 0) / SEED_COUNT;
  const heavy = (counts.get('stickers/heavy') ?? 0) / SEED_COUNT;
  assert.equal(light + heavy, 1);
  assert.ok(Math.abs(light - 0.25) < 0.03, `light picked ${(light * 100).toFixed(1)}% of seeds`);
  assert.ok(Math.abs(heavy - 0.75) < 0.03, `heavy picked ${(heavy * 100).toFixed(1)}% of seeds`);
});

test('a variant weighted 0 is never picked while another variant has weight above 0', () => {
  const counts = pickCounts(stickerRecipe([{ base: 'stickers/unused', weight: 0 }, { base: 'stickers/live', weight: 1 }]));
  assert.equal(counts.get('stickers/unused') ?? 0, 0);
  assert.equal(counts.get('stickers/live'), SEED_COUNT);
});
