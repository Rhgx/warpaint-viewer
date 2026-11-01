import * as THREE from 'three';
import type { WeaponAttachment } from '../data/types';
import { joinData } from '../data/loader';
import type { ModelLoader } from './modelLoader';
import { configureTf2Material, createTf2Uniforms, type Tf2Uniforms } from './materialConfig';
import { installTf2VertexLit, TF2_VERTEXLIT_CACHE_KEY } from './shaders/vertexlit';

interface LoadedAttachment {
  meshes: THREE.Mesh[];
  material: THREE.MeshPhongMaterial;
  uniforms: Tf2Uniforms;
}

function disposeAttachment({ material, uniforms }: LoadedAttachment): void {
  material.map?.dispose();
  uniforms.uTf2DetailMap.value?.dispose();
  material.dispose();
}

/** What weapon attachments read from the Viewer that owns them. */
export interface WeaponAttachmentsHost {
  readonly centerGroup: THREE.Group;
  readonly texLoader: THREE.TextureLoader;
  readonly modelLoader: ModelLoader;
  readonly invalidate: () => void;
}

export class WeaponAttachments {
  private readonly host: WeaponAttachmentsHost;
  private attachments: LoadedAttachment[] = [];

  constructor(host: WeaponAttachmentsHost) {
    this.host = host;
  }

  async load(attachments: readonly WeaponAttachment[]): Promise<LoadedAttachment[]> {
    return (await Promise.all(attachments.map((attachment) => this.loadAttachment(attachment))))
      .filter((attachment) => attachment !== null);
  }

  /** Disposes attachments that were loaded but never applied, such as after a stale load. */
  discard(loaded: LoadedAttachment[]): void {
    loaded.forEach(disposeAttachment);
  }

  // Attached models keep their own unpainted material and stay out of
  // picking, framing and paint overlays. One that fails to load is left out.
  private async loadAttachment({ model, material: params }: WeaponAttachment): Promise<LoadedAttachment | null> {
    const loadTexture = async (ref: string | null | undefined) => {
      if (!ref) return null;
      const texture = await this.host.texLoader.loadAsync(joinData(ref));
      // Sampled like the viewmodel's copy in FirstPersonPreview.
      texture.flipY = false;
      texture.colorSpace = THREE.NoColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      return texture;
    };
    const [parts, map, detail] = await Promise.allSettled([
      this.host.modelLoader.load(`${import.meta.env.BASE_URL}data/${model}`),
      loadTexture(params.baseTexture),
      loadTexture(params.detailTexture),
    ]);
    if (parts.status === 'rejected' || map.status === 'rejected' || detail.status === 'rejected') {
      if (map.status === 'fulfilled') map.value?.dispose();
      if (detail.status === 'fulfilled') detail.value?.dispose();
      console.warn('[warpaint-viewer] attached model failed to load:', model);
      return null;
    }
    const uniforms = createTf2Uniforms();
    const material = new THREE.MeshPhongMaterial({ color: 0xffffff, map: map.value });
    configureTf2Material(params, material, uniforms);
    uniforms.uTf2DetailMap.value = detail.value;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      installTf2VertexLit(shader);
    };
    // Kept apart from this.material's program, which adds isolation uniforms.
    material.customProgramCacheKey = () => `${TF2_VERTEXLIT_CACHE_KEY}-attachment`;
    return { meshes: parts.value.map(({ geometry }) => new THREE.Mesh(geometry, material)), material, uniforms };
  }

  setAttachments(attachments: LoadedAttachment[]) {
    for (const attachment of this.attachments) {
      this.host.centerGroup.remove(...attachment.meshes);
      disposeAttachment(attachment);
    }
    this.attachments = attachments;
    for (const { meshes } of attachments) this.host.centerGroup.add(...meshes);
    this.host.invalidate();
  }

  // $texture2 TextureScroll runs on game time, so it scrolls in the inspect
  // panel too. The base's BuildingRescueLevel reads the owner's metal and has
  // no player there, so it stays put.
  stepAttachments(dt: number): boolean {
    let animating = false;
    for (const { uniforms } of this.attachments) {
      const scroll = uniforms.uTf2DetailScroll.value;
      if (scroll.lengthSq() === 0) continue;
      animating = true;
      const period = 1 / Math.max(Math.abs(scroll.x), Math.abs(scroll.y));
      uniforms.uTf2Time.value = (uniforms.uTf2Time.value + dt) % period;
    }
    return animating;
  }

  dispose(): void {
    this.attachments.forEach(disposeAttachment);
    this.attachments = [];
  }
}
