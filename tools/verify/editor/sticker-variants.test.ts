// Sticker variant edits: weights, artwork, equal weights, adding and removing
// one variant. Each edit
// must touch every occurrence of the logical sticker, refuse unsafe input, and
// leave the snapshot it was given untouched.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  addStickerVariant,
  equalizeStickerVariantWeights,
  removeStickerVariant,
  setStickerVariantBase,
  setStickerVariantWeight,
} from '../../../src/editor/mutations';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';

const sticker = ['operation', 'operation_node', '0', 'stage', 'apply_sticker'];
const target = { stagePaths: [sticker] };

function kit(): ProtoDefKitMessages {
  return {
    definition: { header: { defindex: 1, variables: [{ name: '$shared_weight', value: '3' }] } },
    operation: {
      header: { defindex: 2 },
      operation_node: [
        { stage: { apply_sticker: {
          sticker: [
            { base: { string: 'stickers/a' }, weight: { float: 1 } },
            { base: { string: 'stickers/b' }, weight: { variable: '$shared_weight' } },
          ],
        } } },
      ],
    },
  };
}

function variants(messages: ProtoDefKitMessages): unknown {
  const nodes = messages.operation.operation_node as { stage: { apply_sticker: { sticker: unknown } } }[];
  return nodes[0].stage.apply_sticker.sticker;
}

test('a literal weight is set on one variant and leaves the others alone', () => {
  const before = kit();
  const snapshot = structuredClone(before);
  const next = setStickerVariantWeight(before, target, 0, 2.5);
  assert.deepEqual(variants(next), [
    { base: { string: 'stickers/a' }, weight: { float: 2.5 } },
    { base: { string: 'stickers/b' }, weight: { variable: '$shared_weight' } },
  ]);
  assert.deepEqual(before, snapshot);
});

test('a variable weight is forked to a literal on that variant only', () => {
  const before = kit();
  const next = setStickerVariantWeight(before, target, 1, 0);
  assert.deepEqual(variants(next), [
    { base: { string: 'stickers/a' }, weight: { float: 1 } },
    { base: { string: 'stickers/b' }, weight: { float: 0 } },
  ]);
  assert.deepEqual(next.definition.header, before.definition.header, 'the shared header variable stays as authored');
});

test('weights must be finite and not negative', () => {
  const before = kit();
  assert.throws(() => setStickerVariantWeight(before, target, 0, -1), TypeError);
  assert.throws(() => setStickerVariantWeight(before, target, 0, Number.NaN), TypeError);
  assert.throws(() => setStickerVariantWeight(before, target, 0, Number.POSITIVE_INFINITY), TypeError);
});

test('a weight change that would leave every variant at 0 is refused', () => {
  const zeroed = setStickerVariantWeight(kit(), target, 1, 0);
  assert.throws(() => setStickerVariantWeight(zeroed, target, 0, 0), /weight above 0/);
});

test('a missing variant index is refused', () => {
  assert.throws(() => setStickerVariantWeight(kit(), target, 2, 1), /does not exist/);
  assert.throws(() => removeStickerVariant(kit(), target, -1), /does not exist/);
});

test('a variant is appended with weight 1 and no spec', () => {
  const before = kit();
  const snapshot = structuredClone(before);
  const next = addStickerVariant(before, target, '  stickers/c  ');
  assert.deepEqual(variants(next), [
    { base: { string: 'stickers/a' }, weight: { float: 1 } },
    { base: { string: 'stickers/b' }, weight: { variable: '$shared_weight' } },
    { base: { string: 'stickers/c' }, weight: { float: 1 } },
  ]);
  assert.deepEqual(before, snapshot);
  assert.throws(() => addStickerVariant(before, target, '   '), TypeError);
});

test('a variant is removed, and the last one cannot be', () => {
  const before = kit();
  const snapshot = structuredClone(before);
  const next = removeStickerVariant(before, target, 0);
  assert.deepEqual(variants(next), [
    { base: { string: 'stickers/b' }, weight: { variable: '$shared_weight' } },
  ]);
  assert.deepEqual(before, snapshot);
  assert.throws(() => removeStickerVariant(next, target, 0), /at least one variant/);
});

test('removing a variant is refused when the remaining weights would all be 0', () => {
  const zeroed = setStickerVariantWeight(kit(), target, 1, 0);
  assert.throws(() => removeStickerVariant(zeroed, target, 0), /weight 0/);
});

test('occurrences that list different variants are refused rather than guessed at', () => {
  const twoOccurrences: ProtoDefKitMessages = {
    definition: { header: { defindex: 1 } },
    operation: {
      header: { defindex: 2 },
      operation_node: [
        { stage: { apply_sticker: { sticker: [{ base: { string: 'stickers/a' } }, { base: { string: 'stickers/b' } }] } } },
        { stage: { apply_sticker: { sticker: { base: { string: 'stickers/a' } } } } },
      ],
    },
  };
  const both = {
    stagePaths: [
      ['operation', 'operation_node', '0', 'stage', 'apply_sticker'],
      ['operation', 'operation_node', '1', 'stage', 'apply_sticker'],
    ],
  };
  assert.throws(() => addStickerVariant(twoOccurrences, both, 'stickers/c'), /different variants/);
  assert.throws(() => setStickerVariantWeight(twoOccurrences, both, 0, 2), /different variants/);
});

test('one variant is repointed at literal artwork and keeps its weight, the others are untouched', () => {
  const before = kit();
  const snapshot = structuredClone(before);
  const next = setStickerVariantBase(before, target, 1, '  stickers/c  ');
  assert.deepEqual(variants(next), [
    { base: { string: 'stickers/a' }, weight: { float: 1 } },
    { base: { string: 'stickers/c' }, weight: { variable: '$shared_weight' } },
  ]);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(next.definition.header, before.definition.header, 'the shared header variable stays as authored');
});

test('a variant base is repointed on every occurrence of the sticker', () => {
  const twice: ProtoDefKitMessages = {
    definition: { header: { defindex: 1 } },
    operation: {
      header: { defindex: 2 },
      operation_node: [
        { stage: { apply_sticker: { sticker: [{ base: { string: 'stickers/a' } }, { base: { string: 'stickers/b' } }] } } },
        { stage: { apply_sticker: { sticker: [{ base: { string: 'stickers/a' } }, { base: { string: 'stickers/b' } }] } } },
      ],
    },
  };
  const both = {
    stagePaths: [
      ['operation', 'operation_node', '0', 'stage', 'apply_sticker'],
      ['operation', 'operation_node', '1', 'stage', 'apply_sticker'],
    ],
  };
  const next = setStickerVariantBase(twice, both, 0, 'stickers/c');
  for (const node of next.operation.operation_node as { stage: { apply_sticker: { sticker: unknown } } }[]) {
    assert.deepEqual(node.stage.apply_sticker.sticker, [
      { base: { string: 'stickers/c' } },
      { base: { string: 'stickers/b' } },
    ]);
  }
});

test('a variant base needs a reference, an existing variant, and one shape across occurrences', () => {
  const before = kit();
  assert.throws(() => setStickerVariantBase(before, target, 0, '   '), TypeError);
  assert.throws(() => setStickerVariantBase(before, target, 2, 'stickers/c'), /does not exist/);
  assert.throws(() => setStickerVariantBase(before, target, -1, 'stickers/c'), /does not exist/);
  assert.throws(() => setStickerVariantBase(before, { stagePaths: [] }, 0, 'stickers/c'), /No authored sticker stage/);
});

test('every variant weight is set to 1 in one edit, including a variable weight', () => {
  const before = kit();
  const snapshot = structuredClone(before);
  const next = equalizeStickerVariantWeights(before, target);
  assert.deepEqual(variants(next), [
    { base: { string: 'stickers/a' }, weight: { float: 1 } },
    { base: { string: 'stickers/b' }, weight: { float: 1 } },
  ]);
  assert.deepEqual(before, snapshot);
  assert.deepEqual(next.definition.header, before.definition.header, 'the shared header variable stays as authored');
});

test('equalizing weights refuses an empty target and occurrences that list different variants', () => {
  assert.throws(() => equalizeStickerVariantWeights(kit(), { stagePaths: [] }), /No authored sticker stage/);
  const mismatched: ProtoDefKitMessages = {
    definition: { header: { defindex: 1 } },
    operation: {
      header: { defindex: 2 },
      operation_node: [
        { stage: { apply_sticker: { sticker: [{ base: { string: 'stickers/a' } }, { base: { string: 'stickers/b' } }] } } },
        { stage: { apply_sticker: { sticker: { base: { string: 'stickers/a' } } } } },
      ],
    },
  };
  const both = {
    stagePaths: [
      ['operation', 'operation_node', '0', 'stage', 'apply_sticker'],
      ['operation', 'operation_node', '1', 'stage', 'apply_sticker'],
    ],
  };
  assert.throws(() => equalizeStickerVariantWeights(mismatched, both), /different variants/);
  assert.throws(() => setStickerVariantBase(mismatched, both, 0, 'stickers/c'), /different variants/);
});

// Weapon slots and wear can override a variable weight. Validation must count
// the weights the compositor will actually read, not the header defaults.
function overriddenKit(): ProtoDefKitMessages {
  return {
    definition: { header: { defindex: 1, variables: [{ name: '$w', value: '1' }] } },
    operation: {
      header: { defindex: 2 },
      operation_node: [
        { stage: { apply_sticker: {
          sticker: [
            { base: { string: 'stickers/a' }, weight: { float: 1 } },
            { base: { string: 'stickers/b' }, weight: { variable: '$w' } },
          ],
        } } },
      ],
    },
  };
}

const resolvedZeroForB = { stagePaths: [sticker], effectiveWeights: [1, 0] };

test('a weight change is refused when the resolved weights would all be 0', () => {
  // The header default for $w is 1, but the weapon slot resolves it to 0.
  assert.throws(() => setStickerVariantWeight(overriddenKit(), resolvedZeroForB, 0, 0), /weight above 0/);
});

test('a removal is refused when the resolved remaining weights would all be 0', () => {
  assert.throws(() => removeStickerVariant(overriddenKit(), resolvedZeroForB, 0), /weight 0/);
});

test('resolved weights allow a change that keeps some variant above 0', () => {
  const next = setStickerVariantWeight(overriddenKit(), resolvedZeroForB, 0, 2);
  assert.deepEqual(variants(next), [
    { base: { string: 'stickers/a' }, weight: { float: 2 } },
    { base: { string: 'stickers/b' }, weight: { variable: '$w' } },
  ]);
  const removed = removeStickerVariant(overriddenKit(), { stagePaths: [sticker], effectiveWeights: [1, 0] }, 1);
  assert.deepEqual(variants(removed), [{ base: { string: 'stickers/a' }, weight: { float: 1 } }]);
});

test('resolved weights must match the variant count', () => {
  assert.throws(
    () => setStickerVariantWeight(overriddenKit(), { stagePaths: [sticker], effectiveWeights: [1] }, 0, 2),
    /do not match/,
  );
});
