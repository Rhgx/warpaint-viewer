import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WeaponMaterial, Team } from '../../data/types';
import { configureTf2Material, createTf2Uniforms, type Tf2Uniforms } from '../materialConfig';
import { installTf2VertexLit, TF2_VERTEXLIT_CACHE_KEY } from '../shaders/vertexlit';
import { advanceTimeline, createTimeline, locateOnTimeline, timelineBoundaries, type AnimationTimeline } from './animationTimeline';
import { FishBonePhysics, type FishJiggleSettings } from './fishPhysics';
import type { AttachmentTransformResolver } from '../particles';

const VIEWMODEL_DATA = `${import.meta.env.BASE_URL}data/viewmodels/`;

function isFulfilled<T>(result: PromiseSettledResult<T>): result is PromiseFulfilledResult<T> {
  return result.status === 'fulfilled';
}
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
  procedural?: 'minigun' | 'grenadeLauncher';
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

// Fraction of the canvas, from the top, that the portrait viewmodel frame centers
// in while the Controls sheet is open. It must match the sheet height in App.tsx.
// With the sheet closed the frame centers in the whole canvas (fraction 1).
export const FP_PORTRAIT_FRAME_CENTER = 0.55;

/**
 * Viewmodels are authored for a 4:3 frame, so a taller canvas would crop the weapon.
 * Returns the top of the full-width 4:3 frame, in pixels, when centered in the top
 * `center` fraction of the canvas; null for 4:3 or wider, which widens the view as Source does.
 */
export function viewmodelFrameTop(width: number, height: number, center: number): number | null {
  const frameHeight = width * 3 / 4;
  if (!(width > 0) || !(height > frameHeight)) return null;
  return Math.max(0, (height * center - frameHeight) / 2);
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
function createViewmodelOverlay(source: THREE.SkinnedMesh, material: THREE.Material): THREE.SkinnedMesh {
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
  private weaponMeshes: THREE.SkinnedMesh[] = [];
  private unusualBindings = new Map<number, { mesh: THREE.SkinnedMesh; bone: THREE.Bone; inverse: THREE.Matrix4 }>();
  private pose = new THREE.Group();
  private gltfs: GLTF[] = [];
  private materials: THREE.Material[] = [];
  private textures: THREE.Texture[] = [];
  private scrollingMaterials: Tf2Uniforms[] = [];
  private tf2Time = 0;
  private mixer: THREE.AnimationMixer | null = null;
  private bones: THREE.Bone[][] = [];
  private boneMaps: Map<string, THREE.Bone>[] = [];
  private boneBindings: ReturnType<typeof bindViewmodelBones>[] = [];
  private poseDirty = true;
  private disposed = false;
  private weapon: ViewmodelWeapon | null = null;
  private animationKey: string | null = null;
  private timeline: AnimationTimeline = createTimeline([]);
  private timelineActions: THREE.AnimationAction[] = [];
  private markers: readonly number[] = [];
  private loopRange: { readonly start: number; readonly end: number } | null = null;
  private position = 0;
  private speed = 1;
  private looping = true;
  private paused = false;
  private scrubbing = false;
  private resuming = false;
  private lastAnimationDelta = 0;
  private fishPhysicsEnabled = false;
  private fishPhysics: FishBonePhysics | null = null;
  private spinBarrel = false;
  private barrelAngle = 0;
  private barrelVelocity = 0;
  private barrelRotation = new THREE.Matrix4();
  private chamberAngle = 0;
  private chamberTarget = 0;
  private chamberRotating = false;
  private chamberRotation = new THREE.Matrix4();

  constructor() {
    // Source x forward, y left, z up -> Three x right, y up, z back.
    this.root.matrixAutoUpdate = false;
    this.root.matrix.set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);
    this.root.add(this.pose);
  }

  async load(arms: ViewmodelAsset, weapon: ViewmodelWeapon, team: Team,
    paint: THREE.Material, lens: THREE.Material, lighting: Tf2Uniforms, envMap: THREE.CubeTexture): Promise<void> {
    this.weapon = weapon;
    this.scrollingMaterials = [];
    this.tf2Time = 0;
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
    // Every request fulfilled above, so the filter only narrows the type.
    const gltfs = results.filter(isFulfilled).map(result => result.value);
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
          if (detailTexture && uniforms.uTf2DetailScroll.value.lengthSq() > 0) this.scrollingMaterials.push(uniforms);
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
        if (index === 1 && object instanceof THREE.SkinnedMesh) this.weaponMeshes.push(object);
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

  /** Several clips play as one sequence of a start, a loop and an end. */
  setAnimation(...names: string[]): void {
    const key = names.join();
    const mixer = this.mixer;
    if (key === this.animationKey || !mixer) return;
    const animations = this.gltfs.find(gltf => gltf.scene === this.pose.children[0])?.animations ?? [];
    const clips = names.flatMap(name => animations.find(entry => entry.name === name) ?? []);
    if (!clips.length || clips.length !== names.length) return;
    this.animationKey = key;
    this.poseDirty = true;
    this.fishPhysics?.reset();
    mixer.stopAllAction();
    this.timeline = createTimeline(clips.map(clip => clip.duration), clips.length > 1 ? 1 : 0);
    this.timelineActions = clips.map(clip => mixer.clipAction(clip));
    this.markers = timelineBoundaries(this.timeline);
    this.loopRange = clips.length > 1 ? { start: this.timeline.loopStart, end: this.timeline.loopEnd } : null;
    this.position = 0;
    // CTFGrenadeLauncher advances its procedural chamber from SendWeaponAnim
    // only for ACT_VM_PRIMARYATTACK. Reload bodygroups animate independently.
    this.chamberRotating = this.weapon?.procedural === 'grenadeLauncher'
      && names.some(name => name.includes('VM_PRIMARYATTACK'));
    // Keep an in-progress primary-attack turn alive when another animation is selected.
    // Source continues UpdateBarrelMovement independently of the current viewmodel sequence.
    if (this.chamberRotating) this.chamberTarget = this.chamberAngle + Math.PI / 3;
    this.update(0);
  }

  /** Poses from the position alone, so that a scrub lands on the same pose that playing through it shows. */
  private poseAtPosition(): void {
    const { index, local, blend } = locateOnTimeline(this.timeline, this.position);
    for (const [i, action] of this.timelineActions.entries()) {
      const weight = i === index ? blend : i === index - 1 ? 1 - blend : 0;
      if (weight === 0) {
        if (action.isScheduled()) action.stop();
        continue;
      }
      if (!action.isScheduled()) action.play();
      action.setEffectiveWeight(weight);
      action.time = i === index ? local : this.timeline.durations[i];
    }
    this.mixer?.update(0);
  }

  /**
   * Fits the camera to the canvas. `framed` keeps the whole 4:3 frame centered (or
   * lifted above a bottom panel of `bottom` px). A right panel of `right` px shifts
   * the view left so the weapon stays visible. Insets are CSS pixels; captures pass none.
   */
  fitCamera(width: number, height: number, framed: boolean, right = 0, bottom = 0): void {
    const camera = this.camera;
    const top = framed ? viewmodelFrameTop(width, height, bottom > 0 ? FP_PORTRAIT_FRAME_CENTER : 1) : null;
    const view = camera.view?.enabled ? camera.view : null;
    if (top !== null || right !== 0) {
      // On a tall canvas the full view is the 4:3 frame and the canvas is a
      // taller window onto it that starts `top` pixels above it.
      const fullHeight = top === null ? height : width * 3 / 4;
      const offsetY = top === null ? 0 : -top;
      if (!view || view.fullWidth !== width || view.fullHeight !== fullHeight || view.height !== height
        || view.offsetX !== right || view.offsetY !== offsetY) {
        camera.setViewOffset(width, fullHeight, right, offsetY, width, height);
      }
    } else if (view || camera.aspect !== width / height) {
      camera.aspect = width / height;
      camera.clearViewOffset();
    }
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
    this.lastAnimationDelta = 0;
    if (!this.animationPlaying && !this.poseDirty) return;
    this.poseDirty = false;
    // Frames sleep while held, so the first delta after one is the time asleep and not a frame's worth.
    const frameDelta = this.resuming ? Math.min(delta, 1 / 60) : delta;
    this.resuming = false;
    const animationDelta = this.animationPlaying ? frameDelta * this.speed : 0;
    this.lastAnimationDelta = animationDelta;
    this.tf2Time += animationDelta;
    for (const uniforms of this.scrollingMaterials) uniforms.uTf2Time.value = this.tf2Time;
    const { position, wraps, ended } = advanceTimeline(this.timeline, this.position, animationDelta, this.looping);
    this.position = position;
    if (ended) this.paused = true;
    if (this.chamberRotating) this.chamberTarget += Math.PI / 3 * wraps;
    this.poseAtPosition();
    this.root.updateMatrixWorld(true);
    if (this.bones.length < 2) return;
    mergeViewmodelBones(this.boneBindings[0]);
    const barrel = this.hasSpinningBarrel ? this.boneMaps[1].get('barrel') : undefined;
    if (barrel) {
      const targetVelocity = this.spinBarrel ? 20 : 0;
      // Source approaches the target by 0.1 per update. Use a 60 Hz equivalent
      // acceleration so the preview's ramp does not depend on render FPS.
      this.barrelVelocity += THREE.MathUtils.clamp(targetVelocity - this.barrelVelocity, -6 * animationDelta, 6 * animationDelta);
      this.barrelAngle = (this.barrelAngle + animationDelta * this.barrelVelocity) % (Math.PI * 2);
      barrel.matrixWorld.multiply(this.barrelRotation.makeRotationZ(this.barrelAngle));
      // Bonemerge has already posed the skeleton; carry children with the barrel.
      barrel.traverse(child => {
        if (child !== barrel && child.parent) child.matrixWorld.multiplyMatrices(child.parent.matrixWorld, child.matrix);
      });
    }
    const chamber = this.weapon?.procedural === 'grenadeLauncher'
      ? this.boneMaps[1].get('procedural_chamber') : undefined;
    if (chamber) {
      this.chamberAngle = THREE.MathUtils.damp(this.chamberAngle, this.chamberTarget, 10, animationDelta);
      chamber.matrixWorld.multiply(this.chamberRotation.makeRotationZ(this.chamberAngle));
      chamber.traverse(child => {
        if (child !== chamber && child.parent) child.matrixWorld.multiplyMatrices(child.parent.matrixWorld, child.matrix);
      });
    }
    if (this.fishPhysicsEnabled) this.fishPhysics?.update(animationDelta);
    for (let i = 1; i < this.boneBindings.length; i++) mergeViewmodelBones(this.boneBindings[i]);
  }

  setPlayback(paused: boolean, fishPhysics: boolean, speed = 1, looping = true): void {
    // Playing a finished animation starts it over, from before the loop whichever way Loop is set now.
    if (this.paused && !paused && this.position >= this.timeline.total) this.position = 0;
    this.setHeld(paused, this.scrubbing);
    this.speed = speed;
    this.looping = looping;
    if (fishPhysics !== this.fishPhysicsEnabled) {
      this.fishPhysics?.reset();
      this.poseDirty = true;
    }
    this.fishPhysicsEnabled = fishPhysics;
  }

  private setHeld(paused: boolean, scrubbing: boolean): void {
    if (!this.animationPlaying && !paused && !scrubbing) this.resuming = true;
    this.paused = paused;
    this.scrubbing = scrubbing;
  }

  /** Holds the animation whether or not it is paused, for as long as a drag lasts. */
  setScrubbing(scrubbing: boolean): void { this.setHeld(this.paused, scrubbing); }

  seek(position: number): void {
    this.position = Math.min(Math.max(position, 0), this.timeline.total);
    this.fishPhysics?.reset();
    this.poseDirty = true;
  }

  get animationPlaying(): boolean { return !this.paused && !this.scrubbing; }

  get playbackPosition(): number { return this.position; }

  get playbackDuration(): number { return this.timeline.total; }

  get playbackMarkers(): readonly number[] { return this.markers; }

  get playbackLoopRange(): { readonly start: number; readonly end: number } | null { return this.loopRange; }

  /** Playing with looping off pauses itself here, which the bar has to hear about. */
  get playbackEnded(): boolean {
    return !this.looping && this.paused && !this.scrubbing && this.timeline.total > 0 && this.position >= this.timeline.total;
  }

  get hasSpinningBarrel(): boolean { return this.weapon?.class === 'heavy' && !!this.boneMaps[1]?.has('barrel'); }

  setAppearance(showHands: boolean, spinBarrel: boolean): void {
    const arms = this.pose.children[0];
    if (arms) arms.visible = showHands;
    if (this.spinBarrel !== spinBarrel) this.poseDirty = true;
    this.spinBarrel = spinBarrel;
  }

  get weaponKey(): string | null { return this.weapon?.weaponKey ?? null; }

  /** The time the last update moved the animation by: none while held, and scaled by the speed. */
  get animationDelta(): number { return this.lastAnimationDelta; }

  /** Bone merge has already posed it each frame, so whatever hangs from it follows the animation. */
  get statClockBone(): THREE.Bone | null { return this.boneMaps[1]?.get('c_weapon_stattrack') ?? null; }

  get weaponAnchor(): THREE.Matrix4 { return this.bones[1]?.[0]?.matrixWorld ?? this.root.matrixWorld; }

  readonly resolveUnusualAnchor: AttachmentTransformResolver = (index, attachment, target) => {
    let binding = this.unusualBindings.get(index);
    if (!binding) {
      if (!attachment.bone) return false;
      for (const mesh of this.weaponMeshes) {
        const boneIndex = mesh.skeleton.bones.findIndex(bone => bone.name === attachment.bone);
        if (boneIndex >= 0) {
          const bone = mesh.skeleton.bones[boneIndex];
          const inverse = mesh.skeleton.boneInverses[boneIndex];
          if (bone && inverse) binding = { mesh, bone, inverse };
          break;
        }
      }
      if (!binding) return false;
      this.unusualBindings.set(index, binding);
    }
    target.copy(binding.bone.matrixWorld).multiply(binding.inverse).multiply(binding.mesh.bindMatrix);
    return true;
  };

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
    this.gltfs = []; this.materials = []; this.textures = []; this.scrollingMaterials = [];
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
