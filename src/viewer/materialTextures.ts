import * as THREE from 'three';
import type { WeaponMaterial } from '../data/types';
import { configureTf2Material, type Tf2Uniforms } from './materialConfig';
import type { EmissiveOverlay } from './overlays/emissiveOverlay';

/** What material texture loading reads and writes on the Viewer that owns it. */
export interface MaterialTexturesHost {
  readonly material: THREE.MeshPhongMaterial;
  readonly tf2Uniforms: Tf2Uniforms;
  readonly renderer: THREE.WebGLRenderer;
  readonly texLoader: THREE.TextureLoader;
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

  constructor(host: MaterialTexturesHost) {
    this.host = host;
  }

  /** The material's own cubemap, or null while the default environment applies. */
  get customEnvMap(): THREE.CubeTexture | null {
    return this.customEnvMapTexture;
  }

  disposeTextures(): void {
    this.normalTexture?.dispose();
    this.exponentTexture?.dispose();
    this.lightwarpTexture?.dispose();
    this.selfIllumTexture?.dispose();
    this.detailTexture?.dispose();
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

    this.normalTexture?.dispose();
    this.exponentTexture?.dispose();
    this.lightwarpTexture?.dispose();
    this.selfIllumTexture?.dispose();
    this.detailTexture?.dispose();
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
    if (mat.normalMap) loads.push(Promise.resolve(resolveTexture(mat.normalMap)).then((url) => this.host.texLoader.loadAsync(url)).then((t) => {
      if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) { t.dispose(); return; }
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
      loads.push(Promise.resolve(resolveTexture(mat.phongExponentTexture)).then((url) => this.host.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) { t.dispose(); return; }
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        this.exponentTexture = t; u.uTf2ExponentMap.value = t; u.uTf2UseExponentMap.value = 1;
        this.host.renderer.initTexture(t);
        this.host.invalidate();
      }).catch(() => undefined));
    }
    if (mat.lightwarpTexture) {
      loads.push(Promise.resolve(resolveTexture(mat.lightwarpTexture)).then((url) => this.host.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) { t.dispose(); return; }
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
      loads.push(Promise.resolve(resolveTexture(mat.selfIllumMask)).then((url) => this.host.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) { t.dispose(); return; }
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        this.selfIllumTexture = t; u.uTf2SelfIllumMaskMap.value = t; u.uTf2UseSelfIllumMask.value = 1;
        this.host.renderer.initTexture(t);
        this.host.invalidate();
      }).catch(() => undefined));
    }
    if (mat.detailTexture) {
      loads.push(Promise.resolve(resolveTexture(mat.detailTexture)).then((url) => this.host.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) { t.dispose(); return; }
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
