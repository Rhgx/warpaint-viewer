import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WeaponMaterial, Team } from '../data/types';
import { configureTf2Material, createTf2Uniforms, type Tf2Uniforms } from './materialConfig';
import { installTf2VertexLit, TF2_VERTEXLIT_CACHE_KEY } from './shaders/vertexlit';
import { FishBonePhysics, type FishJiggleSettings } from './fishPhysics';

export const VIEWMODEL_DATA = '/data/viewmodels/';
interface ViewmodelMaterial extends WeaponMaterial { baseTexture: string | null; animatedWeaponSheen?: boolean }
export interface ViewmodelAsset {
  model: string;
  materials: Record<string, ViewmodelMaterial>;
  blu?: Record<string, ViewmodelMaterial>;
}
export interface ViewmodelWeapon extends ViewmodelAsset {
  paintMaterials: string[];
  weaponKey: string;
  class: string;
  armsKey: string;
  activity: string;
  clips: Record<string, string | string[]>;
  stockOffset: [number, number, number] | null;
  flipViewmodel?: boolean;
  attachments: ViewmodelAsset[];
  jiggleBones?: FishJiggleSettings[];
}
export interface ViewmodelManifest {
  arms: Record<string, ViewmodelAsset>;
  weapons: ViewmodelWeapon[];
}

export function viewmodelFov(horizontal: number): number {
  return THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(horizontal) / 2) * 3 / 4));
}

/** Source bonemerge: matching bones follow the arms, others retain their local bind transform. */
export function bindViewmodelBones(follower: THREE.Bone[], sources: Map<string, THREE.Bone>[]) {
  return follower.map(bone => ({ bone, source: sources.map(bones => bones.get(bone.name)).find(Boolean) }));
}

export function mergeViewmodelBones(bindings: ReturnType<typeof bindViewmodelBones>): void {
  for (const { bone, source } of bindings) {
    if (source) bone.matrixWorld.copy(source.matrixWorld);
    else if (bone.parent) bone.matrixWorld.multiplyMatrices(bone.parent.matrixWorld, bone.matrix);
  }
}

/** A second pass shares the posed skeleton and bind frame, without owning either. */
export function createViewmodelOverlay(source: THREE.SkinnedMesh, material: THREE.Material): THREE.SkinnedMesh {
  const overlay = new THREE.SkinnedMesh(source.geometry, material);
  overlay.position.copy(source.position);
  overlay.quaternion.copy(source.quaternion);
  overlay.scale.copy(source.scale);
  overlay.bindMode = source.bindMode;
  overlay.bind(source.skeleton, source.bindMatrix);
  overlay.frustumCulled = false;
  overlay.renderOrder = 1;
  return overlay;
}

export class FirstPersonPreview {
  readonly root = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(viewmodelFov(70), 1, 1, 500);
  readonly weaponBindInverse = new THREE.Matrix4();
  readonly overlays: Record<'sheen' | 'emissive', THREE.SkinnedMesh[]> = { sheen: [], emissive: [] };
  private paintMeshes: THREE.SkinnedMesh[] = [];
  private pose = new THREE.Group();
  private gltfs: GLTF[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private mixer: THREE.AnimationMixer | null = null;
  private bones: THREE.Bone[][] = [];
  private boneMaps: Map<string, THREE.Bone>[] = [];
  private boneBindings: ReturnType<typeof bindViewmodelBones>[] = [];
  private poseDirty = true;
  private disposed = false;
  private weapon: ViewmodelWeapon | null = null;
  private activity: string | null = null;
  private paused = false;
  private fishPhysicsEnabled = false;
  private fishPhysics: FishBonePhysics | null = null;

  constructor() {
    // Source x forward, y left, z up -> Three x right, y up, z back.
    this.root.matrixAutoUpdate = false;
    this.root.matrix.set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
    this.root.add(this.pose);
  }

  async load(arms: ViewmodelAsset, weapon: ViewmodelWeapon, team: Team,
    paint: THREE.Material, lens: THREE.Material, lighting: Tf2Uniforms, envMap: THREE.CubeTexture): Promise<void> {
    this.weapon = weapon;
    if (weapon.flipViewmodel) this.root.matrix.scale(new THREE.Vector3(1, -1, 1));
    const loader = new GLTFLoader();
    const assets = [arms, weapon, ...weapon.attachments];
    // Wait for every request before disposing, including when another request fails.
    const results = await Promise.allSettled(assets.map(async asset => {
      const gltf = await loader.loadAsync(VIEWMODEL_DATA + asset.model);
      gltf.scene.traverse(object => {
        if (object instanceof THREE.Mesh) this.materials.push(...(Array.isArray(object.material) ? object.material : [object.material]));
      });
      this.gltfs.push(gltf);
      return gltf;
    }));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') { this.dispose(); throw failure.reason; }
    if (this.disposed) { this.releaseResources(); return; }
    const gltfs = results.map(result => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    const textureLoads: Promise<void>[] = [];
    for (const [index, gltf] of gltfs.entries()) {
      const bones: THREE.Bone[] = [];
      gltf.scene.traverse(object => {
        if (object instanceof THREE.Bone) {
          bones.push(object);
          if (index > 0) object.matrixWorldAutoUpdate = false;
        }
        if (!(object instanceof THREE.Mesh)) return;
        object.frustumCulled = false;
        const original = Array.isArray(object.material) ? object.material : [object.material];
        const materials = original.map(material => {
          if (index === 1 && /(?:^|_)lens(?:$|_)/i.test(material.name)) return lens;
          if (index === 1 && weapon.paintMaterials.includes(material.name)) return paint;
          const asset = assets[index];
          const params = (team === 'blu' ? asset.blu?.[material.name] : undefined) ?? asset.materials[material.name];
          if (!params) throw new Error(`Missing viewmodel material: ${material.name}`);
          const uniforms = createTf2Uniforms();
          uniforms.uTf2AmbientCube = lighting.uTf2AmbientCube;
          uniforms.uTf2AmbientBasis = lighting.uTf2AmbientBasis;
          uniforms.uTf2SpotFalloff = lighting.uTf2SpotFalloff;
          const result = new THREE.MeshPhongMaterial({ color: 0xffffff, envMap, combine: THREE.AddOperation });
          this.materials.push(result);
          // The sheen proxy's $detail is a mask for a separate pass, not hand albedo.
          // Heavy's hand material names it even when no killstreak sheen is active.
          const detailTexture = params.animatedWeaponSheen ? null : params.detailTexture;
          configureTf2Material({ ...params, detailTexture }, result, uniforms);
          result.onBeforeCompile = shader => { Object.assign(shader.uniforms, uniforms); installTf2VertexLit(shader); };
          result.customProgramCacheKey = () => TF2_VERTEXLIT_CACHE_KEY;
          const load = (ref: string | null | undefined, apply: (texture: THREE.Texture) => void) => {
            if (!ref) return;
            textureLoads.push(new THREE.TextureLoader().loadAsync(VIEWMODEL_DATA + ref).then(texture => {
              if (this.disposed) { texture.dispose(); return; }
              this.textures.push(texture);
              texture.flipY = false;
              texture.colorSpace = THREE.NoColorSpace;
              texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
              apply(texture);
              result.needsUpdate = true;
            }));
          };
          load(params.baseTexture, texture => { result.map = texture; });
          load(params.normalMap, texture => { result.normalMap = texture; });
          load(detailTexture, texture => { uniforms.uTf2DetailMap.value = texture; });
          load(params.phongExponentTexture, texture => { uniforms.uTf2ExponentMap.value = texture; uniforms.uTf2UseExponentMap.value = 1; });
          load(params.lightwarpTexture, texture => {
            texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
            uniforms.uTf2LightwarpMap.value = texture; uniforms.uTf2UseLightwarp.value = 1;
          });
          return result;
        });
        object.material = Array.isArray(object.material) ? materials : materials[0];
        if (index === 1 && object instanceof THREE.SkinnedMesh && materials.every(material => material === paint)) {
          this.paintMeshes.push(object);
        }
      });
      this.bones.push(bones);
      this.boneMaps.push(new Map(bones.map(bone => [bone.name, bone])));
      this.pose.add(gltf.scene);
    }
    this.boneBindings = this.bones.slice(1).map((bones, index) =>
      bindViewmodelBones(bones, index === 0 ? [this.boneMaps[0]] : [this.boneMaps[1], this.boneMaps[0]]));
    this.mixer = new THREE.AnimationMixer(gltfs[0].scene);
    const skeleton = this.paintMeshes[0]?.skeleton;
    const rootIndex = skeleton?.bones.indexOf(this.bones[1][0]) ?? -1;
    if (skeleton && rootIndex >= 0) this.weaponBindInverse.copy(skeleton.boneInverses[rootIndex]);
    if (weapon.weaponKey === 'c_holymackerel' && weapon.jiggleBones?.length) {
      this.fishPhysics = new FishBonePhysics(this.boneMaps[1], weapon.jiggleBones);
    }
    this.setAnimation(weapon.activity);
    const textures = await Promise.allSettled(textureLoads);
    const textureFailure = textures.find(result => result.status === 'rejected');
    if (textureFailure?.status === 'rejected') throw textureFailure.reason;
  }

  setAnimation(activity: string): void {
    if (activity === this.activity) return;
    const clip = this.gltfs.find(gltf => gltf.scene === this.pose.children[0])?.animations.find(entry => entry.name === activity);
    if (!clip || !this.mixer) return;
    this.activity = activity;
    this.poseDirty = true;
    this.fishPhysics?.reset();
    this.mixer.stopAllAction();
    this.mixer.clipAction(clip).reset().play();
    this.update(0);
  }

  setView(fov: number, minimized: boolean): void {
    const verticalFov = viewmodelFov(fov);
    if (this.camera.fov !== verticalFov) {
      this.camera.fov = verticalFov;
      this.camera.updateProjectionMatrix();
    }
    const [x, y, z] = minimized ? this.weapon?.stockOffset ?? [10, 0, -10] : [0, 0, 0];
    if (this.pose.position.x !== x || this.pose.position.y !== -y || this.pose.position.z !== z) {
      this.fishPhysics?.reset();
      this.poseDirty = true;
    }
    this.pose.position.set(x, -y, z);
  }

  update(delta: number): void {
    if (this.paused && !this.poseDirty) return;
    this.poseDirty = false;
    const animationDelta = this.paused ? 0 : delta;
    this.mixer?.update(animationDelta);
    this.root.updateMatrixWorld(true);
    if (this.bones.length < 2) return;
    mergeViewmodelBones(this.boneBindings[0]);
    if (this.fishPhysicsEnabled) this.fishPhysics?.update(animationDelta);
    for (let i = 1; i < this.boneBindings.length; i++) mergeViewmodelBones(this.boneBindings[i]);
  }

  setPlayback(paused: boolean, fishPhysics: boolean): void {
    this.paused = paused;
    if (fishPhysics !== this.fishPhysicsEnabled) {
      this.fishPhysics?.reset();
      this.poseDirty = true;
    }
    this.fishPhysicsEnabled = fishPhysics;
  }

  get animationPlaying(): boolean { return !this.paused; }

  get weaponAnchor(): THREE.Matrix4 { return this.bones[1]?.[0]?.matrixWorld ?? this.root.matrixWorld; }

  setOverlay(pass: 'sheen' | 'emissive', material: THREE.Material | null): void {
    for (const mesh of this.overlays[pass]) mesh.removeFromParent();
    this.overlays[pass] = [];
    if (!material) return;
    for (const source of this.paintMeshes) {
      const overlay = createViewmodelOverlay(source, material);
      source.parent?.add(overlay);
      this.overlays[pass].push(overlay);
    }
  }

  private releaseResources(): void {
    for (const gltf of this.gltfs) gltf.scene.traverse(object => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
      if (object instanceof THREE.SkinnedMesh) object.skeleton.dispose();
    });
    for (const material of this.materials) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.gltfs = []; this.materials = []; this.textures = [];
  }

  dispose(): void {
    this.disposed = true;
    this.root.removeFromParent();
    this.setOverlay('sheen', null);
    this.setOverlay('emissive', null);
    this.mixer?.stopAllAction();
    this.mixer?.uncacheRoot(this.mixer.getRoot());
    this.releaseResources();
  }
}
