import * as THREE from 'three';
import type { FirstPersonPreview } from '../firstPerson/firstPerson';
import {
  createEmissiveMaterial,
  configureEmissiveTexture,
  whiteTexture,
  EMISSIVE_DEFAULT_SCROLL,
  EMISSIVE_DEFAULT_STRENGTH,
} from './emissive';
import type { WeaponMaterial } from '../../data/types';

/** What the emissive pass reads from the Viewer that owns it. */
export interface EmissiveOverlayHost {
  readonly centerGroup: THREE.Group;
  readonly renderer: THREE.WebGLRenderer;
  readonly texLoader: THREE.TextureLoader;
  /** The arrays are replaced on every model load, so read them on each use. */
  readonly getMeshes: () => THREE.Mesh[];
  readonly getMeshIsLens: () => boolean[];
  readonly getMaterialSide: () => THREE.Side;
  /** Each material load captures the token it started with, so stale loads can stop. */
  readonly getMaterialLoadToken: () => number;
  readonly getFirstPerson: () => FirstPersonPreview | null;
  readonly isDisposed: () => boolean;
  readonly invalidate: () => void;
}

export class EmissiveOverlay {
  private readonly host: EmissiveOverlayHost;

  // $EmissiveBlend pass: like the sheen, a second material over per-mesh
  // clones of the weapon geometry, created on demand by an imported material.
  private emissiveMaterial: THREE.ShaderMaterial | null = null;
  private emissiveMeshes: THREE.Mesh[] = [];
  private emissiveTextures: THREE.Texture[] = [];
  private emissiveEnabled = false;
  private emissiveElapsed = 0;

  constructor(host: EmissiveOverlayHost) {
    this.host = host;
  }

  get enabled(): boolean {
    return this.emissiveEnabled;
  }

  get material(): THREE.ShaderMaterial | null {
    return this.emissiveMaterial;
  }

  // $time only moves the picture when the scroll vector is non-zero. Wrap it so a
  // long session cannot push samples past where float precision resolves texels.
  stepEmissive(dt: number): boolean {
    const scroll: THREE.Vector2 | undefined = this.emissiveMaterial?.uniforms.uEmissiveScroll.value;
    const animating = this.emissiveEnabled && !!scroll && scroll.lengthSq() > 0;
    if (animating && this.emissiveMaterial) {
      const period = Math.max(1 / Math.max(Math.abs(scroll.x), Math.abs(scroll.y)), 1);
      this.emissiveElapsed = (this.emissiveElapsed + dt) % period;
      this.emissiveMaterial.uniforms.uEmissiveTime.value = this.emissiveElapsed;
    }
    return animating;
  }

  /**
   * $EmissiveBlendEnabled is a second additive pass, not a term in the lit shader,
   * so it has its own material, mesh copies and textures.
   */
  async applyEmissivePass(
    mat: WeaponMaterial,
    resolveTexture: (ref: string) => string | Promise<string>,
    token: number,
  ): Promise<void> {
    for (const texture of this.emissiveTextures) texture.dispose();
    this.emissiveTextures = [];
    const strength = mat.emissiveBlendStrength ?? EMISSIVE_DEFAULT_STRENGTH;
    // vertexlitgeneric_dx9.cpp skips the pass entirely at zero strength.
    this.emissiveEnabled = !!mat.emissiveBlend && strength > 0 && !!mat.emissiveBlendBaseTexture;
    if (!this.emissiveEnabled) {
      this.teardownEmissiveMeshes();
      return;
    }
    if (!this.emissiveMaterial) this.emissiveMaterial = createEmissiveMaterial(this.host.getMaterialSide());
    const u = this.emissiveMaterial.uniforms;
    u.uEmissiveStrength.value = strength;
    u.uEmissiveTint.value.setRGB(...(mat.emissiveBlendTint ?? [1, 1, 1]));
    u.uEmissiveScroll.value.fromArray(mat.emissiveBlendScrollVector ?? EMISSIVE_DEFAULT_SCROLL);
    u.uEmissiveTime.value = 0;
    this.emissiveElapsed = 0;
    // A missing flow or emissive map would sample as black and swallow the
    // glow, so both fall back to the white texture the fxc's math expects.
    const white = whiteTexture();
    u.uEmissiveBaseMap.value = null;
    u.uEmissiveFlowMap.value = white;
    u.uEmissiveMap.value = white;

    const slots: [string | null | undefined, 'uEmissiveBaseMap' | 'uEmissiveFlowMap' | 'uEmissiveMap'][] = [
      [mat.emissiveBlendBaseTexture, 'uEmissiveBaseMap'],
      [mat.emissiveBlendFlowTexture, 'uEmissiveFlowMap'],
      [mat.emissiveBlendTexture, 'uEmissiveMap'],
    ];
    await Promise.all(slots.map(([ref, slot]) => (ref
      ? Promise.resolve(resolveTexture(ref)).then((url) => this.host.texLoader.loadAsync(url)).then((t) => {
        if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) { t.dispose(); return; }
        configureEmissiveTexture(t);
        this.emissiveTextures.push(t);
        if (this.emissiveMaterial) this.emissiveMaterial.uniforms[slot].value = t;
        this.host.renderer.initTexture(t);
      }).catch(() => undefined)
      : Promise.resolve())));
    if (token !== this.host.getMaterialLoadToken() || this.host.isDisposed()) return;
    // Without a glow color there is nothing to add, and the pass would tint
    // the weapon by whatever the fallback white maps happened to multiply out.
    this.emissiveEnabled = !!this.emissiveMaterial.uniforms.uEmissiveBaseMap.value;
    if (this.emissiveEnabled) this.rebuildEmissiveMeshes();
    else this.teardownEmissiveMeshes();
    this.host.invalidate();
  }

  teardownEmissiveMeshes() {
    this.host.getFirstPerson()?.setOverlay('emissive', null);
    for (const mesh of this.emissiveMeshes) this.host.centerGroup.remove(mesh);
    this.emissiveMeshes = [];
  }

  rebuildEmissiveMeshes() {
    this.teardownEmissiveMeshes();
    if (!this.emissiveEnabled || !this.emissiveMaterial) return;
    this.host.getFirstPerson()?.setOverlay('emissive', this.emissiveMaterial);
    for (let i = 0; i < this.host.getMeshes().length; i++) {
      if (this.host.getMeshIsLens()[i]) continue;
      const mesh = new THREE.Mesh(this.host.getMeshes()[i].geometry, this.emissiveMaterial);
      mesh.renderOrder = 1;
      this.host.centerGroup.add(mesh);
      this.emissiveMeshes.push(mesh);
    }
  }

  dispose(): void {
    this.emissiveMaterial?.dispose();
    for (const texture of this.emissiveTextures) texture.dispose();
  }
}
