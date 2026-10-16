import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { TextureCache, textureCacheBudgetBytes } from '../../../src/compositor/textureCache';

const MIB = 1024 * 1024;

afterEach(() => {
  vi.unstubAllGlobals();
});

test('touch-only devices get a lower texture budget; desktop tiers are unchanged', () => {
  const desktop = { deviceMemory: 16, hardwareConcurrency: 16, maxTextureSize: 16384 };
  assert.equal(textureCacheBudgetBytes({ ...desktop, touchOnly: false }), 384 * MIB);
  assert.equal(textureCacheBudgetBytes({ maxTextureSize: 16384, touchOnly: false }), 256 * MIB);
  // A phone with no memory hint and plenty of cores, like mobile Safari.
  assert.equal(textureCacheBudgetBytes({ hardwareConcurrency: 8, maxTextureSize: 16384, touchOnly: true }), 128 * MIB);
  // The touch cap never raises an already lower tier.
  assert.equal(textureCacheBudgetBytes({ deviceMemory: 2, touchOnly: true }), 96 * MIB);
});

/** Decodes every URL into its own fake bitmap, the way ImageBitmapLoader does with THREE.Cache off. */
function stubBitmapDecoding() {
  const bitmaps = new Map<string, { width: number; height: number; close: ReturnType<typeof vi.fn> }>();
  vi.stubGlobal('fetch', async (url: string) => ({ blob: async () => new Blob([url]) }));
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const bitmap = { width: 4, height: 4, close: vi.fn() };
    bitmaps.set(await blob.text(), bitmap);
    return bitmap;
  });
  return bitmaps;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test('evicted bitmaps are closed, pinned ones keep their image', async () => {
  const bitmaps = stubBitmapDecoding();
  // A 4x4 mipped texture is 86 bytes, so this budget holds exactly one.
  const cache = new TextureCache((ref) => ref, 100);

  await cache.load('a');
  const unpinB = cache.pin([cache.keyFor('b')]);
  const b = await cache.load('b');
  await flush();
  assert.equal(bitmaps.get('a')!.close.mock.calls.length, 1);
  assert.equal(bitmaps.get('b')!.close.mock.calls.length, 0);
  assert.equal(b.image, bitmaps.get('b'));

  // Disposing mid-compose must not pull the image out from under the compose.
  cache.dispose();
  await flush();
  assert.equal(bitmaps.get('b')!.close.mock.calls.length, 0);
  unpinB();

  await cache.load('c');
  cache.dispose();
  await flush();
  assert.equal(bitmaps.get('c')!.close.mock.calls.length, 1);
});
