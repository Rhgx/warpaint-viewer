import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import { TextureCache } from '../../../src/compositor/textureCache';

afterEach(() => {
  vi.unstubAllGlobals();
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

test('transient texture failures retry, notify caller, and recover on later loads', async () => {
  vi.useFakeTimers();
  try {
    let attempts = 0;
    const errors: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      attempts += 1;
      if (attempts <= 3) return { ok: false, status: 503, blob: async () => new Blob([]) };
      return { ok: true, status: 200, blob: async () => new Blob([url]) };
    });
    vi.stubGlobal('createImageBitmap', async () => ({ width: 8, height: 8, close: vi.fn() }));

    const cache = new TextureCache((ref) => `https://example.test/${ref}`, 1024 * 1024, {}, undefined, 1, null, (ref) => {
      errors.push(ref);
    });

    const firstPromise = cache.load('patterns/flaky');
    await vi.runAllTimersAsync();
    await firstPromise;
    assert.equal(attempts, 3);
    assert.deepEqual(errors, ['patterns/flaky']);

    const second = await cache.load('patterns/flaky');
    assert.equal(attempts, 4);
    assert.equal((second.image as { width: number }).width, 8);
    cache.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test('missing 404 textures do not retry or trigger transient error callback', async () => {
  let attempts = 0;
  const errors: string[] = [];
  vi.stubGlobal('fetch', async () => {
    attempts += 1;
    return { ok: false, status: 404, blob: async () => new Blob([]) };
  });
  vi.stubGlobal('createImageBitmap', async () => ({ width: 8, height: 8, close: vi.fn() }));

  const cache = new TextureCache((ref) => `https://example.test/${ref}`, 1024 * 1024, {}, undefined, 1, null, (ref) => {
    errors.push(ref);
  });

  const first = await cache.load('patterns/missing');
  const second = await cache.load('patterns/missing');
  assert.equal(attempts, 1);
  assert.deepEqual(errors, []);
  assert.equal(first, second);
  cache.dispose();
});
