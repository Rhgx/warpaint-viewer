import * as THREE from 'three';
import { EDITOR_LAYER_MAP_COLORS } from '../../editor/layers/layerMap';

/** A single, subtle tint assigned to one compositor group bucket. */
interface GroupLayerOverlayLayer {
  /** Compositor bucket (1..16), rather than the raw 0..255 group-map byte. */
  readonly bucket: number;
  /** Linear RGB channels in the 0..1 range. */
  readonly color: readonly [number, number, number];
}

/** One group-map source for the all-layer surface cue; a paint can use several. */
export interface GroupLayerOverlayMap {
  /** Unflipped RGBA pixels, in the same orientation as the composited map. */
  readonly pixels: Uint8Array | Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly layers: readonly GroupLayerOverlayLayer[];
}

/** The deliberately low-strength opacity used for the all-layer surface cue. */
const GROUP_LAYER_OVERLAY_OPACITY = 0.16;

/** Both group overlay materials sample the group map at the mesh UVs. */
const GROUP_OVERLAY_VERTEX_SHADER = `
  varying vec2 vGroupUv;
  void main() {
    vGroupUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/** Muted default tints for editor layers. The UI passes its chosen value explicitly to Viewer. */
export const GROUP_LAYER_OVERLAY_COLORS = EDITOR_LAYER_MAP_COLORS;

interface GroupLayerOverlayPass {
  texture: THREE.DataTexture;
  material: THREE.ShaderMaterial;
  meshes: THREE.Mesh[];
}

/** What the group overlays read from the Viewer that owns them. */
export interface GroupOverlayHost {
  readonly centerGroup: THREE.Group;
  /** The array is replaced on every model load, so read it on each use. */
  readonly getPaintableMeshes: () => THREE.Mesh[];
  readonly getMaterialSide: () => THREE.Side;
  readonly invalidate: () => void;
}

// Editor group cues drawn over the paint: the faint all-layer key and the focused highlight.
// The Viewer owns the scene; this class adds and removes only its own overlay meshes.
export class GroupOverlays {
  private readonly host: GroupOverlayHost;
  // Editor surface cue: a transparent pass over the CPU-decoded groups texture.
  // It uses the compositor's exact bucket comparison, so highlights match selectors.
  private groupHighlightTexture: THREE.DataTexture | null = null;
  private groupHighlightMaterial: THREE.ShaderMaterial | null = null;
  private groupHighlightMeshes: THREE.Mesh[] = [];

  // All-layer editor cue, kept as its own pass so it never changes the composed
  // paint texture. Unlike the focused highlight, it may show every assigned layer.
  private groupLayerOverlayPasses: GroupLayerOverlayPass[] = [];

  constructor(host: GroupOverlayHost) {
    this.host = host;
  }

  setGroupLayerOverlay(maps: readonly GroupLayerOverlayMap[] | null): void {
    this.teardownGroupLayerOverlayPasses();
    if (maps === null) {
      this.host.invalidate();
      return;
    }

    for (const source of maps) {
      if (!Number.isSafeInteger(source.width) || source.width <= 0
        || !Number.isSafeInteger(source.height) || source.height <= 0
        || source.pixels.length < source.width * source.height * 4) continue;

      // One color per bucket; the last entry wins, so callers need not de-duplicate
      // buckets reassigned in the same state update.
      const colors = Array.from({ length: 16 }, () => new THREE.Vector3());
      const active = Array.from({ length: 16 }, () => 0);
      for (const layer of source.layers) {
        if (!Number.isInteger(layer.bucket) || layer.bucket < 1 || layer.bucket > 16) continue;
        const [r, g, b] = layer.color;
        if (![r, g, b].every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)) continue;
        colors[layer.bucket - 1].set(r, g, b);
        active[layer.bucket - 1] = 1;
      }
      if (!active.some(Boolean)) continue;

      const texture = this.createGroupMapTexture(source.pixels, source.width, source.height);
      const material = this.createGroupLayerOverlayMaterial(texture, colors, active);
      const pass: GroupLayerOverlayPass = { texture, material, meshes: [] };
      this.groupLayerOverlayPasses.push(pass);
      this.rebuildGroupLayerOverlayMeshes(pass);
    }
    this.host.invalidate();
  }

  clearGroupLayerOverlay(): void {
    this.teardownGroupLayerOverlayPasses();
    this.host.invalidate();
  }

  private createGroupMapTexture(
    pixels: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
  ): THREE.DataTexture {
    // Copy caller-owned data. Decoding and editor state may reuse the source
    // buffer after this call, which must not mutate an already-uploaded map.
    const data = new Uint8Array(width * height * 4);
    data.set(pixels.subarray(0, data.length));
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
    texture.colorSpace = THREE.NoColorSpace;
    texture.flipY = false;
    texture.generateMipmaps = false;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }

  private createGroupLayerOverlayMaterial(
    texture: THREE.Texture,
    colors: THREE.Vector3[],
    active: number[],
  ): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: {
        uGroupMap: { value: texture },
        uLayerColors: { value: colors },
        uLayerActive: { value: active },
      },
      vertexShader: GROUP_OVERLAY_VERTEX_SHADER,
      fragmentShader: `
        uniform sampler2D uGroupMap;
        uniform vec3 uLayerColors[16];
        uniform float uLayerActive[16];
        varying vec2 vGroupUv;
        void main() {
          float rawGroup = texture2D(uGroupMap, vGroupUv).r * 255.0;
          float groupBucket = floor(rawGroup / 16.0 + 0.5);
          for (int i = 0; i < 16; i++) {
            if (uLayerActive[i] > 0.5 && abs(groupBucket - float(i + 1)) < 0.1) {
              gl_FragColor = vec4(uLayerColors[i], ${GROUP_LAYER_OVERLAY_OPACITY.toFixed(2)});
              return;
            }
          }
          discard;
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: this.host.getMaterialSide(),
    });
  }

  private rebuildGroupLayerOverlayMeshes(pass: GroupLayerOverlayPass) {
    for (const mesh of this.host.getPaintableMeshes()) {
      const overlay = new THREE.Mesh(mesh.geometry, pass.material);
      // The focused selection cue uses renderOrder 2, so it stays stronger and on top.
      overlay.renderOrder = 1;
      this.host.centerGroup.add(overlay);
      pass.meshes.push(overlay);
    }
  }

  private teardownGroupLayerOverlayMeshes() {
    for (const pass of this.groupLayerOverlayPasses) {
      for (const mesh of pass.meshes) this.host.centerGroup.remove(mesh);
      pass.meshes = [];
    }
  }

  private teardownGroupLayerOverlayPasses() {
    this.teardownGroupLayerOverlayMeshes();
    for (const pass of this.groupLayerOverlayPasses) {
      pass.material.dispose();
      pass.texture.dispose();
    }
    this.groupLayerOverlayPasses = [];
  }

  setGroupHighlight(
    pixels: Uint8Array | Uint8ClampedArray | null,
    width: number,
    height: number,
    bucket: number | null,
    color: readonly [number, number, number],
  ): void {
    if (pixels === null
      || !Number.isSafeInteger(width) || width <= 0
      || !Number.isSafeInteger(height) || height <= 0
      || pixels.length < width * height * 4
      || bucket === null || !Number.isInteger(bucket) || bucket < 0 || bucket > 16
      || !color.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
      this.clearGroupHighlight();
      return;
    }

    const texture = this.createGroupMapTexture(pixels, width, height);

    this.groupHighlightTexture?.dispose();
    this.groupHighlightTexture = texture;
    const material = this.ensureGroupHighlightMaterial();
    material.uniforms.uGroupMap.value = texture;
    material.uniforms.uBucket.value = bucket;
    material.uniforms.uColor.value.set(color[0], color[1], color[2]);
    this.rebuildGroupHighlightMeshes();
    this.host.invalidate();
  }

  clearGroupHighlight(): void {
    this.teardownGroupHighlightMeshes();
    this.groupHighlightTexture?.dispose();
    this.groupHighlightTexture = null;
    if (this.groupHighlightMaterial) this.groupHighlightMaterial.uniforms.uGroupMap.value = null;
    this.host.invalidate();
  }

  private ensureGroupHighlightMaterial(): THREE.ShaderMaterial {
    if (this.groupHighlightMaterial) return this.groupHighlightMaterial;
    this.groupHighlightMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uGroupMap: { value: null as THREE.Texture | null },
        uBucket: { value: -1 },
        uColor: { value: new THREE.Vector3(...GROUP_LAYER_OVERLAY_COLORS[0]) },
      },
      vertexShader: GROUP_OVERLAY_VERTEX_SHADER,
      fragmentShader: `
        uniform sampler2D uGroupMap;
        uniform float uBucket;
        uniform vec3 uColor;
        varying vec2 vGroupUv;
        void main() {
          float rawGroup = texture2D(uGroupMap, vGroupUv).r * 255.0;
          float groupBucket = floor(rawGroup / 16.0 + 0.5);
          if (abs(groupBucket - uBucket) > 0.1) discard;
          gl_FragColor = vec4(uColor, 0.32);
        }
      `,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      // Draw just in front of the source mesh, preventing coplanar flicker
      // while retaining depth testing against the rest of the weapon.
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      side: this.host.getMaterialSide(),
    });
    return this.groupHighlightMaterial;
  }

  private teardownGroupHighlightMeshes() {
    for (const mesh of this.groupHighlightMeshes) this.host.centerGroup.remove(mesh);
    this.groupHighlightMeshes = [];
  }

  private rebuildGroupHighlightMeshes() {
    this.teardownGroupHighlightMeshes();
    if (!this.groupHighlightTexture || !this.groupHighlightMaterial) return;
    this.groupHighlightMaterial.side = this.host.getMaterialSide();
    for (const mesh of this.host.getPaintableMeshes()) {
      const overlay = new THREE.Mesh(mesh.geometry, this.groupHighlightMaterial);
      overlay.renderOrder = 2;
      this.host.centerGroup.add(overlay);
      this.groupHighlightMeshes.push(overlay);
    }
  }

  /** Drops the overlay meshes before the model is replaced; passes and materials are kept. */
  teardownMeshes(): void {
    this.teardownGroupLayerOverlayMeshes();
    this.teardownGroupHighlightMeshes();
  }

  rebuildMeshes(): void {
    for (const pass of this.groupLayerOverlayPasses) this.rebuildGroupLayerOverlayMeshes(pass);
    if (this.groupHighlightTexture && this.groupHighlightMaterial) this.rebuildGroupHighlightMeshes();
  }

  disposeHighlightMaterial(): void {
    this.groupHighlightMaterial?.dispose();
    this.groupHighlightMaterial = null;
  }
}
