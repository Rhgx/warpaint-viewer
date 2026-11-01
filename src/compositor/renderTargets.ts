import * as THREE from 'three';

/** Recycles scratch render targets at the compositor's output size. */
export class RenderTargetPool {
  private _width: number;
  private _height: number;
  // pool of scratch sRGB-encoded 8-bit render targets
  private pool: THREE.WebGLRenderTarget[] = [];

  constructor(size: number) {
    this._width = this._height = size;
  }

  get width(): number {
    return this._width;
  }

  get height(): number {
    return this._height;
  }

  makeTarget(width = this.width, height = this.height): THREE.WebGLRenderTarget {
    const t = new THREE.WebGLRenderTarget(width, height, {
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

  acquire(): THREE.WebGLRenderTarget {
    return this.pool.pop() ?? this.makeTarget();
  }

  release(t: THREE.WebGLRenderTarget) {
    // Retain scratch space up to 32 MiB; a complex recipe must not permanently
    // reserve its peak allocation after its intermediates have been released.
    if (t.width === this.width && t.height === this.height
      && (this.pool.length + 1) * t.width * t.height * 4 <= 32 * 1024 * 1024) this.pool.push(t);
    else t.dispose();
  }

  setOutputSize(width: number, height: number) {
    const nextWidth = Math.max(1, Math.floor(width));
    const nextHeight = Math.max(1, Math.floor(height));
    if (nextWidth === this.width && nextHeight === this.height) return;
    for (const target of this.pool) target.dispose();
    this.pool.length = 0;
    this._width = nextWidth;
    this._height = nextHeight;
  }

  dispose(): void {
    this.pool.forEach((t) => t.dispose());
    this.pool = [];
  }
}
