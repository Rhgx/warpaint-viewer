import assert from 'node:assert/strict';
import { afterEach, test, vi } from 'vitest';
import * as THREE from 'three';
import { Compositor } from '../../../src/compositor/compositor';
import type { RecipeNode } from '../../../src/compositor/types';

// Exercise the real compositor and queues without requiring a GPU in Vitest.
// Pixel correctness remains covered by the browser self-test.
const gpu = vi.hoisted(() => ({
  capabilities: { maxTextureSize: 16384, getMaxAnisotropy: () => 1 },
  domElement: new EventTarget(),
  getRenderTarget: () => null,
  setRenderTarget: vi.fn(),
  render: vi.fn(),
  initTexture: vi.fn(),
  compileAsync: vi.fn(async () => undefined),
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

test('sticker levels apply after the blend', async () => {
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
    const texture = new THREE.Texture<HTMLImageElement>();
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  });
  const comp = new Compositor((ref) => ref);
  const sticker: RecipeNode = {
    type: 'apply_sticker',
    stickers: [{ base: 'sticker' }],
    nodes: [{ type: 'texture_lookup', texture: 'base' }],
  };
  try {
    const plain = await comp.compose(sticker, '0');
    assert.equal(gpu.render.mock.calls.length, 1);
    comp.releaseResult(plain);
    const adjusted = await comp.compose({ ...sticker, adjustGamma: [1.5, 1.5] }, '0');
    assert.equal(gpu.render.mock.calls.length, 3);
    comp.releaseResult(adjusted);
  } finally { comp.dispose(); }
});


test('intent warmup loads only the seed-selected sticker, while idle warmup retains alternatives', async () => {
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
    const texture = new THREE.Texture<HTMLImageElement>();
    queueMicrotask(() => onLoad?.(texture));
    return texture;
  });
  const resolve = vi.fn((ref: string) => ref);
  const comp = new Compositor(resolve);
  const stickerRecipe: RecipeNode = {
    type: 'apply_sticker',
    stickers: [{ base: 'first' }, { base: 'second' }],
    nodes: [{ type: 'texture_lookup', texture: 'surface' }],
  };
  try {
    await comp.preload(stickerRecipe, async () => undefined, () => false, '42');
    const refs = resolve.mock.calls.map(([ref]) => ref);
    assert.ok(refs.includes('surface'));
    assert.equal(refs.filter((ref) => ref === 'first' || ref === 'second').length, 1);
    assert.equal(gpu.render.mock.calls.length, 0, 'warmup must not compose or change visible paint');
    await comp.preload(stickerRecipe, async () => undefined, () => false);
    assert.ok(resolve.mock.calls.some(([ref]) => ref === 'first'));
    assert.ok(resolve.mock.calls.some(([ref]) => ref === 'second'));
  } finally { comp.dispose(); }
});

const lost = () => gpu.domElement.dispatchEvent(new Event('webglcontextlost'));
const restored = () => gpu.domElement.dispatchEvent(new Event('webglcontextrestored'));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const dims = { width: 64, height: 64 };
const lookup = (texture: string): RecipeNode => ({ type: 'texture_lookup', texture });
const drawsInto = (target: THREE.WebGLRenderTarget) => gpu.setRenderTarget.mock.calls.filter(([drawn]) => drawn === target).length;

/**
 * Decodes each ref into a fake ImageBitmap the way ImageBitmapLoader does
 * (fetch, then createImageBitmap). A ref with a gate waits for it to open.
 */
function stubBitmaps(edge: (ref: string) => number) {
  const closed = new Set<unknown>();
  const gates = new Map<string, Promise<void>>();
  const requested: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    requested.push(url);
    await gates.get(url);
    return { blob: async () => new Blob([url]) };
  });
  vi.stubGlobal('createImageBitmap', async (blob: Blob) => {
    const size = edge(await blob.text());
    const bitmap = { width: size, height: size, close: () => { closed.add(bitmap); } };
    return bitmap;
  });
  return { closed, gates, requested };
}

test('a restore reloads inputs evicted during the loss instead of uploading closed bitmaps', async () => {
  // 4096px fits any cache budget alone; 8192px exceeds every budget.
  const { closed, gates } = stubBitmaps((ref) => ref === 'big' ? 8192 : 4096);
  let closedUses = 0;
  const countClosed = (texture: unknown) => {
    if (texture instanceof THREE.Texture && closed.has(texture.image)) closedUses++;
  };
  gpu.initTexture.mockImplementation(countClosed);
  gpu.render.mockImplementation((scene: THREE.Scene) => scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.RawShaderMaterial)) return;
    for (const slot of ['uTex0', 'uTex1', 'uTex2', 'uTex3']) countClosed(object.material.uniforms[slot].value);
  }));
  const comp = new Compositor((ref) => ref);
  let open = () => {};
  try {
    const kept = await comp.compose(lookup('small'), '0', dims);
    lost();
    // Pushes the cache over budget, evicting and closing both inputs.
    comp.releaseResult(await comp.compose(lookup('big'), '0', dims));
    await flush();
    assert.equal(closed.size, 2);

    gates.set('small', new Promise<void>((resolve) => { open = resolve; }));
    gpu.setRenderTarget.mockClear();
    restored();
    const after = comp.compose(recipe, '1');
    await flush();
    assert.equal(drawsInto(kept.target), 0);
    open();
    comp.releaseResult(await after);
    assert.equal(drawsInto(kept.target), 1);
    assert.equal(closedUses, 0);
    comp.releaseResult(kept);
  } finally {
    open();
    comp.dispose();
    gpu.initTexture.mockReset();
    gpu.render.mockReset();
    vi.unstubAllGlobals();
  }
});

test('disposing while a restore awaits its inputs stops it without rendering or pooling', async () => {
  const { gates, requested } = stubBitmaps(() => 8192);
  const comp = new Compositor((ref) => ref);
  let open = () => {};
  try {
    const kept = await comp.compose(lookup('a'), '0', dims);
    const keptDisposed = vi.fn();
    kept.target.addEventListener('dispose', keptDisposed);
    // The input was evicted on unpin, so the restore has to fetch it again.
    gates.set('a', new Promise<void>((resolve) => { open = resolve; }));
    lost();
    restored();
    await vi.waitFor(() => assert.equal(requested.length, 2));

    comp.dispose();
    gpu.render.mockClear();
    gpu.setRenderTarget.mockClear();
    gpu.initTexture.mockClear();
    open();
    await flush();
    await flush();
    assert.equal(gpu.render.mock.calls.length, 0);
    assert.equal(gpu.setRenderTarget.mock.calls.length, 0);
    assert.equal(gpu.initTexture.mock.calls.length, 0);
    // An owner returning its result late gets it destroyed, not pooled.
    comp.releaseResult(kept);
    assert.equal(keptDisposed.mock.calls.length, 1);
  } finally {
    open();
    comp.dispose();
    vi.unstubAllGlobals();
  }
});

test('each restore recomposes every live result once and a superseded restore abandons', async () => {
  const comp = new Compositor((ref) => ref);
  const restoredEvents = vi.fn();
  gpu.domElement.addEventListener('warpaint:compose-restored', restoredEvents);
  // Queued behind any restore, so it settles once the restore has run.
  const settle = async () => comp.releaseResult(await comp.compose(recipe, '9'));
  try {
    const first = await comp.compose(recipe, '0', dims);
    const second = await comp.compose(recipe, '1', dims);
    comp.releaseResult(await comp.compose(recipe, '2', dims));
    const disposed = await comp.compose(recipe, '3', dims);
    disposed.target.dispose();
    gpu.setRenderTarget.mockClear();

    for (let cycle = 1; cycle <= 2; cycle++) {
      lost();
      restored();
      await settle();
      assert.equal(restoredEvents.mock.calls.length, 2 * cycle);
      assert.equal(drawsInto(first.target), cycle);
      assert.equal(drawsInto(second.target), cycle);
    }

    // Lost again before the queued pass ran: only the latest pass does work.
    lost();
    restored();
    lost();
    restored();
    await settle();
    assert.equal(restoredEvents.mock.calls.length, 6);
    assert.equal(drawsInto(first.target), 3);
    assert.equal(drawsInto(second.target), 3);
    assert.equal(drawsInto(disposed.target), 0);
    comp.releaseResult(first);
    comp.releaseResult(second);
  } finally {
    gpu.domElement.removeEventListener('warpaint:compose-restored', restoredEvents);
    comp.dispose();
  }
});
