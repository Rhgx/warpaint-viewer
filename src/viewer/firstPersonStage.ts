import * as THREE from 'three';
import type { FirstPersonPreview, ViewmodelAsset, ViewmodelWeapon } from './firstPerson/firstPerson';
import type { InspectControls } from './inspectControls';
import type { Tf2Uniforms } from './materialConfig';
import type { UnusualEffect } from './particles';
import type { EmissiveOverlay } from './overlays/emissiveOverlay';
import type { SheenOverlay } from './overlays/sheenOverlay';

/** What the first-person stage reads from the Viewer that owns it. */
export interface FirstPersonStageHost {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly lightGroup: THREE.Group;
  readonly controls: Pick<InspectControls, 'setPreviewActive'>;
  readonly material: THREE.MeshPhongMaterial;
  readonly lensMaterial: THREE.MeshPhysicalMaterial;
  readonly tf2Uniforms: Tf2Uniforms;
  /** The environment map changes with each material load, so read it on each use. */
  readonly getEnvMap: () => THREE.CubeTexture;
  /** The viewmodel shows the sheen only while one is selected. */
  readonly sheen: Pick<SheenOverlay, 'active' | 'material'>;
  readonly emissive: Pick<EmissiveOverlay, 'enabled' | 'material'>;
  /** The unusual effect is replaced when the unusual changes, so read it on each use. */
  readonly getActiveUnusual: () => UnusualEffect | null;
  readonly isDisposed: () => boolean;
  readonly invalidate: () => void;
  readonly onPreviewChange: () => void;
}

export interface FirstPersonPlayback {
  position: number;
  duration: number;
  markers: readonly number[];
  /** Only a sequence has one: a single clip's loop is all of it, which nothing needs to mark. */
  loopRange: { readonly start: number; readonly end: number } | null;
  ended: boolean;
}

export type FirstPersonPlaybackListener = (playback: FirstPersonPlayback) => void;

export class FirstPersonStage {
  private readonly host: FirstPersonStageHost;
  private firstPerson: FirstPersonPreview | null = null;
  private pendingFirstPerson: FirstPersonPreview | null = null;
  private firstPersonToken = 0;
  private playbackListener: FirstPersonPlaybackListener | null = null;
  private published: FirstPersonPlayback | null = null;

  constructor(host: FirstPersonStageHost) {
    this.host = host;
  }

  get preview(): FirstPersonPreview | null {
    return this.firstPerson;
  }

  async showFirstPerson(arms: ViewmodelAsset, weapon: ViewmodelWeapon, team: 'red' | 'blu'): Promise<void> {
    this.clearFirstPerson();
    const token = this.firstPersonToken;
    const { FirstPersonPreview } = await import('./firstPerson/firstPerson');
    if (token !== this.firstPersonToken || this.host.isDisposed()) return;
    const preview = new FirstPersonPreview();
    this.pendingFirstPerson = preview;
    try {
      await preview.load(arms, weapon, team, this.host.material, this.host.lensMaterial, this.host.tf2Uniforms, this.host.getEnvMap());
      if (token !== this.firstPersonToken || this.host.isDisposed()) { preview.dispose(); return; }
      this.pendingFirstPerson = null;
      this.firstPerson = preview;
      this.host.onPreviewChange();
      this.host.scene.add(preview.root);
      preview.setOverlay('sheen', this.host.sheen.active ? this.host.sheen.material : null);
      preview.setOverlay('emissive', this.host.emissive.enabled ? this.host.emissive.material : null);
      this.host.getActiveUnusual()?.notifyTeleport();
      this.host.controls.setPreviewActive(true);
      this.host.invalidate();
    } catch (error) {
      preview.dispose();
      if (this.pendingFirstPerson === preview) this.pendingFirstPerson = null;
      throw error;
    }
  }

  clearFirstPerson(): void {
    this.firstPersonToken++;
    this.pendingFirstPerson?.dispose();
    this.pendingFirstPerson = null;
    const preview = this.firstPerson;
    this.firstPerson = null;
    // Before the dispose, which frees every mesh under the viewmodel: what hangs from its bones may be shared.
    this.host.onPreviewChange();
    preview?.dispose();
    this.host.getActiveUnusual()?.notifyTeleport();
    this.host.controls.setPreviewActive(false);
    this.host.invalidate();
  }

  get hasSpinningBarrel(): boolean { return this.firstPerson?.hasSpinningBarrel ?? false; }

  configureFirstPerson(fov: number, minimized: boolean, animation: readonly string[], paused: boolean, fishPhysics: boolean, showHands: boolean, spinBarrel: boolean, speed: number, looping: boolean): void {
    this.host.getActiveUnusual()?.notifyTeleport();
    this.firstPerson?.setPlayback(paused, fishPhysics, speed, looping);
    this.firstPerson?.setAppearance(showHands, spinBarrel);
    this.firstPerson?.setView(fov, minimized);
    this.firstPerson?.setAnimation(...animation);
    this.host.invalidate();
  }

  seek(position: number): void {
    this.firstPerson?.seek(position);
    this.host.invalidate();
  }

  setScrubbing(scrubbing: boolean): void {
    this.firstPerson?.setScrubbing(scrubbing);
    this.host.invalidate();
  }

  /** The player bar's one listener. It hears only frames that moved something, so never while rendering sleeps. */
  subscribePlayback(listener: FirstPersonPlaybackListener): () => void {
    this.playbackListener = listener;
    this.published = null;
    this.publishPlayback();
    return () => { if (this.playbackListener === listener) this.playbackListener = null; };
  }

  publishPlayback(): void {
    const preview = this.firstPerson;
    if (!preview || !this.playbackListener) return;
    const last = this.published;
    if (last && last.position === preview.playbackPosition && last.duration === preview.playbackDuration
      && last.markers === preview.playbackMarkers && last.loopRange === preview.playbackLoopRange && last.ended === preview.playbackEnded) return;
    this.published = {
      position: preview.playbackPosition,
      duration: preview.playbackDuration,
      markers: preview.playbackMarkers,
      loopRange: preview.playbackLoopRange,
      ended: preview.playbackEnded,
    };
    this.playbackListener(this.published);
  }

  // Only the phone portrait layout, where the Controls sheet covers the canvas
  // bottom, keeps the viewmodel's whole 4:3 frame. Elsewhere the 4:3 vertical FOV
  // fits the canvas height, as in Source.
  private portraitSheetLayout = window.matchMedia?.('(max-width: 860px) and (orientation: portrait)') ?? null;
  private previewChildren: THREE.Object3D[] = [];
  private previewVisibility: boolean[] = [];
  private previewLightPosition = new THREE.Vector3();
  private previewLightRotation = new THREE.Quaternion();

  // `right` and `bottom` are the live view inset; a capture renders through
  // here too, at the canvas aspect, and passes zeros for the centred frame.
  renderFirstPerson(right: number, bottom: number): void {
    const preview = this.firstPerson;
    if (!preview) return;
    preview.fitCamera(this.host.canvas.clientWidth || 1, this.host.canvas.clientHeight || 1, this.portraitSheetLayout?.matches === true, right, bottom);
    const visibility = this.previewVisibility;
    const children = this.previewChildren;
    this.previewLightPosition.copy(this.host.lightGroup.position);
    this.previewLightRotation.copy(this.host.lightGroup.quaternion);
    try {
      // Particles stay at the scene root so they can trail the animated attachment.
      for (let i = 0; i < this.host.scene.children.length; i++) {
        const child = this.host.scene.children[i];
        children[i] = child;
        visibility[i] = child.visible;
        child.visible = child === preview.root || child === this.host.lightGroup || child === this.host.getActiveUnusual()?.object;
      }
      this.host.sheen.material?.uniforms.uSheenModelTransform.value.copy(preview.weaponBindInverse);
      this.host.lightGroup.position.set(0, 0, 0);
      this.host.lightGroup.quaternion.identity();
      this.host.renderer.render(this.host.scene, preview.camera);
    } finally {
      this.host.sheen.material?.uniforms.uSheenModelTransform.value.identity();
      for (let i = 0; i < children.length; i++) children[i].visible = visibility[i];
      children.length = 0;
      this.host.lightGroup.position.copy(this.previewLightPosition);
      this.host.lightGroup.quaternion.copy(this.previewLightRotation);
    }
  }
}
