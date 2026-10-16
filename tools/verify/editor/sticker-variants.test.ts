// Sticker variant edits: weights, artwork, equal weights, adding and removing
// one variant. Each edit must touch every occurrence of the logical sticker,
// refuse unsafe input, and leave the snapshot it was given untouched.

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
import { dig } from '../fixtures';

const stagePath = (index: number) => ['operation', 'operation_node', `${index}`, 'stage', 'apply_sticker'];
const target = { stagePaths: [stagePath(0)] };
const both = { stagePaths: [stagePath(0), stagePath(1)] };
const a = { base: { string: 'stickers/a' }, weight: { float: 1 } };
const b = { base: { string: 'stickers/b' }, weight: { variable: '$shared_weight' } };

function kit(): ProtoDefKitMessages {
  return structuredClone({
    definition: { header: { defindex: 1, variables: [{ name: '$shared_weight', value: '3' }] } },
    operation: { header: { defindex: 2 }, operation_node: [{ stage: { apply_sticker: { sticker: [a, b] } } }] },
  });
}

/** Two occurrences of one sticker; `second` is the variant list of the second occurrence. */
function twoOccurrences(second: unknown): ProtoDefKitMessages {
  return {
    definition: { header: { defindex: 1 } },
    operation: {
      header: { defindex: 2 },
      operation_node: [
        { stage: { apply_sticker: { sticker: [{ base: { string: 'stickers/a' } }, { base: { string: 'stickers/b' } }] } } },
        { stage: { apply_sticker: { sticker: second } } },
      ],
    },
  };
}

const variants = (messages: ProtoDefKitMessages, occurrence = 0) =>
  dig(messages.operation, 'operation_node', occurrence, 'stage', 'apply_sticker', 'sticker');

/** Applies an edit and checks the input snapshot was left untouched. */
function edited(edit: (messages: ProtoDefKitMessages) => ProtoDefKitMessages): ProtoDefKitMessages {
  const before = kit();
  const next = edit(before);
  assert.deepEqual(before, kit(), 'the input snapshot is not mutated');
  assert.deepEqual(next.definition.header, before.definition.header, 'the shared header variable stays as authored');
  return next;
}

test('weights: a literal is set in place, a variable weight is forked to a literal on that variant only', () => {
  assert.deepEqual(variants(edited((messages) => setStickerVariantWeight(messages, target, 0, 2.5))), [{ ...a, weight: { float: 2.5 } }, b]);
  assert.deepEqual(variants(edited((messages) => setStickerVariantWeight(messages, target, 1, 0))), [a, { ...b, weight: { float: 0 } }]);
});

test('add appends a trimmed variant with weight 1; remove drops one', () => {
  assert.deepEqual(variants(edited((messages) => addStickerVariant(messages, target, '  stickers/c  '))), [
    a, b, { base: { string: 'stickers/c' }, weight: { float: 1 } },
  ]);
  assert.deepEqual(variants(edited((messages) => removeStickerVariant(messages, target, 0))), [b]);
});

test('artwork is repointed on every occurrence and keeps its weight', () => {
  assert.deepEqual(variants(edited((messages) => setStickerVariantBase(messages, target, 1, '  stickers/c  '))), [
    a, { ...b, base: { string: 'stickers/c' } },
  ]);
  const twice = twoOccurrences([{ base: { string: 'stickers/a' } }, { base: { string: 'stickers/b' } }]);
  const next = setStickerVariantBase(twice, both, 0, 'stickers/c');
  for (const occurrence of [0, 1]) {
    assert.deepEqual(variants(next, occurrence), [{ base: { string: 'stickers/c' } }, { base: { string: 'stickers/b' } }]);
  }
});

test('equalizing sets every weight to 1 in one edit, including a variable weight', () => {
  assert.deepEqual(variants(edited((messages) => equalizeStickerVariantWeights(messages, target))), [a, { ...b, weight: { float: 1 } }]);
});

test('unsafe variant edits are refused', () => {
  const zeroed = setStickerVariantWeight(kit(), target, 1, 0);
  const mismatched = twoOccurrences({ base: { string: 'stickers/a' } });
  for (const [label, edit, error] of [
    ['negative weight', () => setStickerVariantWeight(kit(), target, 0, -1), TypeError],
    ['NaN weight', () => setStickerVariantWeight(kit(), target, 0, Number.NaN), TypeError],
    ['infinite weight', () => setStickerVariantWeight(kit(), target, 0, Number.POSITIVE_INFINITY), TypeError],
    ['all weights 0', () => setStickerVariantWeight(zeroed, target, 0, 0), /weight above 0/],
    ['missing weight index', () => setStickerVariantWeight(kit(), target, 2, 1), /does not exist/],
    ['blank new variant', () => addStickerVariant(kit(), target, '   '), TypeError],
    ['missing removal index', () => removeStickerVariant(kit(), target, -1), /does not exist/],
    ['removing the last variant', () => removeStickerVariant(removeStickerVariant(kit(), target, 0), target, 0), /at least one variant/],
    ['removal leaving all weights 0', () => removeStickerVariant(zeroed, target, 0), /weight 0/],
    ['blank artwork', () => setStickerVariantBase(kit(), target, 0, '   '), TypeError],
    ['missing artwork index', () => setStickerVariantBase(kit(), target, 2, 'stickers/c'), /does not exist/],
    ['negative artwork index', () => setStickerVariantBase(kit(), target, -1, 'stickers/c'), /does not exist/],
    ['no stage for artwork', () => setStickerVariantBase(kit(), { stagePaths: [] }, 0, 'stickers/c'), /No authored sticker stage/],
    ['no stage to equalize', () => equalizeStickerVariantWeights(kit(), { stagePaths: [] }), /No authored sticker stage/],
    ['mismatched add', () => addStickerVariant(mismatched, both, 'stickers/c'), /different variants/],
    ['mismatched weight', () => setStickerVariantWeight(mismatched, both, 0, 2), /different variants/],
    ['mismatched equalize', () => equalizeStickerVariantWeights(mismatched, both), /different variants/],
    ['mismatched artwork', () => setStickerVariantBase(mismatched, both, 0, 'stickers/c'), /different variants/],
  ] as const) assert.throws(edit, error, label);
});

// Weapon slots and wear can override a variable weight. Validation must count
// the weights the compositor will actually read, not the header defaults.
test('weight validation uses the resolved weights, not the header defaults', () => {
  // The header default for $shared_weight is 3, but the weapon slot resolves it to 0.
  const resolvedZeroForB = { stagePaths: [stagePath(0)], effectiveWeights: [1, 0] };
  assert.throws(() => setStickerVariantWeight(kit(), resolvedZeroForB, 0, 0), /weight above 0/);
  assert.throws(() => removeStickerVariant(kit(), resolvedZeroForB, 0), /weight 0/);
  assert.deepEqual(variants(setStickerVariantWeight(kit(), resolvedZeroForB, 0, 2)), [{ ...a, weight: { float: 2 } }, b]);
  assert.deepEqual(variants(removeStickerVariant(kit(), resolvedZeroForB, 1)), [a]);
  assert.throws(() => setStickerVariantWeight(kit(), { stagePaths: [stagePath(0)], effectiveWeights: [1] }, 0, 2), /do not match/);
});
