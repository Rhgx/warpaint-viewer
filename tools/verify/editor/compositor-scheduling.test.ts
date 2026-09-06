import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import * as THREE from 'three';
import { Compositor } from '../../../src/compositor/compositor';
import type { RecipeNode } from '../../../src/compositor/types';

// Exercise the real compositor and queues without requiring a GPU in Vitest.
// Pixel correctness remains covered by the browser self-test.
const gpu = vi.hoisted(() => ({
  capabilities: { maxTextureSize: 16384, getMaxAnisotropy: () => 1 },
  getRenderTarget: () => null,
  setRenderTarget: vi.fn(),
  render: vi.fn(),
  initTexture: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('three', async (importOriginal) => ({
  ...await importOriginal<typeof import('three')>(),
  WebGLRenderer: class { constructor() { return gpu; } },
}));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const recipe: RecipeNode = { type: 'combine_multiply', nodes: [] };

test('a burst keeps only the latest visible paint while every export completes', async () => {
  const comp = new Compositor((ref) => ref);
  try {
    const exports = Array.from({ length: 3 }, () => comp.compose(recipe, '0'));
    const paints = Array.from({ length: 100 }, (_, i) => comp.composeLatest('visible', recipe, String(i), {
      width: i === 99 ? 512 : 64, height: 64,
    }));
    const results = await Promise.all(paints);
    assert.equal(results.slice(0, -1).every((result) => result === null), true);
    assert.ok(results[99]);
    assert.equal(results[99].target.width, 512);
    assert.equal(gpu.render.mock.calls.length, 4);
    for (const result of [...await Promise.all(exports), results[99]]) comp.releaseResult(result);
  } finally { comp.dispose(); }
});

test('cancelled queued paint does not render, and the channel accepts subsequent work', async () => {
  const comp = new Compositor((ref) => ref);
  try {
    let cancelled = false;
    const pending = comp.composeLatest('visible', recipe, '0', undefined, () => cancelled);
    cancelled = true;
    assert.equal(await pending, null);
    assert.equal(gpu.render.mock.calls.length, 0);
    const next = await comp.composeLatest('visible', recipe, '1');
    assert.ok(next);
    comp.releaseResult(next);
  } finally { comp.dispose(); }
});

test('warmup yields before each decode and upload and stops after cancellation', async () => {
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
    const texture = new THREE.Texture<HTMLImageElement>();
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  });
  const resolve = vi.fn((ref: string) => ref);
  const comp = new Compositor(resolve);
  let idleCount = 0;
  try {
    await comp.preload({ type: 'combine_add', nodes: [
      { type: 'texture_lookup', texture: 'A' },
      { type: 'texture_lookup', texture: 'B' },
      { type: 'texture_lookup', texture: 'C' },
    ] }, async () => { idleCount++; }, () => idleCount >= 4);
    assert.equal(idleCount, 4);
    assert.deepEqual(resolve.mock.calls, [['A'], ['B']]);
    assert.equal(gpu.initTexture.mock.calls.length, 1);
  } finally { comp.dispose(); }
});

test('superseding a paint during texture loading skips its GPU evaluation', async () => {
  let notifyLoading!: () => void;
  const loading = new Promise<void>((resolve) => { notifyLoading = resolve; });
  let finishLoad!: () => void;
  const loaded = new Promise<void>((resolve) => { finishLoad = resolve; });
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
    const texture = new THREE.Texture<HTMLImageElement>();
    notifyLoading();
    void loaded.then(() => onLoad?.(texture));
    return texture;
  });
  const comp = new Compositor((ref) => ref);
  try {
    const stale = comp.composeLatest('visible', { type: 'texture_lookup', texture: 'slow' }, '0');
    await loading;
    const latest = comp.composeLatest('visible', recipe, '1');
    finishLoad();
    assert.equal(await stale, null);
    const result = await latest;
    assert.ok(result);
    assert.equal(gpu.render.mock.calls.length, 1);
    comp.releaseResult(result);
  } finally { finishLoad(); comp.dispose(); }
});

test('released 2048px targets retain at most 32 MiB and never dispose live results', async () => {
  const dispose = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose');
  const comp = new Compositor((ref) => ref, { size: 2048 });
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => comp.compose(recipe, '0')));
    assert.equal(dispose.mock.calls.length, 0);
    for (const result of results) comp.releaseResult(result);
    assert.equal(dispose.mock.calls.length, 4);
    const recycled = await comp.compose(recipe, '0');
    assert.equal(results.slice(0, 2).some((result) => result.target === recycled.target), true);
    comp.releaseResult(recycled);
  } finally { comp.dispose(); }
  assert.equal(dispose.mock.calls.length, 6);
});

test('root levels get an output pass while identity roots avoid the extra draw', async () => {
  const comp = new Compositor((ref) => ref);
  try {
    const plain = await comp.compose(recipe, '0');
    assert.equal(gpu.render.mock.calls.length, 1);
    comp.releaseResult(plain);
    const adjusted = await comp.compose({ ...recipe, adjustGamma: [1.5, 1.5] }, '0');
    assert.equal(gpu.render.mock.calls.length, 3);
    comp.releaseResult(adjusted);
  } finally { comp.dispose(); }
});
