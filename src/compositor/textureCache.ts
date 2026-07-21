import * as THREE from 'three';
import type { TextureResolver } from './types';
import type { TextureMetadata } from '../data/types';

export interface LoadOpts {
  nearest?: boolean; // select group maps must not interpolate region indices
}

interface Entry {
  promise: Promise<THREE.Texture>;
  bytes: number; // 0 until the image is decoded
  settled: boolean;
  failed: boolean;
}

/**
 * The browser only exposes these as soft hints, so keep this deliberately
 * small and tolerate their absence (notably in Safari and test runners).
 */
export interface TextureCacheBudgetHints {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  maxTextureSize?: number;
}

const MIB = 1024 * 1024;

/**
 * Pick an LRU budget that leaves room for the viewer, compositor targets, and
 * the rest of the page. Source textures can be reloaded; avoiding a GPU reset
 * on an integrated/mobile GPU is more valuable than retaining every variant.
 *
 * Unknown hardware gets 256 MiB: materially safer than the old 384 MiB while
 * still holding roughly eleven fully-mipped 2048px RGBA textures. A capable
 * desktop (more than 8 GiB of reported memory) retains the previous 384 MiB
 * budget. GPU max texture size only constrains clearly lower-end adapters; an
 * 8192px desktop GPU is not penalized merely for reporting that limit.
 */
export function textureCacheBudgetBytes(hints: TextureCacheBudgetHints = {}): number {
  const nav = globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined;
  const memory = hints.deviceMemory ?? nav?.deviceMemory;
  const cores = hints.hardwareConcurrency ?? nav?.hardwareConcurrency;
  let budgetMiB = 256;

  if (Number.isFinite(memory)) {
    if (memory! <= 2) budgetMiB = 96;
    else if (memory! <= 4) budgetMiB = 160;
    else if (memory! <= 8) budgetMiB = 256;
    else budgetMiB = 384;
  }

  // CPU count is a weaker signal than RAM, but reliably spots phones and
  // low-power Chromebooks when Device Memory is unavailable.
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

// Loads and caches source textures. All textures are sampled RAW (NoColorSpace);
// sRGB decode, when wanted, is done in the compositor shader so we control it
// per input exactly like the fxc does.
//
// The cache is a byte-budgeted LRU: patterns run up to 2048x2048 (about 22 MB
// each on the GPU with mips) and the full corpus is far larger than any sane
// GPU budget, so least-recently-used textures are disposed once the budget is
// exceeded. Refs pinned via pin() (the textures used by an in-flight compose)
// are never evicted while pinned.
export class TextureCache {
  // Map preserves insertion order; entries are re-inserted on hit, so iteration
  // order is least-recently-used first.
  private cache = new Map<string, Entry>();
  private loader = new THREE.TextureLoader();
  private resolve: TextureResolver;
  private budget: number;
  private totalBytes = 0;
  private pinned = new Set<string>();
  private metadata: Record<string, TextureMetadata>;
  private metadataResolver: ((ref: string) => Partial<TextureMetadata> | undefined) | undefined;

  constructor(resolve: TextureResolver, budgetBytes = textureCacheBudgetBytes(), metadata: Record<string, TextureMetadata> = {}, metadataResolver?: (ref: string) => Partial<TextureMetadata> | undefined) {
    this.resolve = resolve;
    this.budget = budgetBytes;
    this.metadata = metadata;
    this.metadataResolver = metadataResolver;
  }

  keyFor(ref: string, opts: LoadOpts = {}): string {
    return `${opts.nearest ? 'n:' : ''}${ref}`;
  }

  // Pin a set of cache keys for the duration of a compose; returns unpin.
  pin(keys: string[]): () => void {
    for (const k of keys) this.pinned.add(k);
    return () => {
      for (const k of keys) this.pinned.delete(k);
    };
  }

  private evictIfNeeded() {
    if (this.totalBytes <= this.budget) return;
    for (const [k, entry] of this.cache) {
      if (this.totalBytes <= this.budget) break;
      if (this.pinned.has(k) || !entry.settled || entry.failed) continue;
      this.cache.delete(k);
      this.totalBytes -= entry.bytes;
      entry.promise.then((t) => t.dispose()).catch(() => undefined);
    }
  }

  load(ref: string, opts: LoadOpts = {}): Promise<THREE.Texture> {
    const key = this.keyFor(ref, opts);
    const existing = this.cache.get(key);
    if (existing) {
      // LRU touch: move to the end of the Map's insertion order.
      this.cache.delete(key);
      this.cache.set(key, existing);
      return existing.promise;
    }
    const entry: Entry = {
      promise: Promise.resolve(null as unknown as THREE.Texture),
      bytes: 0,
      settled: false,
      failed: false,
    };
    entry.promise = Promise.resolve(this.resolve(ref)).then((url) => new Promise<THREE.Texture>((resolve, reject) => {
      this.loader.load(
        url,
        (tex) => {
          tex.colorSpace = THREE.NoColorSpace;
          // CRITICAL orientation contract: the composited render target is
          // sampled by glTF UVs, whose convention (like the game's DirectX UVs)
          // is v=0 at the image TOP with unflipped uploads. TextureLoader's
          // default flipY=true would put the image bottom at v=0, making the
          // whole composite land vertically mirrored on the weapon. Uploading
          // every source unflipped keeps composite space identical to game UV
          // space (v down), so the result maps onto the mesh exactly in-game.
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
            if (meta?.anisotropic) tex.anisotropy = 16;
          }
          tex.needsUpdate = true;
          entry.settled = true;
          entry.bytes = textureBytes(tex);
          this.totalBytes += entry.bytes;
          this.evictIfNeeded();
          resolve(tex);
        },
        undefined,
        () => {
          entry.settled = true;
          entry.failed = true;
          reject(new Error(`failed to load texture: ${ref} (${url})`));
        },
      );
    }));
    this.cache.set(key, entry);
    return entry.promise;
  }

  dispose() {
    for (const e of this.cache.values()) {
      e.promise.then((t) => t.dispose()).catch(() => undefined);
    }
    this.cache.clear();
    this.totalBytes = 0;
    this.pinned.clear();
  }
}
