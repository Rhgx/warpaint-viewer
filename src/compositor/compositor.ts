import * as THREE from 'three';
import type { PaintSeed, RecipeNode, TextureResolver } from './types';
import type { ResolvedNode, ResolvedTransform } from './resolve';
import { resolveRecipe } from './resolve';
import { TextureCache } from './textureCache';
import type { TextureMetadata } from '../data/types';
import {
  FRAG,
  VERT,
  MODE_ADD,
  MODE_BLEND,
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
}

const IDENTITY3 = new THREE.Matrix3();
const IDENTITY_TRANSFORM: ResolvedTransform = {
  black: 0, white: 1, gamma: 1,
  rotationDeg: 0, translateU: 0, translateV: 0, scale: 1,
  flipU: false, flipV: false,
};

interface EvaluatedInput {
  texture: THREE.Texture;
  transform: ResolvedTransform;
  target: THREE.WebGLRenderTarget | null;
}

// Reimplements TF2's paintkit compositor on the GPU via three.js render targets,
// sharing the viewer's WebGL context. Evaluates a resolved stage tree bottom-up
// into ping-ponged 8-bit sRGB render targets, with shader math in linear space.
export class Compositor {
  private renderer: THREE.WebGLRenderer;
  private ownsRenderer: boolean;
  private width: number;
  private height: number;
  private textures: TextureCache;

  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.RawShaderMaterial;
  private quad: THREE.Mesh;

  // pool of scratch sRGB-encoded 8-bit render targets
  private pool: THREE.WebGLRenderTarget[] = [];
  // The compositor owns one shader/uniform set and render-target pool. Serializing
  // requests prevents rapid wear/seed changes from interleaving GPU passes.
  private composeQueue: Promise<void> = Promise.resolve();

  constructor(resolver: TextureResolver, opts: CompositorOptions & { renderer?: THREE.WebGLRenderer } = {}) {
    this.width = this.height = opts.size ?? 1024;
    this.textures = new TextureCache(resolver, undefined, opts.textureMetadata, opts.textureMetadataResolver);
    if (opts.renderer) {
      this.renderer = opts.renderer;
      this.ownsRenderer = false;
    } else {
      this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
      this.ownsRenderer = true;
    }

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
  }

  private makeTarget(): THREE.WebGLRenderTarget {
    const t = new THREE.WebGLRenderTarget(this.width, this.height, {
      // TF2 composites into an 8-bit target. Matching that format also halves
      // render-target bandwidth and memory versus the previous half-float path.
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      magFilter: THREE.LinearFilter,
      minFilter: THREE.LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    t.texture.wrapS = THREE.RepeatWrapping;
    t.texture.wrapT = THREE.RepeatWrapping;
    return t;
  }

  private acquire(): THREE.WebGLRenderTarget {
    return this.pool.pop() ?? this.makeTarget();
  }

  private release(t: THREE.WebGLRenderTarget) {
    if (t.width === this.width && t.height === this.height) this.pool.push(t);
    else t.dispose();
  }

  private setOutputSize(width: number, height: number) {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.width && nextHeight === this.height) return;
    for (const target of this.pool) target.dispose();
    this.pool.length = 0;
    this.width = nextWidth;
    this.height = nextHeight;
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
        out.push({ ref: node.groups, nearest: false });
        break;
      case 'apply_sticker':
        out.push({ ref: node.base, nearest: false });
        if (node.spec) out.push({ ref: node.spec, nearest: false });
        node.nodes.forEach((n) => this.collectRefs(n, out));
        break;
    }
  }

  // Gather refs from the unresolved recipe as well. This includes every
  // weighted sticker alternative, so a later seed change cannot discover a
  // new image and stall on decode/upload during composition.
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
        out.push({ ref: node.groups, nearest: false });
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

  // Decode and upload all possible inputs while the current paint is already
  // visible. The compositor remains GPU-native; no pixel buffers cross back to
  // JavaScript, a Worker, or WASM.
  async preload(recipe: RecipeNode): Promise<void> {
    const refs: { ref: string; nearest: boolean }[] = [];
    this.collectRecipeRefs(recipe, refs);
    const unique = [...new Map(refs.map((ref) => [this.textures.keyFor(ref.ref, { nearest: ref.nearest }), ref])).values()];
    const keys = unique.map((ref) => this.textures.keyFor(ref.ref, { nearest: ref.nearest }));
    const unpin = this.textures.pin(keys);
    try {
      const loaded = await Promise.all(unique.map((ref) => this.textures.load(ref.ref, { nearest: ref.nearest }).catch(() => null)));
      for (const texture of loaded) if (texture) this.renderer.initTexture(texture);
    } finally {
      unpin();
    }
  }

  private renderInto(target: THREE.WebGLRenderTarget) {
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(prev);
  }

  private uvMatrix(rotationDeg: number, tu: number, tv: number, scale: number, flipU: boolean, flipV: boolean): THREE.Matrix3 {
    // uv' = translate + R * S * (uv - 0.5) + 0.5, applied to a homogeneous vec3.
    const rad = (rotationDeg * Math.PI) / 180;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const sx = scale * (flipU ? -1 : 1);
    const sy = scale * (flipV ? -1 : 1);
    // Compose about center 0.5,0.5 then translate.
    const m = new THREE.Matrix3();
    // column-major set(): three's Matrix3.set takes row-major args.
    // Build M = T(0.5+tu,0.5+tv) * R * S * T(-0.5,-0.5)
    const t1 = new THREE.Matrix3().set(1, 0, -0.5, 0, 1, -0.5, 0, 0, 1);
    const S = new THREE.Matrix3().set(sx, 0, 0, 0, sy, 0, 0, 0, 1);
    const R = new THREE.Matrix3().set(c, -s, 0, s, c, 0, 0, 0, 1);
    const t2 = new THREE.Matrix3().set(1, 0, 0.5 + tu, 0, 1, 0.5 + tv, 0, 0, 1);
    m.multiplyMatrices(t2, R);
    m.multiply(S);
    m.multiply(t1);
    return m;
  }

  // Set ALL sampler uniforms for a pass. Unused slots get a dummy texture.
  // CRITICAL: the fragment shader declares uTex0/1/2 as active samplers in every
  // mode, so three.js binds whatever the uniforms reference on EVERY draw. If a
  // stale uniform still points at a pooled render target that a later pass
  // renders INTO, WebGL detects a framebuffer feedback loop, raises
  // INVALID_OPERATION, skips the draw, and the target stays cleared-to-black.
  // That corrupted every composite after the first until this was added.
  private setTextures(t0: THREE.Texture, t1: THREE.Texture | null, t2: THREE.Texture | null, t3: THREE.Texture | null = null) {
    const u = this.material.uniforms;
    u.uTex0.value = t0;
    u.uTex1.value = t1 ?? this.dummyTex();
    u.uTex2.value = t2 ?? this.dummyTex();
    u.uTex3.value = t3 ?? this.dummyTex();
  }

  private _dummy: THREE.DataTexture | null = null;
  private dummyTex(): THREE.DataTexture {
    if (!this._dummy) {
      const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      this._dummy = t;
    }
    return this._dummy;
  }

  private _constWhite: THREE.DataTexture | null = null;
  private constWhite(): THREE.DataTexture {
    if (!this._constWhite) {
      const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      this._constWhite = t;
    }
    return this._constWhite;
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
        this.uvMatrix(t.rotationDeg, t.translateU, t.translateV, t.scale, t.flipU, t.flipV),
      );
    });
  }

  private releaseInputs(inputs: EvaluatedInput[]) {
    const released = new Set<THREE.WebGLRenderTarget>();
    for (const input of inputs) {
      if (input.target && !released.has(input.target)) {
        released.add(input.target);
        this.release(input.target);
      }
    }
  }

  private async evaluate(node: ResolvedNode): Promise<EvaluatedInput> {
    const u = this.material.uniforms;
    switch (node.type) {
      case 'texture_lookup': {
        const tex = await this.textures.load(node.texture);
        // Source feeds texture leaves directly into their parent compositor
        // stage. Keeping the transform/levels as sampler state avoids an extra
        // RGBA8 quantization pass for every transformed lookup.
        return { texture: tex, transform: node, target: null };
      }
      case 'combine_multiply':
      case 'combine_add':
      case 'combine_lerp': {
        const children = await Promise.all(node.nodes.map((child) => this.evaluate(child)));
        let result: THREE.WebGLRenderTarget;
        if (node.type === 'combine_lerp') {
          const out = this.acquire();
          u.uMode.value = MODE_LERP;
          const lerpInputs = [
            children[0],
            children[1] ?? children[0],
            children[2] ?? { texture: this.constHalf(), transform: IDENTITY_TRANSFORM, target: null },
          ].filter(Boolean) as EvaluatedInput[];
          this.configureInputs(lerpInputs, this.constWhite());
          this.renderInto(out);
          result = out;
        } else {
          const mode = node.type === 'combine_multiply' ? MODE_MULTIPLY : MODE_ADD;
          const safe = node.type === 'combine_multiply' ? this.constWhite() : this.constZero();
          let pending = [...children];
          let previous: EvaluatedInput | null = null;
          do {
            const capacity = previous ? 3 : 4;
            const batch = pending.splice(0, capacity);
            if (previous) batch.unshift(previous);
            const out = this.acquire();
            u.uMode.value = mode;
            this.configureInputs(batch, safe);
            this.renderInto(out);
            if (previous?.target) this.release(previous.target);
            previous = { texture: out.texture, transform: IDENTITY_TRANSFORM, target: out };
          } while (pending.length);
          result = previous!.target!;
        }
        this.releaseInputs(children);
        return { texture: result.texture, transform: node, target: result };
      }
      case 'select': {
        const groups = await this.textures.load(node.groups);
        const out = this.acquire();
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
        const sticker = await this.textures.load(node.base);
        const stickerSpec = node.spec ? await this.textures.load(node.spec) : null;
        const out = this.acquire();
        u.uMode.value = MODE_BLEND;
        // CTCApplyStickerStage binds black when the optional implicit `_s`
        // texture is unavailable. Black writes a zero phong mask, so stickers
        // without a spec map (such as Sandwich Diner) stay matte.
        this.setTextures(base.texture, sticker, stickerSpec ?? this.dummyTex(), null);
        const t = base.transform;
        u.uSrgb0.value = 1;
        u.uSrgb1.value = 1;
        u.uSrgb2.value = 1;
        (u.uAdjust0.value as THREE.Vector3).set(t.black, t.white, t.gamma);
        (u.uUv0.value as THREE.Matrix3).copy(
          this.uvMatrix(t.rotationDeg, t.translateU, t.translateV, t.scale, t.flipU, t.flipV),
        );
        (u.uAdjust1.value as THREE.Vector3).set(node.black, node.white, node.gamma);
        (u.uDestTl.value as THREE.Vector2).set(node.destTl[0], node.destTl[1]);
        (u.uDestTr.value as THREE.Vector2).set(node.destTr[0], node.destTr[1]);
        (u.uDestBl.value as THREE.Vector2).set(node.destBl[0], node.destBl[1]);
        this.renderInto(out);
        if (base.target) this.release(base.target);
        return { texture: out.texture, transform: IDENTITY_TRANSFORM, target: out };
      }
    }
  }

  private _constHalf: THREE.DataTexture | null = null;
  private constHalf(): THREE.DataTexture {
    if (!this._constHalf) {
      const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      this._constHalf = t;
    }
    return this._constHalf;
  }

  private _constZero: THREE.DataTexture | null = null;
  private constZero(): THREE.DataTexture {
    if (!this._constZero) {
      const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      this._constZero = t;
    }
    return this._constZero;
  }

  // Compose a recipe at a seed. Returns a target the caller owns; return it via
  // releaseResult() (preferred, recycles into the pool) or dispose it.
  compose(recipe: RecipeNode, seed: PaintSeed, dimensions?: ComposeDimensions): Promise<ComposeResult> {
    const task = this.composeQueue.then(() => this.composeNow(recipe, seed, dimensions));
    this.composeQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async composeNow(recipe: RecipeNode, seed: PaintSeed, dimensions?: ComposeDimensions): Promise<ComposeResult> {
    if (dimensions) this.setOutputSize(dimensions.width, dimensions.height);
    const resolved = resolveRecipe(recipe, seed);
    const refs: { ref: string; nearest: boolean }[] = [];
    this.collectRefs(resolved, refs);
    const uniqueRefs = [...new Map(refs.map((ref) => [this.textures.keyFor(ref.ref, { nearest: ref.nearest }), ref])).values()];
    // Preload every source texture in parallel, pinned against LRU eviction for
    // the duration of this compose.
    const unpin = this.textures.pin(uniqueRefs.map((r) => this.textures.keyFor(r.ref, { nearest: r.nearest })));
    try {
      await Promise.all(uniqueRefs.map((r) => this.textures.load(r.ref, { nearest: r.nearest }).catch(() => null)));
      const result = await this.evaluate(resolved);
      let target = result.target;
      if (!target) {
        target = this.acquire();
        const u = this.material.uniforms;
        u.uMode.value = MODE_TEXTURE;
        this.configureInputs([result], this.constWhite());
        this.renderInto(target);
      }
      // RGB bytes are sRGB-encoded by the compositor shader, but the target
      // must remain NoColorSpace. Marking a pooled render target as sRGB makes
      // WebGL perform a second hardware conversion on later writes/samples.
      // Viewer decodes these stored bytes exactly once in map_fragment.
      // colorSpace and wrapping are fixed when the pooled target is created;
      // never mutate/re-upload a render-target texture after drawing it.
      return { texture: target.texture, target };
    } finally {
      unpin();
    }
  }

  // Recycle a compose result's render target instead of destroying it, so the
  // next compose allocates nothing.
  releaseResult(result: ComposeResult) {
    this.release(result.target);
  }

  // Read back RGBA of a composed target as normalized [0..1] floats. Copies the
  // (half-float) target into an 8-bit target first so readback works on every
  // device regardless of EXT_color_buffer_float support. ~1/255 precision is
  // plenty for the selftest's math assertions.
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

  getRenderer() {
    return this.renderer;
  }
  getSize() {
    return this.width;
  }

  /** Drop package-owned uploads when the Source filesystem is replaced. */
  invalidateTextures() {
    this.textures.dispose();
  }

  dispose() {
    this.pool.forEach((t) => t.dispose());
    this.pool = [];
    this.textures.dispose();
    this.material.dispose();
    (this.quad.geometry as THREE.BufferGeometry).dispose();
    if (this._constHalf) this._constHalf.dispose();
    if (this._constWhite) this._constWhite.dispose();
    if (this._constZero) this._constZero.dispose();
    if (this._dummy) this._dummy.dispose();
    if (this.ownsRenderer) this.renderer.dispose();
  }
}
