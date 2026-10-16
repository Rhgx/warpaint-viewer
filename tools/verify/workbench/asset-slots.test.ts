import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  collectPackageStickerSpecularOverrides,
  collectSlots,
  stickerSpecularRef,
} from '../../../src/workbench/assetSlots';

test('sticker slots expose an inferred _s specular input unless one is authored', () => {
  assert.equal(stickerSpecularRef('patterns/stickers/pig.vtf'), 'patterns/stickers/pig_s.vtf');
  for (const [spec, specularRef] of [[undefined, 'patterns/stickers/pig_s'], ['patterns/stickers/custom_phong', 'patterns/stickers/custom_phong']]) {
    const slots = collectSlots([{
      wearIndex: 0,
      recipe: {
        type: 'apply_sticker',
        stickers: [{ base: 'patterns/stickers/pig', spec }],
        nodes: [{ type: 'texture_lookup', texture: 'patterns/base' }],
      },
    }]);
    assert.ok(slots.some((slot) => slot.ref === 'patterns/stickers/pig' && slot.kind === 'sticker' && slot.specularRef === specularRef));
    assert.ok(!slots.some((slot) => slot.ref === specularRef), 'the specular is not its own slot');
  }
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
