import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  collectPackageStickerSpecularOverrides,
  collectSlots,
  stickerSpecularRef,
} from '../../../src/workbench/assetSlots';

test('sticker slots expose an inferred _s specular input', () => {
  assert.equal(stickerSpecularRef('patterns/stickers/pig.vtf'), 'patterns/stickers/pig_s.vtf');
  assert.equal(stickerSpecularRef('patterns/stickers/pig'), 'patterns/stickers/pig_s');

  const slots = collectSlots([{
    wearIndex: 0,
    recipe: {
      type: 'apply_sticker',
      stickers: [{ base: 'patterns/stickers/pig' }],
      nodes: [{ type: 'texture_lookup', texture: 'patterns/base' }],
    },
  }]);
  assert.ok(slots.some((slot) => (
    slot.ref === 'patterns/stickers/pig'
      && slot.kind === 'sticker'
      && slot.specularRef === 'patterns/stickers/pig_s'
  )));
  assert.ok(!slots.some((slot) => slot.ref === 'patterns/stickers/pig_s'));
});

test('an explicitly authored sticker specular remains the editable input', () => {
  const slots = collectSlots([{
    wearIndex: 0,
    recipe: {
      type: 'apply_sticker',
      stickers: [{ base: 'patterns/stickers/pig', spec: 'patterns/stickers/custom_phong' }],
      nodes: [{ type: 'texture_lookup', texture: 'patterns/base' }],
    },
  }]);
  assert.ok(slots.some((slot) => (
    slot.ref === 'patterns/stickers/pig'
      && slot.specularRef === 'patterns/stickers/custom_phong'
  )));
  assert.ok(!slots.some((slot) => slot.ref === 'patterns/stickers/custom_phong'));
});

test('package specular discovery retains refs without resolving texture data', () => {
  const recipes = [{
    wearIndex: 0,
    recipe: {
      type: 'apply_sticker' as const,
      stickers: [
        { base: 'patterns/stickers/pig' },
        { base: 'patterns/stickers/absent' },
      ],
      nodes: [{ type: 'texture_lookup' as const, texture: 'patterns/base' }],
    },
  }];
  const membershipChecks: string[] = [];
  const overrides = collectPackageStickerSpecularOverrides(recipes, (ref) => {
    membershipChecks.push(ref);
    return ref === 'patterns/stickers/pig_s';
  });

  assert.deepEqual(membershipChecks, [
    'patterns/stickers/pig_s',
    'patterns/stickers/absent_s',
  ]);
  assert.deepEqual(overrides, {
    'patterns/stickers/pig_s': 'patterns/stickers/pig_s',
  });
});
