import assert from 'node:assert/strict';
import { afterEach, expect, test, vi } from 'vitest';

import { applyAlphaMask } from '../../../src/workbench/alphaMask';
import {
  collectPackageStickerSpecularOverrides,
  collectSlots,
  stickerSpecularRef,
} from '../../../src/workbench/assetSlots';
import { revokeAssetOverrideCache, revokeReleasedAssetUrls } from '../../../src/workbench/assetUrls';
import type { WarpaintAssetState } from '../../../src/workbench/types';

afterEach(() => vi.restoreAllMocks());

test('alpha masks use transparency when present and luminance otherwise', () => {
  const color = Uint8ClampedArray.from([10, 20, 30, 255, 40, 50, 60, 255]);
  applyAlphaMask(color, Uint8ClampedArray.from([255, 255, 255, 0, 0, 0, 0, 128]));
  expect([...color]).toEqual([10, 20, 30, 0, 40, 50, 60, 128]);
  applyAlphaMask(color, Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255]));
  expect([...color]).toEqual([10, 20, 30, 76, 40, 50, 60, 150]);
});

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

test('asset URL cleanup revokes only released blob URLs once', () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const retained: WarpaintAssetState = {
    color: { dataUrl: 'blob:retained', fileName: 'retained.png', isTga: false, hasEmbeddedAlpha: false },
    output: 'blob:retained',
  };
  const removed: WarpaintAssetState = {
    color: { dataUrl: 'blob:removed-color', fileName: 'removed.png', isTga: false, hasEmbeddedAlpha: false },
    alpha: { dataUrl: 'blob:removed-alpha', fileName: 'alpha.png' },
    output: 'blob:removed-output',
  };

  revokeReleasedAssetUrls({ retained, removed }, { retained });

  assert.deepEqual(
    revoke.mock.calls.map(([source]) => source).sort(),
    ['blob:removed-alpha', 'blob:removed-color', 'blob:removed-output'],
  );
});

test('cache cleanup ignores non-blob sources and deduplicates shared output URLs', () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  revokeAssetOverrideCache({
    first: {
      revision: 1,
      assets: {
        paint: {
          color: { dataUrl: 'blob:shared', fileName: 'paint.png', isTga: false, hasEmbeddedAlpha: false },
          output: 'blob:shared',
        },
      },
    },
    second: {
      revision: 1,
      assets: {
        paint: {
          color: { dataUrl: 'https://example.test/stock.webp', fileName: 'stock.webp', isTga: false, hasEmbeddedAlpha: false },
          output: 'blob:shared',
        },
      },
    },
  });

  assert.deepEqual(revoke.mock.calls, [['blob:shared']]);
});
