import * as THREE from 'three';
import type { RecipeNode, TextureResolver } from './types';
import type { ResolvedNode } from './resolve';
import { resolveRecipe, isIdentityTransform } from './resolve';
import { TextureCache } from './textureCache';
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
  texture: THREE.Texture; // linear-space composited RGBA, usable as a material map
  target: THREE.WebGLRenderTarget; // owns texture; caller disposes when replaced
}

export interface CompositorOptions {
  size?: number; // square, default 1024
}

const IDENTITY3 = new THREE.Matrix3();

// Reimplements TF2's paintkit compositor on the GPU via three.js render targets,
// sharing the viewer's WebGL context. Evaluates a resolved stage tree bottom-up
// into ping-ponged float render targets, all math in linear space.
export class Compositor {
  private renderer: THREE.WebGLRenderer;
  private ownsRenderer: boolean;
  private size: number;
  private textures: TextureCache;

  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private material: THREE.RawShaderMaterial;
  private quad: THREE.Mesh;

  // pool of scratch render targets
  private pool: THREE.WebGLRenderTarget[] = [];

  constructor(resolver: TextureResolver, opts: CompositorOptions & { renderer?: THREE.WebGLRenderer } = {}) {
    this.size = opts.size ?? 1024;
    this.textures = new TextureCache(resolver);
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
        uAdjust0: { value: new THREE.Vector3(0, 1, 1) },
        uAdjust1: { value: new THREE.Vector3(0, 1, 1) },
        uAdjust2: { value: new THREE.Vector3(0, 1, 1) },
        uSrgb0: { value: 0 },
        uSrgb1: { value: 0 },
        uSrgb2: { value: 0 },
        uUv0: { value: new THREE.Matrix3() },
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
    const t = new THREE.WebGLRenderTarget(this.size, this.size, {
      type: THREE.HalfFloatType, // linear precision for intermediate stages
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
    this.pool.push(t);
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
        out.push({ ref: node.groups, nearest: true });
        break;
      case 'apply_sticker':
        out.push({ ref: node.base, nearest: false });
        node.nodes.forEach((n) => this.collectRefs(n, out));
        break;
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
  private setTextures(t0: THREE.Texture, t1: THREE.Texture | null, t2: THREE.Texture | null) {
    const u = this.material.uniforms;
    u.uTex0.value = t0;
    u.uTex1.value = t1 ?? this.dummyTex();
    u.uTex2.value = t2 ?? this.dummyTex();
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

  private async evaluate(node: ResolvedNode): Promise<THREE.WebGLRenderTarget> {
    const u = this.material.uniforms;
    switch (node.type) {
      case 'texture_lookup': {
        const tex = await this.textures.load(node.texture);
        const out = this.acquire();
        u.uMode.value = MODE_TEXTURE;
        this.setTextures(tex, null, null);
        u.uSrgb0.value = 1;
        (u.uAdjust0.value as THREE.Vector3).set(node.black, node.white, node.gamma);
        (u.uUv0.value as THREE.Matrix3).copy(
          this.uvMatrix(node.rotationDeg, node.translateU, node.translateV, node.scale, node.flipU, node.flipV),
        );
        this.renderInto(out);
        return out;
      }
      case 'combine_multiply':
      case 'combine_add':
      case 'combine_lerp': {
        let result: THREE.WebGLRenderTarget;
        if (node.type === 'combine_lerp') {
          // Exactly 3 inputs: c0, c1, selector (fxc main_lerp).
          const a = await this.evaluate(node.nodes[0]);
          const b = node.nodes[1] ? await this.evaluate(node.nodes[1]) : null;
          const cSel = node.nodes[2] ? await this.evaluate(node.nodes[2]) : null;
          const out = this.acquire();
          u.uMode.value = MODE_LERP;
          // Defensive: a malformed 2-node lerp falls back to a constant 0.5 mix.
          this.setTextures(a.texture, b ? b.texture : a.texture, cSel ? cSel.texture : this.constHalf());
          u.uSrgb0.value = 0;
          u.uSrgb1.value = 0;
          u.uSrgb2.value = 0;
          (u.uAdjust0.value as THREE.Vector3).set(0, 1, 1);
          (u.uAdjust1.value as THREE.Vector3).set(0, 1, 1);
          (u.uAdjust2.value as THREE.Vector3).set(0, 1, 1);
          this.renderInto(out);
          this.release(a);
          if (b) this.release(b);
          if (cSel) this.release(cSel);
          result = out;
        } else {
          // Multiply/Add are n-ary in real data (the engine batches 4 inputs
          // per pass and chains passes); both ops are associative, and each
          // input's own adjust/transform is already baked into its target, so
          // pairwise folding is exact.
          const mode = node.type === 'combine_multiply' ? MODE_MULTIPLY : MODE_ADD;
          result = await this.evaluate(node.nodes[0]);
          for (let i = 1; i < node.nodes.length; i++) {
            const rhs = await this.evaluate(node.nodes[i]);
            const out = this.acquire();
            u.uMode.value = mode;
            this.setTextures(result.texture, rhs.texture, null);
            u.uSrgb0.value = 0;
            u.uSrgb1.value = 0;
            (u.uAdjust0.value as THREE.Vector3).set(0, 1, 1);
            (u.uAdjust1.value as THREE.Vector3).set(0, 1, 1);
            this.renderInto(out);
            this.release(result);
            this.release(rhs);
            result = out;
          }
        }
        // A combine stage's own transform/adjust describe how ITS output is
        // sampled by the parent (per-input TEXTRANSFORM/TEXADJUSTLEVELS in
        // compositor.cpp); apply them as a post-pass when non-identity.
        if (!isIdentityTransform(node)) {
          const out = this.acquire();
          u.uMode.value = MODE_TEXTURE;
          this.setTextures(result.texture, null, null);
          u.uSrgb0.value = 0;
          (u.uAdjust0.value as THREE.Vector3).set(node.black, node.white, node.gamma);
          (u.uUv0.value as THREE.Matrix3).copy(
            this.uvMatrix(node.rotationDeg, node.translateU, node.translateV, node.scale, node.flipU, node.flipV),
          );
          this.renderInto(out);
          this.release(result);
          result = out;
        }
        return result;
      }
      case 'select': {
        const groups = await this.textures.load(node.groups, { nearest: true });
        const out = this.acquire();
        u.uMode.value = MODE_SELECT;
        this.setTextures(groups, null, null);
        u.uSrgb0.value = 0;
        // Raw 0..255 group ids scaled by cFac = 1/16 exactly as compositor.cpp
        // does before uploading cSelectValues.
        const arr = u.uSelect.value as number[];
        for (let i = 0; i < 16; i++) arr[i] = i < node.select.length ? node.select[i] / 16 : 0;
        u.uNumSelect.value = Math.min(16, node.select.length);
        this.renderInto(out);
        return out;
      }
      case 'apply_sticker': {
        const base = await this.evaluate(node.nodes[0]);
        const sticker = await this.textures.load(node.base);
        const out = this.acquire();
        u.uMode.value = MODE_BLEND;
        this.setTextures(base.texture, sticker, null);
        u.uSrgb0.value = 0;
        u.uSrgb1.value = 1;
        (u.uAdjust1.value as THREE.Vector3).set(node.black, node.white, node.gamma);
        (u.uDestTl.value as THREE.Vector2).set(node.destTl[0], node.destTl[1]);
        (u.uDestTr.value as THREE.Vector2).set(node.destTr[0], node.destTr[1]);
        (u.uDestBl.value as THREE.Vector2).set(node.destBl[0], node.destBl[1]);
        this.renderInto(out);
        this.release(base);
        return out;
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

  // Compose a recipe at a seed. Returns a target the caller owns; return it via
  // releaseResult() (preferred, recycles into the pool) or dispose it.
  async compose(recipe: RecipeNode, seed: number): Promise<ComposeResult> {
    const resolved = resolveRecipe(recipe, seed);
    const refs: { ref: string; nearest: boolean }[] = [];
    this.collectRefs(resolved, refs);
    // Preload every source texture in parallel, pinned against LRU eviction for
    // the duration of this compose.
    const unpin = this.textures.pin(refs.map((r) => this.textures.keyFor(r.ref, { nearest: r.nearest })));
    try {
      await Promise.all(refs.map((r) => this.textures.load(r.ref, { nearest: r.nearest }).catch(() => null)));
      const result = await this.evaluate(resolved);
      result.texture.colorSpace = THREE.NoColorSpace; // already linear albedo
      result.texture.wrapS = THREE.RepeatWrapping;
      result.texture.wrapT = THREE.RepeatWrapping;
      result.texture.needsUpdate = true;
      return { texture: result.texture, target: result };
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
    const byteTarget = new THREE.WebGLRenderTarget(this.size, this.size, {
      type: THREE.UnsignedByteType,
      format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    const u = this.material.uniforms;
    u.uMode.value = MODE_TEXTURE;
    this.setTextures(target.texture, null, null);
    u.uSrgb0.value = 0;
    (u.uAdjust0.value as THREE.Vector3).set(0, 1, 1);
    (u.uUv0.value as THREE.Matrix3).copy(IDENTITY3);
    this.renderInto(byteTarget);
    const bytes = new Uint8Array(this.size * this.size * 4);
    this.renderer.readRenderTargetPixels(byteTarget, 0, 0, this.size, this.size, bytes);
    byteTarget.dispose();
    const out = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
    return out;
  }

  getRenderer() {
    return this.renderer;
  }
  getSize() {
    return this.size;
  }

  dispose() {
    this.pool.forEach((t) => t.dispose());
    this.pool = [];
    this.textures.dispose();
    this.material.dispose();
    (this.quad.geometry as THREE.BufferGeometry).dispose();
    if (this._constHalf) this._constHalf.dispose();
    if (this._dummy) this._dummy.dispose();
    if (this.ownsRenderer) this.renderer.dispose();
  }
}
