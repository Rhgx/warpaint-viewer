import * as THREE from 'three';
import type { FirstPersonPreview } from '../firstPerson/firstPerson';
import { getSheen } from '../presets';
import {
  loadSheenAssets,
  createSheenMaterial,
  SHEEN_SWEEP_SECONDS,
  SHEEN_PAUSE_SECONDS,
  SHEEN_FRAMERATE,
  SHEEN_MASK_FRAMES,
} from './sheen';
import type { SheenAssets, SheenFrameData } from './sheen';

/** What the killstreak sheen reads from the Viewer that owns it. */
export interface SheenOverlayHost {
  readonly centerGroup: THREE.Group;
  /** The arrays are replaced on every model load, so read them on each use. */
  readonly getMeshes: () => THREE.Mesh[];
  readonly getMeshIsLens: () => boolean[];
  readonly getMaterialSide: () => THREE.Side;
  readonly getFirstPerson: () => FirstPersonPreview | null;
  readonly isDisposed: () => boolean;
  readonly invalidate: () => void;
}

export class SheenOverlay {
  private readonly host: SheenOverlayHost;

  // Killstreak sheen: a second-pass material over per-mesh clones of the weapon
  // geometry, created lazily on first enable and kept for the Viewer's lifetime.
  private sheenId = 'none';
  private sheenTeam: 'red' | 'blu' = 'red';
  private sheenAssets: SheenAssets | null = null;
  private sheenAssetsPromise: Promise<SheenAssets> | null = null;
  private sheenMaterial: THREE.ShaderMaterial | null = null;
  private sheenMeshes: THREE.Mesh[] = [];
  private sheenElapsed = 0;
  private sheenLastTime = performance.now();
  private sheenFrameData: SheenFrameData = { scaleX: 1, offsetX: 0, scaleY: 1, offsetY: 0, sweepAxis: 0, sideAxis: 1 };

  constructor(host: SheenOverlayHost) {
    this.host = host;
  }

  get active(): boolean {
    return this.sheenId !== 'none' && this.sheenMaterial !== null;
  }

  get material(): THREE.ShaderMaterial | null {
    return this.sheenMaterial;
  }

  get meshes(): readonly THREE.Mesh[] {
    return this.sheenMeshes;
  }

  get elapsed(): number {
    return this.sheenElapsed;
  }

  // The performance.now() at which `elapsed` was last advanced.
  get sampledAt(): number {
    return this.sheenLastTime;
  }

  /** Restarts the sweep clock at the given time, so hidden or suspended time does not advance it. */
  resetClock(now: number): void {
    this.sheenLastTime = now;
  }

  setFrameData(data: SheenFrameData): void {
    this.sheenFrameData = data;
    this.updateSheenFrameUniforms();
  }

  dispose(): void {
    this.sheenMaterial?.dispose();
    this.sheenMaterial = null;
    this.sheenAssets?.maskTexture.dispose();
    this.sheenAssets?.cubeTexture.dispose();
    this.sheenAssets = null;
  }

  setSheen(sheenId: string, team: 'red' | 'blu') {
    const wasOff = this.sheenId === 'none';
    this.sheenId = sheenId;
    this.sheenTeam = team;
    this.host.invalidate();
    if (sheenId === 'none') {
      this.teardownSheenMeshes();
      return;
    }
    if (wasOff) {
      this.sheenElapsed = 0;
      this.sheenLastTime = performance.now();
    }
    void this.ensureSheenReady().then(() => {
      if (this.host.isDisposed() || this.sheenId === 'none') return;
      this.rebuildSheenMeshes();
      this.host.invalidate();
    });
  }

  private ensureSheenReady(): Promise<void> {
    if (this.sheenAssets) return Promise.resolve();
    if (!this.sheenAssetsPromise) {
      this.sheenAssetsPromise = loadSheenAssets().catch((err) => {
        console.warn('[warpaint-viewer] killstreak sheen assets unavailable; sheen disabled:', err);
        this.sheenAssetsPromise = null;
        throw err;
      });
    }
    return this.sheenAssetsPromise
      .then((assets) => {
        if (this.host.isDisposed()) return;
        this.sheenAssets = assets;
        this.sheenMaterial = createSheenMaterial(assets, this.host.getMaterialSide());
      })
      .catch(() => undefined);
  }

  teardownSheenMeshes() {
    this.host.getFirstPerson()?.setOverlay('sheen', null);
    for (const mesh of this.sheenMeshes) this.host.centerGroup.remove(mesh);
    this.sheenMeshes = [];
  }

  rebuildSheenMeshes() {
    this.teardownSheenMeshes();
    if (this.sheenId === 'none' || !this.sheenMaterial) return;
    this.host.getFirstPerson()?.setOverlay('sheen', this.sheenMaterial);
    for (let i = 0; i < this.host.getMeshes().length; i++) {
      if (this.host.getMeshIsLens()[i]) continue;
      const mesh = new THREE.Mesh(this.host.getMeshes()[i].geometry, this.sheenMaterial);
      mesh.renderOrder = 1;
      this.host.centerGroup.add(mesh);
      this.sheenMeshes.push(mesh);
    }
    this.updateSheenFrameUniforms();
    this.updateSheenTint();
  }

  private updateSheenFrameUniforms() {
    if (!this.sheenMaterial) return;
    const u = this.sheenMaterial.uniforms;
    u.uMaskScale.value.set(this.sheenFrameData.scaleX, this.sheenFrameData.scaleY);
    u.uMaskOffset.value.set(this.sheenFrameData.offsetX, this.sheenFrameData.offsetY);
    u.uSweepAxis.value = this.sheenFrameData.sweepAxis;
    u.uSideAxis.value = this.sheenFrameData.sideAxis;
  }

  private updateSheenTint() {
    if (!this.sheenMaterial) return;
    const preset = getSheen(this.sheenId);
    const rgb = this.sheenTeam === 'blu' ? preset.blu : preset.red;
    this.sheenMaterial.uniforms.uTint.value.set(rgb[0], rgb[1], rgb[2], 1);
  }

  // Sweep timing (CProxyAnimatedWeaponSheen): 60 mask frames at 25 fps, then
  // invisible for 5s with no killstreak owner (the inspect case), then loop.
  // `dt` overrides wall-clock time for deterministic captures.
  updateSheenAnimation(dt?: number) {
    if (this.sheenId === 'none' || !this.sheenMaterial) return;
    const now = performance.now();
    this.sheenElapsed += dt ?? (now - this.sheenLastTime) / 1000;
    this.sheenLastTime = now;
    const cycle = SHEEN_SWEEP_SECONDS + SHEEN_PAUSE_SECONDS;
    const tInCycle = this.sheenElapsed % cycle;
    const sweeping = tInCycle < SHEEN_SWEEP_SECONDS;
    for (const mesh of this.sheenMeshes) mesh.visible = sweeping;
    for (const mesh of this.host.getFirstPerson()?.overlays.sheen ?? []) mesh.visible = sweeping;
    if (sweeping) {
      this.sheenMaterial.uniforms.uFrame.value = Math.min(SHEEN_MASK_FRAMES - 1, Math.floor(SHEEN_FRAMERATE * tInCycle));
    }
  }
}
