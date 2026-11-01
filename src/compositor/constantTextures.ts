import * as THREE from 'three';

/** Shared 1x1 textures for unused sampler slots and constant inputs, created on first use. */
export class ConstantTextures {
  private _dummy: THREE.DataTexture | null = null;
  private _constWhite: THREE.DataTexture | null = null;
  private _constHalf: THREE.DataTexture | null = null;
  private _constZero: THREE.DataTexture | null = null;

  dummyTex(): THREE.DataTexture {
    if (!this._dummy) {
      const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      this._dummy = t;
    }
    return this._dummy;
  }

  constWhite(): THREE.DataTexture {
    if (!this._constWhite) {
      const t = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      this._constWhite = t;
    }
    return this._constWhite;
  }

  constHalf(): THREE.DataTexture {
    if (!this._constHalf) {
      const t = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1, THREE.RGBAFormat);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      this._constHalf = t;
    }
    return this._constHalf;
  }

  constZero(): THREE.DataTexture {
    if (!this._constZero) {
      const t = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
      t.colorSpace = THREE.NoColorSpace;
      t.needsUpdate = true;
      this._constZero = t;
    }
    return this._constZero;
  }

  dispose(): void {
    if (this._constHalf) this._constHalf.dispose();
    if (this._constWhite) this._constWhite.dispose();
    if (this._constZero) this._constZero.dispose();
    if (this._dummy) this._dummy.dispose();
  }
}
