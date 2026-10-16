// resolveRecipe rules that are easy to break: which stages draw from the paint
// RNG, which transforms apply, and where sticker levels land.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveRecipe } from '../../../src/compositor/resolve';
import { advancePaintkitStream, createPaintkitRandomState, resolveRange } from '../../../src/compositor/rng';
import { textureUvMatrix } from '../../../src/compositor/transforms';
import type { RecipeNode } from '../../../src/compositor/types';
import { close } from '../fixtures';

test('combine-stage UV fields are not applied', () => {
  const resolved = resolveRecipe({
    type: 'combine_multiply', rotation: [45, 45], translateU: [0.25, 0.25], translateV: [0.5, 0.5], scaleUV: [2, 2],
    nodes: [{ type: 'texture_lookup', texture: 'patterns/first' }, { type: 'texture_lookup', texture: 'patterns/second' }],
  }, '123');
  assert.equal(resolved.type, 'combine_multiply');
  assert.deepEqual([resolved.rotationDeg, resolved.translateU, resolved.translateV, resolved.scale], [0, 0, 0, 1]);
});

test('fixed flips consume no draw and use pre-rotation column signs', () => {
  const fixed = resolveRecipe({ type: 'texture_lookup', texture: 'patterns/fixed', flipU: [1, 1], rotation: [45, 45] }, '123');
  const unflipped = resolveRecipe({ type: 'texture_lookup', texture: 'patterns/plain', flipU: [0, 0], rotation: [45, 45] }, '123');
  assert.ok(fixed.type === 'texture_lookup' && unflipped.type === 'texture_lookup');
  assert.equal(fixed.flipU, true);
  assert.equal(fixed.rotationDeg, unflipped.rotationDeg);
  const elements = textureUvMatrix(45, 0, 0, 1, true, false).elements;
  close([elements[0], elements[1], elements[3], elements[4]], [-Math.SQRT1_2, -Math.SQRT1_2, -Math.SQRT1_2, Math.SQRT1_2], 'flipped UV matrix');
});

test('sticker levels stay on the stage output', () => {
  const resolved = resolveRecipe({
    type: 'apply_sticker', stickers: [{ base: 'patterns/sticker' }],
    adjustBlack: [0.1, 0.1], adjustOffset: [0.7, 0.7], adjustGamma: [1.5, 1.5],
    nodes: [{ type: 'texture_lookup', texture: 'patterns/base' }],
  }, '123');
  assert.equal(resolved.type, 'apply_sticker');
  close({ black: resolved.black, white: resolved.white, gamma: resolved.gamma }, { black: 0.1, white: 0.8, gamma: 1.5 }, 'sticker levels');
});

test('copy and transformless combine stages leave the seeded child placement alone', () => {
  const child: RecipeNode = { type: 'texture_lookup', texture: 'patterns/child', rotation: [0, 360], translateU: [0, 1] };
  const copied = resolveRecipe({ type: 'combine_multiply', rootCopy: true, nodes: [child] }, '123');
  assert.equal(copied.type, 'combine_multiply');
  assert.deepEqual(copied.nodes[0], resolveRecipe(child, '123'), 'a multi-root copy stage does not draw or toggle the stream');

  // Replay the combine stage's own three draws and stream advance; the child
  // texture must then draw translate, rotation and scale from that state.
  const seed = '3753779166464894300';
  const state = createPaintkitRandomState(seed);
  for (const integer of [0, 1, 1]) resolveRange(state.streams[state.current], undefined, integer);
  advancePaintkitStream(state);
  const rng = state.streams[state.current];
  const expected = {
    translateU: resolveRange(rng, [0, 1], 0),
    translateV: resolveRange(rng, [0, 1], 0),
    rotationDeg: resolveRange(rng, [0, 360], 0),
    scale: resolveRange(rng, [0.4, 0.5], 1),
  };
  const resolved = resolveRecipe({ type: 'combine_multiply', nodes: [{
    type: 'texture_lookup', texture: 'patterns/alpha-control', rotation: [0, 360], translateU: [0, 1], translateV: [0, 1], scaleUV: [0.4, 0.5],
  }] }, seed);
  assert.equal(resolved.type, 'combine_multiply');
  const resolvedChild = resolved.nodes[0];
  assert.equal(resolvedChild.type, 'texture_lookup');
  const { translateU, translateV, rotationDeg, scale } = resolvedChild;
  assert.deepEqual({ translateU, translateV, rotationDeg, scale }, expected);
});
