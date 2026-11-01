import * as THREE from 'three';
import { TF2_VERTEXLIT_CACHE_KEY } from './shaders/vertexlit';

/** Opacity of the normal paint while a transform layer is isolated. */
const TRANSFORM_ISOLATION_CONTEXT_OPACITY = 0.2;

/** What transform isolation reads from the Viewer that owns it. */
export interface TransformIsolationHost {
  readonly centerGroup: THREE.Group;
  readonly material: THREE.MeshPhongMaterial;
  /** Shared with the paint shader, so the Viewer keeps the uniform and this class only writes it. */
  readonly contextOpacity: { value: number };
  /** The array is replaced on every model load, so read it on each use. */
  readonly getPaintableMeshes: () => THREE.Mesh[];
  readonly getMaterialLoadToken: () => number;
  readonly invalidate: () => void;
}

// Transform isolation keeps the complete paint as a translucent context pass, then
// redraws only the selected groups with the isolated recipe.
export class TransformIsolation {
  private readonly host: TransformIsolationHost;
  private transformIsolationMaskTexture: THREE.DataTexture | null = null;
  private transformIsolationSource: {
    pixels: Uint8Array | Uint8ClampedArray;
    width: number;
    height: number;
    buckets: string;
    materialToken: number;
  } | null = null;
  private transformIsolationMaterial: THREE.MeshPhongMaterial | null = null;
  private transformIsolationMeshes: THREE.Mesh[] = [];
  private transformIsolationBaseState: {
    readonly opacity: number;
    readonly transparent: boolean;
    readonly depthWrite: boolean;
  } | null = null;

  constructor(host: TransformIsolationHost) {
    this.host = host;
  }

  setTransformIsolation(
    texture: THREE.Texture,
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
    buckets: readonly number[],
  ): void {
    if (!Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0
      || pixels.length < width * height * 4
      || buckets.length === 0
      || buckets.some((bucket) => !Number.isInteger(bucket) || bucket < 1 || bucket > 16)) {
      this.clearTransformIsolation();
      return;
    }

    const bucketKey = buckets.join(',');
    const prior = this.transformIsolationSource;
    if (this.transformIsolationMaterial && prior?.pixels === pixels
      && prior.width === width && prior.height === height && prior.buckets === bucketKey
      && prior.materialToken === this.host.getMaterialLoadToken()) {
      this.transformIsolationMaterial.map = texture;
      this.host.invalidate();
      return;
    }
    const selectedBuckets = new Set(buckets);
    const maskData = new Uint8Array(width * height * 4);
    for (let sourceOffset = 0, targetOffset = 0; targetOffset < maskData.length; sourceOffset += 4, targetOffset += 4) {
      const bucket = Math.floor(pixels[sourceOffset] / 16 + 0.5);
      const selected = selectedBuckets.has(bucket) ? 255 : 0;
      maskData[targetOffset] = selected;
      maskData[targetOffset + 1] = selected;
      maskData[targetOffset + 2] = selected;
      maskData[targetOffset + 3] = 255;
    }
    const mask = new THREE.DataTexture(maskData, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    mask.colorSpace = THREE.NoColorSpace;
    mask.flipY = false;
    mask.generateMipmaps = false;
    mask.magFilter = THREE.NearestFilter;
    mask.minFilter = THREE.NearestFilter;
    mask.wrapS = THREE.ClampToEdgeWrapping;
    mask.wrapT = THREE.ClampToEdgeWrapping;
    mask.needsUpdate = true;

    this.applyTransformIsolation(texture, mask);
    this.transformIsolationSource = { pixels, width, height, buckets: bucketKey, materialToken: this.host.getMaterialLoadToken() };
  }

  private applyTransformIsolation(texture: THREE.Texture, mask: THREE.DataTexture): void {
    this.teardownTransformIsolationPass();
    if (!this.transformIsolationBaseState) {
      this.transformIsolationBaseState = {
        opacity: this.host.material.opacity,
        transparent: this.host.material.transparent,
        depthWrite: this.host.material.depthWrite,
      };
    }
    this.host.contextOpacity.value = TRANSFORM_ISOLATION_CONTEXT_OPACITY;
    this.host.material.transparent = true;
    this.host.material.depthWrite = true;
    this.host.material.needsUpdate = true;
    this.transformIsolationMaskTexture = mask;

    const material = this.host.material.clone();
    material.map = texture;
    // Sample the editor mask with the model's raw UVs. Three's alphaMap path
    // can inherit a different UV transform/channel from the weapon material,
    // which makes paintkit_tool treat a partial group mask as full-surface.
    material.alphaMap = null;
    material.alphaTest = 0;
    material.opacity = 1;
    material.transparent = false;
    material.depthWrite = true;
    material.polygonOffset = true;
    material.polygonOffsetFactor = -1;
    material.polygonOffsetUnits = -1;
    const compileTf2Material = this.host.material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      compileTf2Material(shader, renderer);
      shader.uniforms.uTf2IsolationContextOpacity = { value: 1 };
      shader.uniforms.uTf2IsolationMask = { value: mask };
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec2 vTf2IsolationUv;\nvoid main() {')
        .replace('void main() {', 'void main() {\n  vTf2IsolationUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform sampler2D uTf2IsolationMask;\nvarying vec2 vTf2IsolationUv;\nvoid main() {',
        )
        .replace(
          'if ( uTf2AlphaTestRef > 0.0 && diffuseColor.a < uTf2AlphaTestRef ) discard;',
          `if ( uTf2AlphaTestRef > 0.0 && diffuseColor.a < uTf2AlphaTestRef ) discard;
  if ( texture2D( uTf2IsolationMask, vTf2IsolationUv ).r < 0.5 ) discard;`,
        );
    };
    material.customProgramCacheKey = () => `${TF2_VERTEXLIT_CACHE_KEY}:transform-isolation`;
    material.needsUpdate = true;

    this.transformIsolationMaterial = material;
    this.rebuildTransformIsolationMeshes();
    this.host.invalidate();
  }

  clearTransformIsolation(): void {
    this.teardownTransformIsolationPass();
    if (this.transformIsolationBaseState) {
      this.host.material.opacity = this.transformIsolationBaseState.opacity;
      this.host.material.transparent = this.transformIsolationBaseState.transparent;
      this.host.material.depthWrite = this.transformIsolationBaseState.depthWrite;
      this.host.contextOpacity.value = 1;
      this.host.material.needsUpdate = true;
      this.transformIsolationBaseState = null;
    }
    this.host.invalidate();
  }

  rebuildTransformIsolationMeshes(): void {
    this.teardownTransformIsolationMeshes();
    if (!this.transformIsolationMaterial) return;
    for (const mesh of this.host.getPaintableMeshes()) {
      const isolated = new THREE.Mesh(mesh.geometry, this.transformIsolationMaterial);
      isolated.renderOrder = 3;
      this.host.centerGroup.add(isolated);
      this.transformIsolationMeshes.push(isolated);
    }
  }

  teardownTransformIsolationMeshes(): void {
    for (const mesh of this.transformIsolationMeshes) this.host.centerGroup.remove(mesh);
    this.transformIsolationMeshes = [];
  }

  private teardownTransformIsolationPass(): void {
    this.transformIsolationSource = null;
    this.teardownTransformIsolationMeshes();
    this.transformIsolationMaterial?.dispose();
    this.transformIsolationMaterial = null;
    this.transformIsolationMaskTexture?.dispose();
    this.transformIsolationMaskTexture = null;
  }
}
