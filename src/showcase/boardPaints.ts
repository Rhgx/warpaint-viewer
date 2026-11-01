import * as THREE from 'three';
import { configureTf2Material } from '../viewer/materialConfig';
import type { WeaponMaterial } from '../data/types';
import type { ComposeResult, Compositor } from '../compositor/compositor';
import type { ItemRuntime, ShowcaseBoardOptions } from './showcaseTypes';

// Paints and material maps for the weapons on the showcase board, kept apart from the board's own state.

/** Paint resolutions, never larger than the weapon is drawn on screen or in an export. */
const PAINT_SIZE = { min: 256, max: 1024 };
/** Sources are never decoded below this: decoding costs the same at any size, so one shared size decodes each texture once. */
export const MIN_SOURCE_SIZE = 512;
/** Paint texels per drawn pixel along the weapon; its side covers only part of the paint. */
const PAINT_TEXELS_PER_PIXEL = 1.25;

/** What paint and material work reads from the board that owns it. */
export interface BoardPaintsHost {
  readonly options: ShowcaseBoardOptions;
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.OrthographicCamera;
  readonly compositor: Compositor;
  readonly runtimes: ReadonlyMap<string, ItemRuntime>;
  readonly boardHeight: number;
  /** The default cubemap is replaced when the environment loads, so read it on each use. */
  readonly getEnvMap: () => THREE.CubeTexture;
  readonly isDisposed: () => boolean;
  readonly markDirty: () => void;
}

export class BoardPaints {
  private readonly host: BoardPaintsHost;
  readonly #materialMaps = new Map<string, Promise<THREE.Texture | null>>();
  readonly #cubemaps = new Map<string, Promise<THREE.CubeTexture | null>>();
  /** Composited paints by paint key, shared by every item wearing the same one. */
  readonly #paints = new Map<string, Promise<ComposeResult | null>>();
  /** Lower-detail composites on show while a paint streams in, by paint key. */
  readonly #previews = new Map<string, ComposeResult>();
  readonly #retiredPreviews = new Set<ComposeResult>();
  #paintSweep = 0;

  constructor(host: BoardPaintsHost) {
    this.host = host;
  }

  /** The paint a key is still composing or has finished, which the board waits on before it exports. */
  pendingPaint(key: string): Promise<ComposeResult | null> | undefined {
    return this.#paints.get(key);
  }

  /** Cancels the pending sweep when the board is disposed. */
  cancelSweep(): void {
    window.clearTimeout(this.#paintSweep);
  }

  /** A material map, loaded once and shared by every weapon that uses it. */
  #materialMap(ref: string, wrap: THREE.Wrapping): Promise<THREE.Texture | null> {
    const key = `${wrap}|${ref}`;
    let pending = this.#materialMaps.get(key);
    if (!pending) {
      pending = Promise.resolve(this.host.options.resolveTexture(ref))
        .then((url) => new THREE.TextureLoader().loadAsync(url))
        .then((texture) => {
          // Raw data in glTF UV space, like the composite.
          texture.flipY = false;
          texture.colorSpace = THREE.NoColorSpace;
          texture.wrapS = texture.wrapT = wrap;
          return texture;
        })
        .catch(() => null);
      this.#materialMaps.set(key, pending);
    }
    return pending;
  }

  #cubemap(ref: string): Promise<THREE.CubeTexture | null> {
    let pending = this.#cubemaps.get(ref);
    if (!pending) {
      pending = this.host.options.resolveCubemap(ref)
        .then((urls) => (urls ? new THREE.CubeTextureLoader().loadAsync(urls) : null))
        .then((texture) => {
          if (texture) texture.colorSpace = THREE.SRGBColorSpace;
          return texture;
        })
        .catch(() => null);
      this.#cubemaps.set(ref, pending);
    }
    return pending;
  }

  /** Set up the TF2 shader for the weapon's material under its paint, as the viewer does. */
  #applyMaterial(runtime: ItemRuntime): void {
    const { weaponKey, paint } = runtime.item;
    const weapon = this.host.options.weapons.find((entry) => entry.key === weaponKey);
    const source = this.host.options.materialOverride(weaponKey, paint.kitId) ?? weapon?.material;
    if (!source) return;
    const key = JSON.stringify(source);
    if (runtime.materialKey === key) return;
    runtime.materialKey = key;
    const { material, uniforms } = runtime;
    configureTf2Material(source, material, uniforms);
    material.normalMap = null;
    uniforms.uTf2UseExponentMap.value = 0;
    uniforms.uTf2UseLightwarp.value = 0;
    uniforms.uTf2UseSelfIllumMask.value = 0;
    uniforms.uTf2ExponentMap.value = null;
    uniforms.uTf2LightwarpMap.value = null;
    uniforms.uTf2SelfIllumMaskMap.value = null;
    uniforms.uTf2DetailMap.value = null;
    material.envMap = this.host.getEnvMap();
    this.host.markDirty();
    runtime.materialReady = this.#loadMaterialMaps(runtime, source, key);
  }

  async #loadMaterialMaps(runtime: ItemRuntime, source: WeaponMaterial, key: string): Promise<void> {
    const { material, uniforms } = runtime;
    const [normal, exponent, lightwarp, selfIllum, detail, envMap] = await Promise.all([
      source.normalMap ? this.#materialMap(source.normalMap, THREE.RepeatWrapping) : null,
      source.phongExponentTexture ? this.#materialMap(source.phongExponentTexture, THREE.RepeatWrapping) : null,
      // The diffuse-warp ramp is read clamped and without sRGB decode, as in Source.
      source.lightwarpTexture ? this.#materialMap(source.lightwarpTexture, THREE.ClampToEdgeWrapping) : null,
      source.selfIllumMask ? this.#materialMap(source.selfIllumMask, THREE.RepeatWrapping) : null,
      source.detailTexture ? this.#materialMap(source.detailTexture, THREE.RepeatWrapping) : null,
      source.envmapTexture ? this.#cubemap(source.envmapTexture) : null,
    ]);
    if (this.host.isDisposed() || runtime.materialKey !== key) return;
    if (normal) {
      material.normalMap = normal;
      // Source normal maps use the DirectX (green-down) convention.
      material.normalScale.set(1, -1);
    }
    if (exponent) {
      uniforms.uTf2ExponentMap.value = exponent;
      uniforms.uTf2UseExponentMap.value = 1;
    }
    if (lightwarp) {
      uniforms.uTf2LightwarpMap.value = lightwarp;
      uniforms.uTf2UseLightwarp.value = 1;
    }
    if (selfIllum) {
      uniforms.uTf2SelfIllumMaskMap.value = selfIllum;
      uniforms.uTf2UseSelfIllumMask.value = 1;
    }
    uniforms.uTf2DetailMap.value = detail;
    material.envMap = envMap ?? this.host.getEnvMap();
    runtime.customEnvMap = !!envMap;
    material.needsUpdate = true;
    this.host.markDirty();
  }

  /** Board units to drawing-buffer pixels at the current framing. */
  pixelsPerUnit(): number {
    return this.host.renderer.domElement.width / Math.max(1, this.host.camera.right - this.host.camera.left);
  }

  /** The paint resolution a weapon needs when drawn at `pixelsPerUnit`. */
  #paintSizeFor(runtime: ItemRuntime, pixelsPerUnit: number): number {
    const footprint = runtime.footprint;
    const drawn = (footprint ? Math.max(footprint.width, footprint.height) : this.host.boardHeight / 2) * pixelsPerUnit * PAINT_TEXELS_PER_PIXEL;
    return THREE.MathUtils.clamp(2 ** Math.ceil(Math.log2(Math.max(1, drawn))), PAINT_SIZE.min, PAINT_SIZE.max);
  }

  /** Give weapons drawn larger than their paint a sharper one. */
  sharpenPaints(pixelsPerUnit = this.pixelsPerUnit()): void {
    for (const runtime of this.host.runtimes.values()) {
      if (runtime.paintKey && this.#paintSizeFor(runtime, pixelsPerUnit) > runtime.paintSize) void this.applyPaint(runtime, pixelsPerUnit);
    }
  }

  async applyPaint(runtime: ItemRuntime, pixelsPerUnit = this.pixelsPerUnit()): Promise<void> {
    this.#applyMaterial(runtime);
    const { kitId, team, wearIndex, seed } = runtime.item.paint;
    // Never smaller than before: shrinking would compose again only to look worse.
    const size = Math.max(runtime.paintSize, this.#paintSizeFor(runtime, pixelsPerUnit));
    const key = `${kitId}|${runtime.item.weaponKey}|${team}|${wearIndex}|${seed}|${size}`;
    if (runtime.paintKey === key) return;
    runtime.paintKey = key;
    runtime.paintSize = size;
    let pending = this.#paints.get(key);
    if (!pending) {
      pending = (async () => {
        const recipe = await this.host.options.resolveRecipe(kitId, runtime.item.weaponKey, team, wearIndex);
        if (!recipe) return null;
        // Like the viewer, a paint shows at rising detail while its textures stream in.
        const result = await this.host.compositor.composeLatest(`showcase:${key}`, recipe, seed, { width: size, height: size, sourceLimit: Math.max(size, MIN_SOURCE_SIZE) },
          () => this.host.isDisposed(), (preview) => this.#showPreview(key, preview));
        this.#wearPaint(key, result?.texture ?? null);
        return result;
      })().catch((cause) => {
        console.error('[showcase] compose failed', key, cause);
        return null;
      });
      this.#paints.set(key, pending);
    }
    // Joining a paint that is still streaming in: show the detail it has reached.
    const preview = this.#previews.get(key);
    if (preview) this.#setMap(runtime, preview.texture);
    const texture = (await pending)?.texture ?? null;
    this.sweepPaints();
    // A newer paint on the same item may have finished first.
    if (this.host.isDisposed() || runtime.paintKey !== key) return;
    this.#setMap(runtime, texture);
  }

  #setMap(runtime: ItemRuntime, texture: THREE.Texture | null): void {
    const { material } = runtime;
    // Going from no map to a map (or back) changes the shader; swapping one for another does not.
    if (!material.map !== !texture) material.needsUpdate = true;
    material.map = texture;
    material.color.set(texture ? 0xffffff : 0x9a9a9a);
    this.host.markDirty();
    this.releaseRetiredPreviews();
  }

  /** Put a paint on every weapon wearing it, then free the preview it replaces. */
  #wearPaint(key: string, texture: THREE.Texture | null): void {
    if (this.host.isDisposed()) return;
    for (const runtime of this.host.runtimes.values()) if (runtime.paintKey === key) this.#setMap(runtime, texture);
    this.#dropPreview(key);
  }

  #showPreview(key: string, preview: ComposeResult): void {
    const wearers = [...this.host.runtimes.values()].filter((runtime) => runtime.paintKey === key);
    if (this.host.isDisposed() || !wearers.length) {
      this.host.compositor.releaseResult(preview);
      return;
    }
    for (const runtime of wearers) this.#setMap(runtime, preview.texture);
    this.#dropPreview(key);
    this.#previews.set(key, preview);
  }

  #dropPreview(key: string): void {
    const preview = this.#previews.get(key);
    if (!preview) return;
    this.#previews.delete(key);
    this.#retiredPreviews.add(preview);
    this.releaseRetiredPreviews();
  }

  /**
   * Recycle replaced previews once no weapon shows them; one that switched
   * paint mid-stream keeps its last preview until the new paint arrives.
   */
  releaseRetiredPreviews(): void {
    for (const preview of this.#retiredPreviews) {
      if ([...this.host.runtimes.values()].some((runtime) => runtime.material.map === preview.texture)) continue;
      this.#retiredPreviews.delete(preview);
      this.host.compositor.releaseResult(preview);
    }
  }

  /** Free composites no item wears once the change settles, so trying seeds does not pile up render targets. */
  sweepPaints(): void {
    window.clearTimeout(this.#paintSweep);
    this.#paintSweep = window.setTimeout(() => {
      if (this.host.isDisposed()) return;
      const worn = new Set([...this.host.runtimes.values()].map((runtime) => runtime.paintKey));
      for (const [key, pending] of this.#paints) {
        if (worn.has(key)) continue;
        this.#dropPreview(key);
        this.#paints.delete(key);
        // A weapon keeps showing its old paint until the new one is ready.
        void pending.then((result) => {
          if (!result || this.host.isDisposed()) return;
          this.#retiredPreviews.add(result);
          this.releaseRetiredPreviews();
        });
      }
    }, 0);
  }
}
