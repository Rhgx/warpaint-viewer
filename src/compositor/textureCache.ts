import * as THREE from 'three';
import type { TextureResolver } from './types';
import type { TextureMetadata } from '../data/types';
import { TOUCH_ONLY_DEVICE } from '../device';

export interface LoadOpts {
  nearest?: boolean; // select group maps must not interpolate region indices
}

interface Entry {
  /** The full texture, ready on the GPU; set when the full texture is first requested. */
  promise?: Promise<THREE.Texture>;
  /**
   * Whether the full texture was asked for. Smaller copies decode from the file
   * alone, so a caller that never wants the full texture never pays for it.
   */
  fullStarted: boolean;
  bytes: number; // 0 until the image is decoded
  settled: boolean;
  failed: boolean;
  // Decoded by this entry alone (THREE.Cache is off), so it is the bitmap's only owner.
  bitmap?: ImageBitmap;
  /** The downloaded file, kept until the full texture is up so stand-ins decode from it. */
  file?: Promise<Blob>;
  /** Downscaled stand-ins shown while the full texture streams in, by size. */
  tiers: Map<number, Promise<THREE.Texture>>;
  tierBitmaps: ImageBitmap[];
}

// Uploads larger than this go up in strips across tasks: one 2048 px texture is
// 16 MiB, and a single call froze low-end machines on every paint switch.
const STREAM_MIN_SIZE = 512;
const STRIP_BYTES = 256 * 1024;
// Upload work allowed per task before yielding, so frames keep coming.
const UPLOAD_BUDGET_MS = 6;

interface UploadJob { work: () => void; done: () => void; fail: (cause: unknown) => void }
/** Pending uploads by priority, lowest first: small stand-ins go up before the full textures. */
const uploadQueues = new Map<number, UploadJob[]>();
let uploadScheduled = false;

function nextUpload(): UploadJob | undefined {
  const priority = Math.min(...[...uploadQueues.keys()]);
  const queue = uploadQueues.get(priority);
  const job = queue?.shift();
  if (queue && !queue.length) uploadQueues.delete(priority);
  return job;
}

function pumpUploads() {
  uploadScheduled = false;
  const start = performance.now();
  // The work runs here, not in a promise continuation, so the budget measures it.
  while (uploadQueues.size && performance.now() - start < UPLOAD_BUDGET_MS) {
    const job = nextUpload()!;
    try {
      job.work();
      job.done();
    } catch (cause) {
      job.fail(cause);
    }
  }
  if (uploadQueues.size) scheduleUploads();
}

function scheduleUploads() {
  if (uploadScheduled) return;
  uploadScheduled = true;
  setTimeout(pumpUploads, 0);
}

/** Run one piece of upload work in a later task, within the shared per-task budget. */
function queueUpload(work: () => void, priority: number): Promise<void> {
  return new Promise((done, fail) => {
    const queue = uploadQueues.get(priority) ?? [];
    queue.push({ work, done, fail });
    uploadQueues.set(priority, queue);
    scheduleUploads();
  });
}

/** Smaller textures upload first, so each detail level appears as soon as it can. */
const uploadPriority = (image: { width: number; height: number }) => Math.max(image.width, image.height);

function isBitmap(image: unknown): image is ImageBitmap {
  return typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap;
}

/**
 * Upload a decoded texture strip by strip into storage allocated up front,
 * with the same sampling, generating mipmaps once the last strip lands.
 */
async function streamTexture(renderer: THREE.WebGLRenderer, source: THREE.Texture, image: ImageBitmap): Promise<THREE.Texture> {
  const target = new THREE.DataTexture(null, image.width, image.height, THREE.RGBAFormat, THREE.UnsignedByteType);
  target.colorSpace = source.colorSpace;
  target.flipY = false;
  target.premultiplyAlpha = false;
  target.unpackAlignment = 4;
  target.wrapS = source.wrapS;
  target.wrapT = source.wrapT;
  target.magFilter = source.magFilter;
  target.minFilter = source.minFilter;
  target.anisotropy = source.anisotropy;
  target.generateMipmaps = source.generateMipmaps;
  // Storage only; the pixels arrive through the strip copies below.
  target.source.dataReady = false;
  target.needsUpdate = true;
  const priority = uploadPriority(image);
  await queueUpload(() => renderer.initTexture(target), priority);
  const mipmaps = target.generateMipmaps;
  target.generateMipmaps = false;
  const rows = Math.max(1, Math.floor(STRIP_BYTES / (image.width * 4)));
  const strips: Promise<void>[] = [];
  for (let y = 0; y < image.height; y += rows) {
    const last = y + rows >= image.height;
    const region = new THREE.Box2(new THREE.Vector2(0, y), new THREE.Vector2(image.width, Math.min(image.height, y + rows)));
    const position = new THREE.Vector2(0, y);
    strips.push(queueUpload(() => {
      if (last) target.generateMipmaps = mipmaps;
      renderer.copyTextureToTexture(source, target, region, position);
    }, priority));
  }
  await Promise.all(strips);
  return target;
}

/**
 * The browser only exposes these as soft hints, so keep this deliberately
 * small and tolerate their absence (notably in Safari and test runners).
 */
export interface TextureCacheBudgetHints {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  maxTextureSize?: number;
  touchOnly?: boolean;
}

const MIB = 1024 * 1024;

// One console warning per ref for the whole session, not one per composite.
const reportedMissing = new Set<string>();

/**
 * LRU byte budget for source textures, sized to leave room for the viewer, the
 * compositor targets and the page. Losing a texture costs a reload; losing the GPU
 * context costs far more, so the tiers are conservative. Phones report no memory
 * and their browsers drop WebGL once a tab grows too large, so touch-only devices
 * are capped at 128 MiB.
 */
export function textureCacheBudgetBytes(hints: TextureCacheBudgetHints = {}): number {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const memory = hints.deviceMemory ?? nav?.deviceMemory;
  const cores = hints.hardwareConcurrency ?? nav?.hardwareConcurrency;
  const touchOnly = hints.touchOnly ?? TOUCH_ONLY_DEVICE;
  let budgetMiB = 256;

  if (Number.isFinite(memory)) {
    if (memory! <= 2) budgetMiB = 96;
    else if (memory! <= 4) budgetMiB = 160;
    else if (memory! <= 8) budgetMiB = 256;
    else budgetMiB = 384;
  }

  // CPU count is a weaker signal than RAM, but it still spots phones and Chromebooks.
  if (Number.isFinite(cores)) {
    if (cores! <= 2) budgetMiB = Math.min(budgetMiB, 96);
    else if (cores! <= 4) budgetMiB = Math.min(budgetMiB, 160);
    else if (cores! <= 6) budgetMiB = Math.min(budgetMiB, 256);
  }

  // maxTextureSize is not VRAM, but 2048/4096 limits are a useful guardrail
  // for integrated and mobile adapters. Do not reduce 8192+ desktop GPUs.
  if (Number.isFinite(hints.maxTextureSize)) {
    if (hints.maxTextureSize! <= 2048) budgetMiB = Math.min(budgetMiB, 96);
    else if (hints.maxTextureSize! <= 4096) budgetMiB = Math.min(budgetMiB, 160);
  }

  if (touchOnly) budgetMiB = Math.min(budgetMiB, 128);

  return budgetMiB * MIB;
}

// Estimated GPU bytes for a decoded texture (RGBA + ~1/3 for mips).
function textureBytes(tex: THREE.Texture): number {
  const img = tex.image as { width?: number; height?: number } | undefined;
  const w = img?.width ?? 0;
  const h = img?.height ?? 0;
  const base = w * h * 4;
  return tex.generateMipmaps ? Math.ceil(base * 1.34) : base;
}

// Loads and caches source textures. All are sampled RAW (NoColorSpace); sRGB decode
// happens in the compositor shader, per input, as the fxc does.
//
// Byte-budgeted LRU. Patterns run up to 2048x2048 (about 22 MB on the GPU with mips),
// so the corpus far exceeds any sane budget. Refs pinned via pin() are never evicted
// while an in-flight compose uses them.
export class TextureCache {
  // Map preserves insertion order; entries are re-inserted on hit, so iteration
  // order is least-recently-used first.
  private cache = new Map<string, Entry>();
  // Decoded off the main thread and raw (no premultiply, no color management), matching
  // how the textures are sampled. An <img> decodes premultiplied and would re-decode
  // 2048px patterns synchronously on upload: 100-300 ms hitches per paint switch.
  private decodesBitmaps = typeof createImageBitmap === 'function';
  private fallbackLoader = new THREE.TextureLoader();
  private resolve: TextureResolver;
  private budget: number;
  private totalBytes = 0;
  private pinned = new Map<string, number>();
  private metadata: Record<string, TextureMetadata>;
  private metadataResolver: ((ref: string) => Partial<TextureMetadata> | undefined) | undefined;
  private maxAnisotropy: number;
  /** Streams large uploads when present; without one, textures upload on first use. */
  private renderer: THREE.WebGLRenderer | null;

  constructor(resolve: TextureResolver, budgetBytes = textureCacheBudgetBytes(), metadata: Record<string, TextureMetadata> = {}, metadataResolver?: (ref: string) => Partial<TextureMetadata> | undefined, maxAnisotropy = 1, renderer: THREE.WebGLRenderer | null = null) {
    this.renderer = renderer;
    this.resolve = resolve;
    this.budget = budgetBytes;
    this.metadata = metadata;
    this.metadataResolver = metadataResolver;
    // Cap anisotropy at 8, and never above what the renderer supports.
    this.maxAnisotropy = Math.max(1, Math.min(8, maxAnisotropy));
  }

  keyFor(ref: string, opts: LoadOpts = {}): string {
    return `${opts.nearest ? 'n:' : ''}${ref}`;
  }

  // Pin a set of cache keys for the duration of a compose; returns unpin.
  pin(keys: string[]): () => void {
    for (const k of keys) this.pinned.set(k, (this.pinned.get(k) ?? 0) + 1);
    return () => {
      for (const k of keys) {
        const count = this.pinned.get(k) ?? 0;
        if (count <= 1) this.pinned.delete(k);
        else this.pinned.set(k, count - 1);
      }
      this.evictIfNeeded();
    };
  }

  private evictIfNeeded() {
    if (this.totalBytes <= this.budget) return;
    for (const [k, entry] of this.cache) {
      if (this.totalBytes <= this.budget) break;
      // Skip entries still loading a full texture; a copy-only entry has no in-flight work.
      if (this.pinned.has(k) || (entry.fullStarted && !entry.settled) || entry.failed) continue;
      this.cache.delete(k);
      this.totalBytes -= entry.bytes;
      this.discard(entry, true);
    }
  }

  // Frees the GPU upload, and the decoded bitmap unless an in-flight compose may still
  // draw or re-upload it. Callers pin before loading, so an unpinned entry has no users.
  private discard(entry: Entry, closeBitmap: boolean) {
    entry.promise?.then((t) => {
      t.dispose();
      if (closeBitmap) entry.bitmap?.close();
    }).catch(() => undefined);
    void Promise.allSettled([...entry.tiers.values()]).then((tiers) => {
      for (const tier of tiers) if (tier.status === 'fulfilled') tier.value.dispose();
      if (closeBitmap) for (const bitmap of entry.tierBitmaps) bitmap.close();
    });
  }

  /** Whether the full texture is already on the GPU, so a compose needs no stand-ins. */
  isReady(ref: string, opts: LoadOpts = {}): boolean {
    return this.cache.get(this.keyFor(ref, opts))?.settled ?? false;
  }

  /**
   * A copy `size` px square, decoded straight from the file: a stand-in while
   * the full texture streams in, or all a small composite needs. It does not
   * start the full texture; once that is up, it is returned instead.
   */
  loadTier(ref: string, size: number, opts: LoadOpts = {}): Promise<THREE.Texture> {
    const entry = this.entryFor(ref, opts);
    const renderer = this.renderer;
    const file = entry.file;
    if (!renderer || !file || entry.settled) return this.load(ref, opts);
    const existing = entry.tiers.get(size);
    if (existing) return existing;
    const tier = (async () => {
      // Decode from the file, not by resizing the full bitmap: browsers decode files off
      // the main thread but resize bitmaps on it. Square is fine; the compositor samples by UV.
      const small = await createImageBitmap(await file, {
        resizeWidth: size,
        resizeHeight: size,
        // Group maps hold region ids, which must not blend into each other.
        resizeQuality: opts.nearest ? 'pixelated' : 'medium',
        imageOrientation: 'none',
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      entry.tierBitmaps.push(small);
      const texture = new THREE.Texture(small);
      this.configure(texture, ref, opts);
      const bytes = textureBytes(texture);
      entry.bytes += bytes;
      this.totalBytes += bytes;
      if (Math.max(small.width, small.height) > STREAM_MIN_SIZE) return streamTexture(renderer, texture, small);
      // Small copies upload at once; queueing them behind other work costs far more.
      renderer.initTexture(texture);
      return texture;
    })().catch(() => this.load(ref, opts));
    entry.tiers.set(size, tier);
    return tier;
  }

  // Sampling state for a decoded source. All textures are sampled RAW; see load().
  private configure(tex: THREE.Texture, ref: string, opts: LoadOpts) {
    tex.colorSpace = THREE.NoColorSpace;
    // CRITICAL orientation contract: composites are sampled by glTF UVs, with v=0 at
    // the image top. TextureLoader's default flipY=true would mirror the whole
    // composite on the weapon, so every source uploads unflipped.
    tex.flipY = false;
    const meta = { ...this.metadata[ref], ...this.metadataResolver?.(ref) };
    tex.wrapS = meta?.clampS ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = meta?.clampT ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    if (opts.nearest) {
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.wrapS = THREE.ClampToEdgeWrapping;
      tex.wrapT = THREE.ClampToEdgeWrapping;
    } else {
      tex.magFilter = meta?.pointSample ? THREE.NearestFilter : THREE.LinearFilter;
      tex.generateMipmaps = !(meta?.noMip || meta?.noLod);
      tex.minFilter = !tex.generateMipmaps
        ? tex.magFilter
        : meta?.pointSample ? THREE.NearestMipmapNearestFilter
          : meta?.trilinear || meta?.anisotropic ? THREE.LinearMipmapLinearFilter : THREE.LinearMipmapNearestFilter;
      if (meta?.anisotropic) tex.anisotropy = this.maxAnisotropy;
    }
    tex.needsUpdate = true;
  }

  /** The cache entry for a source, fetching its file on first use; LRU-touched. */
  private entryFor(ref: string, opts: LoadOpts): Entry {
    const key = this.keyFor(ref, opts);
    const existing = this.cache.get(key);
    if (existing) {
      // LRU touch: move to the end of the Map's insertion order.
      this.cache.delete(key);
      this.cache.set(key, existing);
      return existing;
    }
    const entry: Entry = {
      fullStarted: false,
      bytes: 0,
      settled: false,
      failed: false,
      tiers: new Map(),
      tierBitmaps: [],
    };
    // An empty ref is a stage with no texture picked yet: it stays white, with no fetch
    // or warning. The file is fetched up front so stand-ins can decode from it.
    entry.file = ref && this.decodesBitmaps ? Promise.resolve(this.resolve(ref)).then((url) => fetch(url)).then((response) => response.blob()) : undefined;
    this.cache.set(key, entry);
    return entry;
  }

  load(ref: string, opts: LoadOpts = {}): Promise<THREE.Texture> {
    const entry = this.entryFor(ref, opts);
    if (entry.promise) return entry.promise;
    entry.fullStarted = true;
    const resolvedUrl = Promise.resolve(ref ? this.resolve(ref) : '');
    const file = entry.file;
    const decoded = resolvedUrl.then((url) => new Promise<THREE.Texture>((resolve) => {
      const onLoad = (tex: THREE.Texture) => {
        this.configure(tex, ref, opts);
        const bytes = textureBytes(tex);
        entry.bytes += bytes;
        this.totalBytes += bytes;
        resolve(tex);
      };
      const onError = () => {
        entry.settled = true;
        entry.failed = true;
        // A texture the import names but never shipped must not sink the composite. Stand
        // in white, the neutral element of multiply chains, so the rest of the paint draws.
        if (ref && !reportedMissing.has(ref)) {
          reportedMissing.add(ref);
          console.warn(`[warpaint-viewer] missing texture, substituting white: ${ref} (${url})`);
        }
        const placeholder = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
        placeholder.colorSpace = THREE.NoColorSpace;
        placeholder.needsUpdate = true;
        entry.bytes += 4;
        this.totalBytes += 4;
        resolve(placeholder);
      };
      if (!ref) {
        onError();
      } else if (file) {
        // Decoded off the main thread, raw; the file is kept so stand-ins can decode from it too.
        file
          .then((blob) => createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' }))
          .then((bitmap) => {
            entry.bitmap = bitmap;
            onLoad(new THREE.Texture(bitmap));
          }, onError);
      } else {
        this.fallbackLoader.load(url, onLoad, undefined, onError);
      }
    }));
    entry.promise = decoded.then((tex) => {
      const image = tex.image;
      // Large bitmaps stream up in strips; small ones upload whole on first use.
      return this.renderer && isBitmap(image) && Math.max(image.width, image.height) > STREAM_MIN_SIZE
        ? streamTexture(this.renderer, tex, image)
        : tex;
    }).then((tex) => {
      entry.settled = true;
      entry.file = undefined;
      this.evictIfNeeded();
      return tex;
    }, (cause: unknown) => {
      entry.settled = true;
      entry.failed = true;
      throw cause;
    });
    return entry.promise;
  }

  dispose() {
    for (const [k, e] of this.cache) this.discard(e, !this.pinned.has(k));
    this.cache.clear();
    this.totalBytes = 0;
    this.pinned.clear();
  }
}
