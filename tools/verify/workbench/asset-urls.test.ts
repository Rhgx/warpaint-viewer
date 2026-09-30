import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { revokeAssetOverrideCache, revokeReleasedAssetUrls } from '../../../src/workbench/assetUrls';
import type { WarpaintAssetState } from '../../../src/workbench/types';

afterEach(() => vi.restoreAllMocks());

test('asset URL cleanup revokes only released blob URLs once', () => {
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  const retained: WarpaintAssetState = {
    color: { dataUrl: 'blob:retained', fileName: 'retained.png', isTga: false },
    output: 'blob:retained',
  };
  const removed: WarpaintAssetState = {
    color: { dataUrl: 'blob:removed-color', fileName: 'removed.png', isTga: false },
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
          color: { dataUrl: 'blob:shared', fileName: 'paint.png', isTga: false },
          output: 'blob:shared',
        },
      },
    },
    second: {
      revision: 1,
      assets: {
        paint: {
          color: { dataUrl: 'https://example.test/stock.webp', fileName: 'stock.webp', isTga: false },
          output: 'blob:shared',
        },
      },
    },
  });

  assert.deepEqual(revoke.mock.calls, [['blob:shared']]);
});
