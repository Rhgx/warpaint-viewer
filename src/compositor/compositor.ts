import * as THREE from 'three';

import type { PaintSeed, RecipeNode, TextureResolver } from './types';
import type { ResolvedNode, ResolvedTransform } from './resolve';
import { IDENTITY_TRANSFORM, isIdentityTransform, resolveRecipe, selectHasActiveGroup } from './resolve';
import { TextureCache, textureCacheBudgetBytes } from './textureCache';
import { ConstantTextures } from './constantTextures';
import { LatestComposeScheduler } from './latestCompose';
import { RenderTargetPool } from './renderTargets';
import type { TextureMetadata } from '../data/types';
export { textureUvMatrix } from './transforms';
import { textureUvMatrix } from './transforms';
import { compositorReadbackToEditorPixels } from '../editor/sticker/stickerSurface';
import { stickerCoverageQuad } from '../editor/sticker/stickerGeometry';
import {
  FRAG,
  VERT,
  MODE_ADD,
  MODE_BLEND,
  MODE_GROUP_STICKER_ARTWORK,
  MODE_LERP,
  MODE_MULTIPLY,
  MODE_SELECT,
  MODE_TEXTURE,
} from './shaders';

export interface ComposeResult {
  texture: THREE.Texture; // sRGB-stored compositor result, decoded by the material sampler
  target: THREE.WebGLRenderTarget; // owns texture; caller disposes when replaced
}

export interface CompositorOptions {
  size?: number; // square, default 1024
  textureMetadata?: Record<string, TextureMetadata>;
  textureMetadataResolver?: (ref: string) => Partial<TextureMetadata> | undefined;
}

export interface ComposeDimensions {
  width: number;
  height: number;
  /**
   * Compose from sources capped at this size, never loading them at full size;
   * sources already up at full size are used as they are.
   */
  sourceLimit?: number;
}

export interface GroupStickerArtworkInput {
  readonly mask: string;
  readonly selectorBase: THREE.Texture;
  readonly endpointZero: THREE.Texture;
  readonly endpointOne: THREE.Texture;
  readonly levels: readonly [black: number, white: number, gamma: number];
  readonly destTl: readonly [number, number];
  readonly destTr: readonly [number, number];
  readonly destBl: readonly [number, number];
  readonly size?: number;
}

const IDENTITY3 = new THREE.Matrix3();

interface EvaluatedInput {
  texture: THREE.Texture;
  transform: ResolvedTransform;
  target: THREE.WebGLRenderTarget | null;
}

/**
 * Lower-detail passes shown while a cold paint's textures stream in: sources capped
 * at `source` px, composed at no more than `output` px. Low-end machines skip the
 * middle step, since its uploads cost more smoothness than the sharper preview is worth.
 */
const LOW_END_DEVICE = (globalThis.navigator?.hardwareConcurrency ?? 8) <= 4
  || ((globalThis.navigator as (Navigator & { deviceMemory?: number }) | undefined)?.deviceMemory ?? 8) <= 4;
const PREVIEW_TIERS: readonly { source: number; output: number }[] = LOW_END_DEVICE
  ? [{ source: 256, output: 512 }]
  : [{ source: 256, output: 512 }, { source: 1024, output: 1024 }];

// Reimplements TF2's paintkit compositor on the GPU via three.js render targets,
// sharing the viewer's WebGL context. Evaluates a resolved stage tree bottom-up
// into ping-ponged 8-bit sRGB render targets, with shader math in linear space.
export class Compositor {
  private renderer: THREE.WebGLRenderer;
  private ownsRenderer: boolean;
  private readonly renderTargets: RenderTargetPool;
  private readonly constantTextures = new ConstantTextures();
  private readonly latestCompose: LatestComposeScheduler;
  private textures: TextureCache;

  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.RawShaderMaterial;
  private quad: THREE.Mesh;

  // Serializes requests so rapid wear or seed changes cannot interleave GPU passes.
  private composeQueue: Promise<void> = Promise.resolve();
  // Source textures already uploaded, so warm composes skip the upload yields.
  private uploaded = new WeakSet<THREE.Texture>();

  constructor(resolver: TextureResolver, opts: CompositorOptions & { renderer?: THREE.WebGLRenderer } = {}) {
    this.renderTargets = new RenderTargetPool(opts.size ?? 1024);
    if (opts.renderer) {
      this.renderer = opts.renderer;
      this.ownsRenderer = false;
    } else {
      this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
      this.ownsRenderer = true;
    }
    this.textures = new TextureCache(
      resolver,
      textureCacheBudgetBytes({ maxTextureSize: this.renderer.capabilities.maxTextureSize }),
      opts.textureMetadata,
      opts.textureMetadataResolver,
      this.renderer.capabilities.getMaxAnisotropy(),
      this.renderer,
    );
    this.latestCompose = new LatestComposeScheduler({
      enqueue: (work) => this.enqueue(work),
      composeResolvedNow: (resolved, dimensions, cancelled, onPreview) => this.composeResolvedNow(resolved, dimensions, cancelled, onPreview),
      releaseResult: (result) => this.releaseResult(result),
      prefetchTiers: (recipe, size) => this.prefetchTiers(recipe, size),
    });

    this.material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uMode: { value: MODE_TEXTURE },
        uTex0: { value: null },
        uTex1: { value: null },
        uTex2: { value: null },
        uTex3: { value: null },
        uAdjust0: { value: new THREE.Vector3(0, 1, 1) },
        uAdjust1: { value: new THREE.Vector3(0, 1, 1) },
        uAdjust2: { value: new THREE.Vector3(0, 1, 1) },
        uAdjust3: { value: new THREE.Vector3(0, 1, 1) },
        uSrgb0: { value: 0 },
        uSrgb1: { value: 0 },
        uSrgb2: { value: 0 },
        uSrgb3: { value: 0 },
        uUv0: { value: new THREE.Matrix3() },
        uUv1: { value: new THREE.Matrix3() },
        uUv2: { value: new THREE.Matrix3() },
        uUv3: { value: new THREE.Matrix3() },
        uSelect: { value: new Array(16).fill(0) },
        uNumSelect: { value: 0 },
        uDestTl: { value: new THREE.Vector2(0, 1) },
        uDestTr: { value: new THREE.Vector2(1, 1) },
        uDestBl: { value: new THREE.Vector2(0, 0) },
      },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    // Link the shader while the first textures download, so the first compose does
    // not stall on it (KHR_parallel_shader_compile keeps it off the main thread).
    void this.renderer.compileAsync(this.scene, this.camera);
    // Uploads died with a lost context. The app recomposes after a restore
    // (render targets come back blank), so only the upload pacing resets here.
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestored);
  }

  private onContextRestored = () => {
    this.uploaded = new WeakSet();
    // Streamed textures were filled strip by strip and have no image to
    // re-upload from, so every source loads again.
    this.textures.dispose();
  };

  /** Source detail cap for the compose in progress; null composes from full textures. */
  private sourceTier: number | null = null;

  private input(ref: string, opts: { nearest?: boolean } = {}): Promise<THREE.Texture> {
    return this.sourceTier === null ? this.textures.load(ref, opts) : this.textures.loadTier(ref, this.sourceTier, opts);
  }

  // Gather every texture ref in the resolved tree so we can preload before render.
  private collectRefs(node: ResolvedNode, out: { ref: string; nearest: boolean }[]) {
    switch (node.type) {
      case 'texture_lookup':
        out.push({ ref: node.texture, nearest: false });
        break;
      case 'combine_multiply':
      case 'combine_add':
      case 'combine_lerp':
        node.nodes.forEach((n) => this.collectRefs(n, out));
        break;
      case 'select':
        if (selectHasActiveGroup(node.select)) out.push({ ref: node.groups, nearest: false });
        break;
      case 'apply_sticker':
        out.push({ ref: node.base, nearest: false });
        if (node.spec) out.push({ ref: node.spec, nearest: false });
        node.nodes.forEach((n) => this.collectRefs(n, out));
        break;
    }
  }

  // Gather refs from the unresolved recipe, including every weighted sticker
  // alternative, so a later seed change does not stall on decode or upload.
  private collectRecipeRefs(node: RecipeNode, out: { ref: string; nearest: boolean }[]) {
    switch (node.type) {
      case 'texture_lookup':
        out.push({ ref: node.texture, nearest: false });
        break;
      case 'combine_multiply':
      case 'combine_add':
      case 'combine_lerp':
        node.nodes.forEach((child) => this.collectRecipeRefs(child, out));
        break;
      case 'select':
        if (selectHasActiveGroup(node.select)) out.push({ ref: node.groups, nearest: false });
        break;
      case 'apply_sticker':
        for (const sticker of node.stickers ?? []) {
          if (sticker.base) out.push({ ref: sticker.base, nearest: false });
          if (sticker.spec) out.push({ ref: sticker.spec, nearest: false });
        }
        node.nodes.forEach((child) => this.collectRecipeRefs(child, out));
        break;
    }
  }

  /**
   * Fetch and decode a paint's sources at `sourceLimit` ahead of its compose,
   * such as on a hover that may become a click.
   */
  prefetchSources(recipe: RecipeNode, seed: PaintSeed, sourceLimit: number): void {
    this.prefetchTiers(resolveRecipe(recipe, seed), sourceLimit);
  }

  // Decode and upload inputs while the current paint is visible. A supplied seed
  // limits the warmup to the inputs the click will use; pixels never leave the GPU.
  async preload(recipe: RecipeNode, waitForIdle: () => Promise<void>, cancelled: () => boolean, seed?: PaintSeed): Promise<void> {
    const refs: { ref: string; nearest: boolean }[] = [];
    if (seed === undefined) this.collectRecipeRefs(recipe, refs);
    else this.collectRefs(resolveRecipe(recipe, seed), refs);
    const unique = [...new Map(refs.map((ref) => [this.textures.keyFor(ref.ref, { nearest: ref.nearest }), ref])).values()];
    for (const ref of unique) {
      await waitForIdle();
      if (cancelled()) return;
      const unpin = this.textures.pin([this.textures.keyFor(ref.ref, { nearest: ref.nearest })]);
      try {
        const texture = await this.textures.load(ref.ref, { nearest: ref.nearest });
        // Decode can outlive the idle period or the view, so yield again before upload.
        await waitForIdle();
        if (cancelled()) return;
        this.renderer.initTexture(texture);
        this.uploaded.add(texture);
      } finally {
        unpin();
      }
    }
  }

  private renderInto(target: THREE.WebGLRenderTarget) {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }

  // Set ALL sampler uniforms for a pass; unused slots get a dummy texture. The
  // fragment shader samples uTex0-3 in every mode, so a stale uniform pointing at a
  // pooled target this pass renders into is a framebuffer feedback loop: WebGL skips
  // the draw and the target stays black.
  private setTextures(t0: THREE.Texture, t1: THREE.Texture | null, t2: THREE.Texture | null, t3: THREE.Texture | null = null) {
    const u = this.material.uniforms;
    u.uTex0.value = t0;
    u.uTex1.value = t1 ?? this.constantTextures.dummyTex();
    u.uTex2.value = t2 ?? this.constantTextures.dummyTex();
    u.uTex3.value = t3 ?? this.constantTextures.dummyTex();
  }

  private configureInputs(inputs: EvaluatedInput[], safe: THREE.Texture) {
    const u = this.material.uniforms;
    const padded = Array.from({ length: 4 }, (_, index) => inputs[index] ?? {
      texture: safe,
      transform: IDENTITY_TRANSFORM,
      target: null,
    });
    this.setTextures(padded[0].texture, padded[1].texture, padded[2].texture, padded[3].texture);
    const adjusts = [u.uAdjust0, u.uAdjust1, u.uAdjust2, u.uAdjust3];
    const srgb = [u.uSrgb0, u.uSrgb1, u.uSrgb2, u.uSrgb3];
    const matrices = [u.uUv0, u.uUv1, u.uUv2, u.uUv3];
    padded.forEach((input, index) => {
      const t = input.transform;
      (adjusts[index].value as THREE.Vector3).set(t.black, t.white, t.gamma);
      srgb[index].value = 1;
      (matrices[index].value as THREE.Matrix3).copy(
        textureUvMatrix(t.rotationDeg, t.translateU, t.translateV, t.scale, t.flipU, t.flipV),
      );
    });
  }

  private releaseInputs(inputs: EvaluatedInput[]) {
    const released = new Set<THREE.WebGLRenderTarget>();
    for (const input of inputs) {
      if (input.target && !released.has(input.target)) {
        released.add(input.target);
        this.renderTargets.release(input.target);
      }
    }
  }

  private async evaluate(node: ResolvedNode): Promise<EvaluatedInput> {
    const u = this.material.uniforms;
    switch (node.type) {
      case 'texture_lookup': {
        const tex = await this.input(node.texture);
        // Texture leaves feed their parent stage directly. Keeping the transform and
        // levels as sampler state avoids an extra RGBA8 pass per transformed lookup.
        return { texture: tex, transform: node, target: null };
      }
      case 'combine_multiply':
      case 'combine_add':
      case 'combine_lerp': {
        const children = await Promise.all(node.nodes.map((child) => this.evaluate(child)));
        let result: THREE.WebGLRenderTarget;
        if (node.type === 'combine_lerp') {
          const out = this.renderTargets.acquire();
          u.uMode.value = MODE_LERP;
          const lerpInputs = [
            children[0],
            children[1] ?? children[0],
            children[2] ?? { texture: this.constantTextures.constHalf(), transform: IDENTITY_TRANSFORM, target: null },
          ].filter(Boolean) as EvaluatedInput[];
          this.configureInputs(lerpInputs, this.constantTextures.constWhite());
          this.renderInto(out);
          result = out;
        } else {
          const mode = node.type === 'combine_multiply' ? MODE_MULTIPLY : MODE_ADD;
          const safe = node.type === 'combine_multiply' ? this.constantTextures.constWhite() : this.constantTextures.constZero();
          let pending = [...children];
          let previous: EvaluatedInput | null = null;
          do {
            const capacity = previous ? 3 : 4;
            const batch = pending.splice(0, capacity);
            if (previous) batch.unshift(previous);
            const out = this.renderTargets.acquire();
            u.uMode.value = mode;
            this.configureInputs(batch, safe);
            this.renderInto(out);
            if (previous?.target) this.renderTargets.release(previous.target);
            previous = { texture: out.texture, transform: IDENTITY_TRANSFORM, target: out };
          } while (pending.length);
          result = previous!.target!;
        }
        this.releaseInputs(children);
        return { texture: result.texture, transform: node, target: result };
      }
      case 'select': {
        if (!selectHasActiveGroup(node.select)) {
          return { texture: this.constantTextures.constZero(), transform: IDENTITY_TRANSFORM, target: null };
        }
        const groups = await this.input(node.groups);
        const out = this.renderTargets.acquire();
        u.uMode.value = MODE_SELECT;
        this.setTextures(groups, null, null, null);
        u.uSrgb0.value = 0;
        // Raw 0..255 group ids scaled by cFac = 1/16 exactly as compositor.cpp
        // does before uploading cSelectValues.
        const arr = u.uSelect.value as number[];
        for (let i = 0; i < 16; i++) arr[i] = i < node.select.length ? node.select[i] / 16 : 0;
        u.uNumSelect.value = Math.min(16, node.select.length);
        this.renderInto(out);
        return { texture: out.texture, transform: IDENTITY_TRANSFORM, target: out };
      }
      case 'apply_sticker': {
        const base = await this.evaluate(node.nodes[0]);
        const sticker = await this.input(node.base);
        const stickerSpec = node.spec ? await this.input(node.spec) : null;
        const out = this.renderTargets.acquire();
        u.uMode.value = MODE_BLEND;
        // CTCApplyStickerStage binds black when the optional implicit `_s`
        // texture is unavailable. Black writes a zero phong mask, so stickers
        // without a spec map (such as Sandwich Diner) stay matte.
        this.setTextures(base.texture, sticker, stickerSpec ?? this.constantTextures.dummyTex(), null);
        const t = base.transform;
        u.uSrgb0.value = 1;
        u.uSrgb1.value = 1;
        // Sticker specular maps are scalar material data. Source samples them
        // linearly even when the diffuse sticker is read as sRGB.
        u.uSrgb2.value = 0;
        (u.uAdjust0.value as THREE.Vector3).set(t.black, t.white, t.gamma);
        (u.uUv0.value as THREE.Matrix3).copy(
          textureUvMatrix(t.rotationDeg, t.translateU, t.translateV, t.scale, t.flipU, t.flipV),
        );
        (u.uAdjust1.value as THREE.Vector3).set(0, 1, 1);
        const dest = stickerCoverageQuad({ tl: node.destTl, tr: node.destTr, bl: node.destBl });
        (u.uDestTl.value as THREE.Vector2).fromArray(dest.tl);
        (u.uDestTr.value as THREE.Vector2).fromArray(dest.tr);
        (u.uDestBl.value as THREE.Vector2).fromArray(dest.bl);
        this.renderInto(out);
        if (base.target) this.renderTargets.release(base.target);
        return {
          texture: out.texture,
          transform: { ...IDENTITY_TRANSFORM, black: node.black, white: node.white, gamma: node.gamma },
          target: out,
        };
      }
    }
  }

  // Runs GPU work after every earlier task settles. A failed task still releases
  // the queue for the next one.
  private enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const task = this.composeQueue.then(work);
    this.composeQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  // Compose a recipe at a seed. Returns a target the caller owns; return it via
  // releaseResult() (preferred, recycles into the pool) or dispose it.
  compose(recipe: RecipeNode, seed: PaintSeed, dimensions?: ComposeDimensions): Promise<ComposeResult> {
    return this.enqueue(() => this.composeNow(recipe, seed, dimensions));
  }

  /** Compose an already resolved tree without consuming a second RNG stream. */
  composeResolved(recipe: ResolvedNode, dimensions?: ComposeDimensions): Promise<ComposeResult> {
    return this.enqueue(() => this.composeResolvedNow(recipe, dimensions));
  }

  /**
   * Keep at most one pending composition per channel; a newer request replaces it.
   * `onPreview`, when given, receives lower-detail composites while cold textures
   * stream in. Each result belongs to the caller.
   */
  composeLatest(
    channel: string,
    recipe: RecipeNode,
    seed: PaintSeed,
    dimensions?: ComposeDimensions,
    cancelled?: () => boolean,
    onPreview?: (result: ComposeResult) => void,
  ): Promise<ComposeResult | null> {
    return this.latestCompose.composeLatest(channel, recipe, seed, dimensions, cancelled, onPreview);
  }

  composeResolvedLatest(
    channel: string,
    recipe: ResolvedNode,
    dimensions?: ComposeDimensions,
    cancelled?: () => boolean,
    onPreview?: (result: ComposeResult) => void,
  ): Promise<ComposeResult | null> {
    return this.latestCompose.composeResolvedLatest(channel, recipe, dimensions, cancelled, onPreview);
  }

  /**
   * Render one selector-writing group sticker as standalone transparent artwork: a
   * single small GPU pass over the retained endpoints, so selecting it does not
   * recompose the recipe. Moving it stays uniform-only in the Viewer.
   */
  composeGroupStickerArtworkDataUrl(input: GroupStickerArtworkInput): Promise<string> {
    return this.enqueue(async () => {
      const size = Number.isFinite(input.size)
        ? Math.max(64, Math.min(1024, Math.floor(input.size!)))
        : 512;
      const maskKey = this.textures.keyFor(input.mask);
      const unpin = this.textures.pin([maskKey]);
      let target: THREE.WebGLRenderTarget | null = null;
      try {
        const mask = await this.textures.load(input.mask);
        target = this.renderTargets.makeTarget(size, size);
        const u = this.material.uniforms;
        u.uMode.value = MODE_GROUP_STICKER_ARTWORK;
        this.setTextures(input.selectorBase, input.endpointZero, input.endpointOne, mask);
        u.uSrgb0.value = 1;
        u.uSrgb1.value = 1;
        u.uSrgb2.value = 1;
        u.uSrgb3.value = 1;
        (u.uAdjust0.value as THREE.Vector3).set(0, 1, 1);
        (u.uAdjust1.value as THREE.Vector3).set(0, 1, 1);
        (u.uAdjust2.value as THREE.Vector3).set(0, 1, 1);
        (u.uAdjust3.value as THREE.Vector3).fromArray(input.levels);
        (u.uUv0.value as THREE.Matrix3).copy(IDENTITY3);
        (u.uUv1.value as THREE.Matrix3).copy(IDENTITY3);
        (u.uUv2.value as THREE.Matrix3).copy(IDENTITY3);
        (u.uUv3.value as THREE.Matrix3).copy(IDENTITY3);
        const dest = stickerCoverageQuad({ tl: input.destTl, tr: input.destTr, bl: input.destBl });
        (u.uDestTl.value as THREE.Vector2).fromArray(dest.tl);
        (u.uDestTr.value as THREE.Vector2).fromArray(dest.tr);
        (u.uDestBl.value as THREE.Vector2).fromArray(dest.bl);
        this.renderInto(target);
        return this.toPreviewDataUrl(target, size, false);
      } finally {
        target?.dispose();
        unpin();
      }
    });
  }

  private async composeNow(recipe: RecipeNode, seed: PaintSeed, dimensions?: ComposeDimensions): Promise<ComposeResult> {
    return this.composeResolvedNow(resolveRecipe(recipe, seed), dimensions);
  }

  private prefetchTiers(recipe: ResolvedNode, size: number): void {
    const refs: { ref: string; nearest: boolean }[] = [];
    this.collectRefs(recipe, refs);
    for (const { ref, nearest } of refs) {
      void this.textures.loadTier(ref, size, { nearest }).catch(() => null);
    }
  }

  private composeResolvedNow(resolved: ResolvedNode, dimensions?: ComposeDimensions): Promise<ComposeResult>;
  private composeResolvedNow(resolved: ResolvedNode, dimensions: ComposeDimensions | undefined, cancelled: () => boolean, onPreview?: (result: ComposeResult) => void): Promise<ComposeResult | null>;
  private async composeResolvedNow(resolved: ResolvedNode, dimensions?: ComposeDimensions, cancelled?: () => boolean, onPreview?: (result: ComposeResult) => void): Promise<ComposeResult | null> {
    const fullWidth = dimensions?.width ?? this.renderTargets.width;
    const fullHeight = dimensions?.height ?? this.renderTargets.height;
    const refs: { ref: string; nearest: boolean }[] = [];
    this.collectRefs(resolved, refs);
    const uniqueRefs = [...new Map(refs.map((ref) => [this.textures.keyFor(ref.ref, { nearest: ref.nearest }), ref])).values()];
    // Preload every source texture in parallel, pinned against LRU eviction for
    // the duration of this compose.
    const unpin = this.textures.pin(uniqueRefs.map((r) => this.textures.keyFor(r.ref, { nearest: r.nearest })));
    try {
      const allReady = () => uniqueRefs.every((r) => this.textures.isReady(r.ref, { nearest: r.nearest }));
      const limit = dimensions?.sourceLimit;
      if (limit && !allReady()) {
        await Promise.all(uniqueRefs.map((r) => this.textures.loadTier(r.ref, limit, { nearest: r.nearest }).catch(() => null)));
        if (cancelled?.()) return null;
        this.renderTargets.setOutputSize(fullWidth, fullHeight);
        this.sourceTier = limit;
        try {
          return await this.composeRoot(resolved);
        } finally {
          this.sourceTier = null;
        }
      }
      const pending = Promise.all(uniqueRefs.map((r) => this.textures.load(r.ref, { nearest: r.nearest }).catch(() => null)));
      if (onPreview && !allReady()) {
        for (const tier of PREVIEW_TIERS) {
          await Promise.all(uniqueRefs.map((r) => this.textures.loadTier(r.ref, tier.source, { nearest: r.nearest }).catch(() => null)));
          if (cancelled?.()) return null;
          if (allReady()) break;
          const scale = Math.min(1, tier.output / Math.max(fullWidth, fullHeight));
          this.renderTargets.setOutputSize(fullWidth * scale, fullHeight * scale);
          this.sourceTier = tier.source;
          let preview: ComposeResult;
          try {
            preview = await this.composeRoot(resolved);
          } finally {
            this.sourceTier = null;
          }
          if (cancelled?.()) {
            this.releaseResult(preview);
            return null;
          }
          onPreview(preview);
        }
      }
      this.renderTargets.setOutputSize(fullWidth, fullHeight);
      const loaded = await pending;
      // A newer input may have arrived while the textures were loading.
      if (cancelled?.()) return null;
      // Upload new inputs one task at a time. Left to the first draw, a cold
      // paint uploads them all in one 70-100 ms block that freezes the page.
      for (const texture of loaded) {
        if (!texture || this.uploaded.has(texture)) continue;
        this.renderer.initTexture(texture);
        this.uploaded.add(texture);
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (cancelled?.()) return null;
      }
      return await this.composeRoot(resolved);
    } finally {
      unpin();
    }
  }

  private async composeRoot(resolved: ResolvedNode): Promise<ComposeResult> {
    const result = await this.evaluate(resolved);
    let target = result.target;
    // Nested stages apply their transform when sampled by their parent.
    // The root has no parent, so materialize any remaining transform here.
    if (!target || !isIdentityTransform(result.transform)) {
      target = this.renderTargets.acquire();
      const u = this.material.uniforms;
      u.uMode.value = MODE_TEXTURE;
      this.configureInputs([result], this.constantTextures.constWhite());
      this.renderInto(target);
      if (result.target) this.renderTargets.release(result.target);
    }
    // Bytes are sRGB-encoded by the shader, so the target stays NoColorSpace: an
    // sRGB-tagged pooled target gets a second hardware conversion on later writes and
    // samples. The Viewer decodes once, in map_fragment. Fix colorSpace and wrapping
    // at creation; never re-upload a target after drawing it.
    return { texture: target.texture, target };
  }

  // Recycle a result's target into the pool instead of destroying it.
  releaseResult(result: ComposeResult) {
    this.renderTargets.release(result.target);
  }

  // Read back a composed target as linear [0..1] floats, through a fresh RGBA8 target.
  readPixels(target: THREE.WebGLRenderTarget): Float32Array {
    const width = target.width;
    const height = target.height;
    const byteTarget = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    const u = this.material.uniforms;
    u.uMode.value = MODE_TEXTURE;
    this.setTextures(target.texture, null, null, null);
    u.uSrgb0.value = 1;
    (u.uAdjust0.value as THREE.Vector3).set(0, 1, 1);
    (u.uUv0.value as THREE.Matrix3).copy(IDENTITY3);
    this.renderInto(byteTarget);
    const bytes = new Uint8Array(width * height * 4);
    this.renderer.readRenderTargetPixels(byteTarget, 0, 0, width, height, bytes);
    byteTarget.dispose();
    const out = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const s = bytes[i + c] / 255;
        out[i + c] = s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      }
      out[i + 3] = bytes[i + 3] / 255;
    }
    return out;
  }

  /**
   * Browser-displayable PNG copy of a composed target, for the editor only. Readback
   * row zero is UV v=0, the visual top of these unflipped textures, so rows are
   * copied in their original order. Alpha is a material mask, not transparency, so
   * it is forced opaque or browsers wash the paint out against the checkerboard.
   */
  private toPreviewCanvas(target: THREE.WebGLRenderTarget, maxDimension = 1024, forceOpaque = true): HTMLCanvasElement {
    const width = target.width;
    const height = target.height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new Error('The composed surface has invalid dimensions.');
    }
    const limit = Number.isFinite(maxDimension) ? Math.max(1, Math.floor(maxDimension)) : 1024;
    const scale = Math.min(1, limit / Math.max(width, height));
    const previewWidth = Math.max(1, Math.round(width * scale));
    const previewHeight = Math.max(1, Math.round(height * scale));
    let readTarget = target;
    let scaledTarget: THREE.WebGLRenderTarget | null = null;
    if (scale < 1) {
      scaledTarget = this.renderTargets.makeTarget(previewWidth, previewHeight);
      const u = this.material.uniforms;
      u.uMode.value = MODE_TEXTURE;
      this.setTextures(target.texture, null, null, null);
      u.uSrgb0.value = 1;
      (u.uAdjust0.value as THREE.Vector3).set(0, 1, 1);
      (u.uUv0.value as THREE.Matrix3).copy(IDENTITY3);
      this.renderInto(scaledTarget);
      readTarget = scaledTarget;
    }

    const bytes = new Uint8ClampedArray(previewWidth * previewHeight * 4);
    try {
      this.renderer.readRenderTargetPixels(readTarget, 0, 0, previewWidth, previewHeight, bytes);
    } finally {
      scaledTarget?.dispose();
    }

    const source = document.createElement('canvas');
    source.width = previewWidth;
    source.height = previewHeight;
    const sourceContext = source.getContext('2d');
    if (!sourceContext) throw new Error('The browser could not create a 2D preview canvas.');
    const image = sourceContext.createImageData(previewWidth, previewHeight);
    image.data.set(compositorReadbackToEditorPixels(bytes, previewWidth, previewHeight, forceOpaque));
    sourceContext.putImageData(image, 0, 0);
    return source;
  }

  toPreviewDataUrl(target: THREE.WebGLRenderTarget, maxDimension = 1024, forceOpaque = true): string {
    return this.toPreviewCanvas(target, maxDimension, forceOpaque).toDataURL('image/png');
  }

  /** Browser-displayable PNG without retaining a large base64 string. */
  toPreviewBlob(target: THREE.WebGLRenderTarget, maxDimension = 1024, forceOpaque = true): Promise<Blob> {
    const canvas = this.toPreviewCanvas(target, maxDimension, forceOpaque);
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('The browser could not encode the texture preview.')),
      'image/png',
    ));
  }

  /**
   * Copy a composed target into a texture another WebGL renderer can upload. Unlike
   * toPreviewDataUrl(), alpha is kept: the viewer reads it as TF2's phong mask.
   */
  toTransferTexture(target: THREE.WebGLRenderTarget): THREE.DataTexture {
    const width = target.width;
    const height = target.height;
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new Error('The composed surface has invalid dimensions.');
    }
    const bytes = new Uint8Array(width * height * 4);
    this.renderer.readRenderTargetPixels(target, 0, 0, width, height, bytes);
    const texture = new THREE.DataTexture(bytes, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.flipY = false;
    // The TF2 viewer shader performs the sRGB decode itself while retaining
    // the untouched alpha channel as material data.
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    return texture;
  }

  getSize() {
    return this.renderTargets.width;
  }

  /** Drop package-owned uploads when the Source filesystem is replaced. */
  invalidateTextures() {
    this.textures.dispose();
  }

  dispose() {
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.renderTargets.dispose();
    this.textures.dispose();
    this.material.dispose();
    (this.quad.geometry as THREE.BufferGeometry).dispose();
    this.constantTextures.dispose();
    if (this.ownsRenderer) this.renderer.dispose();
  }
}
