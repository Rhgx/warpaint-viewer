import * as THREE from 'three';
import type { WeaponMaterial } from '../data/types';
import { configureTf2Material, type Tf2Uniforms } from './materialConfig';
import { textureCacheBudgetBytes } from '../compositor/textureCache';
import type { EmissiveOverlay } from './overlays/emissiveOverlay';

/**
 * Decoded off the main thread and raw, like the compositor's sources. Through an <img>,
 * a large map decodes inside its first upload: up to 370 ms of frozen page on a modest PC.
 */
async function loadBitmapTexture(url: string): Promise<THREE.Texture> {
  const bitmap = await new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'none', premultiplyAlpha: 'none' }).loadAsync(url);
  const texture = new THREE.Texture(bitmap);
  texture.needsUpdate = true;
  texture.addEventListener('dispose', () => bitmap.close());
  return texture;
}

/** What material texture loading reads and writes on the Viewer that owns it. */
export interface MaterialTexturesHost {
  readonly material: THREE.MeshPhongMaterial;
  readonly tf2Uniforms: Tf2Uniforms;
  readonly renderer: THREE.WebGLRenderer;
  readonly emissive: Pick<EmissiveOverlay, 'applyEmissivePass'>;
  /** The environment finishes loading after construction, so each material load reads the promise then. */
  readonly getEnvReady: () => Promise<void>;
  /** The default cubemap changes as environments load, so read it on each use. */
  readonly getDefaultEnvMap: () => THREE.CubeTexture;
  readonly setMaterialEnvMap: (texture: THREE.CubeTexture) => void;
  readonly setMaterialRimLight: (value: number) => void;
  readonly syncMaterialRimLight: () => void;
  /** The Viewer owns the counter; a load that is no longer the latest stops before applying. */
  readonly nextMaterialLoadToken: () => number;
  readonly getMaterialLoadToken: () => number;
  readonly isDisposed: () => boolean;
  readonly invalidate: () => void;
}

/** Loads a weapon material's texture slots and custom cubemap, one set per material load. */
export class MaterialTextures {
  private readonly host: MaterialTexturesHost;
  private normalTexture: THREE.Texture | null = null;
  private exponentTexture: THREE.Texture | null = null;
  private lightwarpTexture: THREE.Texture | null = null;
  private selfIllumTexture: THREE.Texture | null = null;
  private detailTexture: THREE.Texture | null = null;
  private customEnvMapTexture: THREE.CubeTexture | null = null;
  /** Decoded maps by slot and URL, least recently used first, so that going back to a weapon reloads nothing. */
  private readonly loaded = new Map<string, { texture: Promise<THREE.Texture>; bytes: number }>();
  private readonly loadedBudget = textureCacheBudgetBytes() / 4;

  constructor(host: MaterialTexturesHost) {
    this.host = host;
  }

  /** The material's own cubemap, or null while the default environment applies. */
  get customEnvMap(): THREE.CubeTexture | null {
    return this.customEnvMapTexture;
  }

  disposeTextures(): void {
    for (const { texture } of this.loaded.values()) void texture.then((t) => t.dispose(), () => undefined);
    this.loaded.clear();
  }

  /** The same URL can fill two slots with different sampling, so each slot has its own copy. */
  private loadTexture(slot: string, url: string): Promise<THREE.Texture> {
    const key = `${slot}|${url}`;
    const existing = this.loaded.get(key);
    if (existing) {
      this.loaded.delete(key);
      this.loaded.set(key, existing);
      return existing.texture;
    }
    const entry = { texture: loadBitmapTexture(url), bytes: 0 };
    this.loaded.set(key, entry);
    entry.texture.then((texture) => {
      const { width, height } = texture.image as ImageBitmap;
      entry.bytes = Math.ceil(width * height * 4 * 1.34);
      this.evictLoaded(key);
    }, () => {
      if (this.loaded.get(key) === entry) this.loaded.delete(key);
    });
    return entry.texture;
  }

  /** Oldest first, sparing the newest and the maps the current material still shows. */
  private evictLoaded(newest: string): void {
    let total = [...this.loaded.values()].reduce((sum, { bytes }) => sum + bytes, 0);
    const shown = [this.normalTexture, this.exponentTexture, this.lightwarpTexture, this.selfIllumTexture, this.detailTexture];
    for (const [key, entry] of this.loaded) {
      if (total <= this.loadedBudget) break;
      if (key === newest || !entry.bytes) continue;
      void entry.texture.then((texture) => {
        if (shown.includes(texture)) return;
        this.loaded.delete(key);
        texture.dispose();
      });
      total -= entry.bytes;
    }
  }

  async applyMaterialParams(
    mat: WeaponMaterial,
    resolveTexture: (ref: string) => string | Promise<string>,
    resolveCubemap: (ref: string) => Promise<string[] | null>,
    cancelled: () => boolean,
  ): Promise<void> {
    const token = this.host.nextMaterialLoadToken();
    await this.host.getEnvReady();
    if (this.host.isDisposed() || cancelled() || token !== this.host.getMaterialLoadToken()) return;
    const u = this.host.tf2Uniforms;
    configureTf2Material(mat, this.host.material, u);
    this.host.setMaterialRimLight(u.uTf2RimLight.value);
    this.host.syncMaterialRimLight();
    this.host.invalidate();

    this.normalTexture = this.exponentTexture = this.lightwarpTexture = this.selfIllumTexture = null;
    this.detailTexture = null;
    this.host.material.normalMap = null;
    u.uTf2ExponentMap.value = null;
    u.uTf2LightwarpMap.value = null;
    u.uTf2UseExponentMap.value = 0;
    u.uTf2UseLightwarp.value = 0;
    u.uTf2UseSelfIllumMask.value = 0;
    u.uTf2SelfIllumMaskMap.value = null;
    u.uTf2DetailMap.value = null;

    const loads: Promise<void>[] = [];
    if (mat.envmapTexture) {
      loads.push(resolveCubemap(mat.envmapTexture).then((urls) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) return;
        if (!urls) {
          this.resetMaterialEnvMap();
          return;
        }
        return new THREE.CubeTextureLoader().loadAsync(urls).then((texture) => {
          if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) { texture.dispose(); return; }
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.needsUpdate = true;
          this.customEnvMapTexture?.dispose();
          this.customEnvMapTexture = texture;
          this.host.setMaterialEnvMap(texture);
        });
      }).catch(() => {
        if (token === this.host.getMaterialLoadToken() && !this.host.isDisposed()) this.resetMaterialEnvMap();
      }));
    } else {
      this.resetMaterialEnvMap();
    }
    if (mat.normalMap) loads.push(Promise.resolve(resolveTexture(mat.normalMap)).then((url) => this.loadTexture('normal', url)).then((t) => {
      if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) return;
      t.colorSpace = THREE.NoColorSpace;
      t.flipY = false; // glTF UV convention, same as the composited map
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      // Source normal maps use the DirectX (green-down) convention.
      this.host.material.normalScale.set(1, -1);
      this.normalTexture = t;
      this.host.material.normalMap = t;
      this.host.material.needsUpdate = true;
      this.host.renderer.initTexture(t);
      this.host.invalidate();
    }).catch(() => undefined));
    if (mat.phongExponentTexture) {
      loads.push(Promise.resolve(resolveTexture(mat.phongExponentTexture)).then((url) => this.loadTexture('exponent', url)).then((t) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) return;
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        this.exponentTexture = t; u.uTf2ExponentMap.value = t; u.uTf2UseExponentMap.value = 1;
        this.host.renderer.initTexture(t);
        this.host.invalidate();
      }).catch(() => undefined));
    }
    if (mat.lightwarpTexture) {
      loads.push(Promise.resolve(resolveTexture(mat.lightwarpTexture)).then((url) => this.loadTexture('lightwarp', url)).then((t) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) return;
        // skin_dx9_helper.cpp does not enable sRGB reads for the diffuse-warp
        // sampler. Source therefore uses the stored ramp values directly.
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        this.lightwarpTexture = t; u.uTf2LightwarpMap.value = t; u.uTf2UseLightwarp.value = 1;
        this.host.renderer.initTexture(t);
        this.host.invalidate();
      }).catch(() => undefined));
    }
    if (mat.selfIllumMask) {
      loads.push(Promise.resolve(resolveTexture(mat.selfIllumMask)).then((url) => this.loadTexture('selfIllum', url)).then((t) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) return;
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        this.selfIllumTexture = t; u.uTf2SelfIllumMaskMap.value = t; u.uTf2UseSelfIllumMask.value = 1;
        this.host.renderer.initTexture(t);
        this.host.invalidate();
      }).catch(() => undefined));
    }
    if (mat.detailTexture) {
      loads.push(Promise.resolve(resolveTexture(mat.detailTexture)).then((url) => this.loadTexture('detail', url)).then((t) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) return;
        // Decoded in the shader instead of here, because Mod2X reads the
        // detail texture raw while every other blend mode reads it as sRGB.
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        this.detailTexture = t; u.uTf2DetailMap.value = t;
        this.host.renderer.initTexture(t);
        this.host.invalidate();
      }).catch(() => undefined));
    }
    loads.push(this.host.emissive.applyEmissivePass(mat, resolveTexture, token));
    this.host.material.needsUpdate = true;
    await Promise.all(loads);
    this.host.invalidate();
  }

  private resetMaterialEnvMap(): void {
    this.customEnvMapTexture?.dispose();
    this.customEnvMapTexture = null;
    this.host.setMaterialEnvMap(this.host.getDefaultEnvMap());
  }
}
