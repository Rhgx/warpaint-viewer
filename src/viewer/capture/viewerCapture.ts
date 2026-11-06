import * as THREE from 'three';

import type { EmissiveOverlay } from '../overlays/emissiveOverlay';
import type { FirstPersonStage } from '../firstPersonStage';
import type { InspectControls } from '../inspectControls';
import type { LightEditor } from '../lighting/lightEditor';
import type { UnusualEffect } from '../particles';
import { setParticlePointScale } from '../particles';
import type { SheenOverlay } from '../overlays/sheenOverlay';
import type { WeaponAttachments } from '../weaponAttachments';
import type { StatClock } from '../statClock';
import { TOUCH_ONLY_DEVICE } from '../../device';
import { TurntableStoppedError } from '../../export/turntableFormats';
import {
  fitScreenshotCapture,
  resolveScreenshotCapture,
  screenshotPixelsToBlob,
  TurntableFrameResolver,
  unionContentBounds,
  type ScreenshotSize,
} from './capture';

export interface TurntableOptions {
  /** Output long edge in pixels. */
  readonly maxEdge: number;
  readonly fps: number;
  /** Duration of one full revolution. */
  readonly seconds: number;
  /** 0xRRGGBB solid background, or null for transparent frames. */
  readonly background: number | null;
  /** Transparency the output format holds (see TurntableFrameResolver). */
  readonly alpha: 'binary' | 'full';
  /** Render palette samples before the frames (GIF needs its palette up front). */
  readonly paletteSamples: boolean;
}

/** Receives a turntable capture as it renders. */
export interface TurntableSink {
  /** Called once, before any frame, with the output size and any palette samples. */
  start(info: { width: number; height: number; frames: number; fps: number }, samples: Uint8Array[]): void;
  /** Each output frame in order (ownership passes on); resolves when more may follow. */
  frame(rgba: Uint8Array): Promise<void>;
}

/**
 * Above 6x + MSAA the checkerboard error barely drops (8x is 0.006 at the 99th
 * percentile), so GPU memory across the MSAA target is the real limit.
 */
const TURNTABLE_MAX_SUPERSAMPLE = 8;
/**
 * ~190 MB of color and depth samples on desktop. Phones get a third: their GPU
 * memory is shared with a tab the browser kills well before a desktop would.
 */
const TURNTABLE_SAMPLE_BUDGET = TOUCH_ONLY_DEVICE ? 8_000_000 : 24_000_000;
/** Low-resolution sweep that finds the turntable crop. */
const TURNTABLE_PROBE_EDGE = 320;
const TURNTABLE_PROBE_STEPS = 36;
/** Frames rendered up front to fit the shared GIF palette. Each is held until the encoder starts, so phones use fewer. */
const TURNTABLE_PALETTE_SAMPLES = TOUCH_ONLY_DEVICE ? 16 : 40;
/** Crossfade length hiding the loop seam of time-driven effects. */
const TURNTABLE_SEAM_SECONDS = 0.5;
const TURNTABLE_SEAM_BUDGET_BYTES = (TOUCH_ONLY_DEVICE ? 24 : 64) * 1024 * 1024;
/** Widest probe frustum, in viewport sizes, before a sweep is clipped. */
const TURNTABLE_MAX_REACH = 27;

/** What screenshot and turntable capture read and write on the Viewer that owns them. */
export interface ViewerCaptureHost {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly orthoCamera: THREE.OrthographicCamera;
  readonly centerGroup: THREE.Group;
  readonly controls: Pick<InspectControls, 'getCameraMode' | 'getDistance' | 'setDistance' | 'rotateYaw'>;
  readonly lightEditor: Pick<LightEditor, 'setCaptureMode'>;
  readonly firstPersonStage: Pick<FirstPersonStage, 'preview' | 'renderFirstPerson'>;
  readonly sheen: Pick<SheenOverlay, 'active' | 'meshes' | 'updateSheenAnimation'>;
  readonly emissive: Pick<EmissiveOverlay, 'stepEmissive'>;
  readonly weaponAttachments: Pick<WeaponAttachments, 'stepAttachments'>;
  readonly statClock: Pick<StatClock, 'step'>;
  /** The effect is replaced when the unusual changes, so read it on each use. */
  readonly getActiveUnusual: () => UnusualEffect | null;
  /** The projection can change between captures, so read it on each use. */
  readonly getProjectionMode: () => 'perspective' | 'orthographic';
  /** The inset changes as panels open, so read it on each use. */
  readonly getViewInset: () => { readonly right: number; readonly bottom: number };
  readonly applyViewInset: (right: number, bottom: number) => void;
  readonly syncOrthoCamera: () => void;
  readonly isContextLost: () => boolean;
  readonly isDisposed: () => boolean;
  /** The Viewer keeps this flag because its render loop yields to a running capture. */
  readonly isTurntableCapturing: () => boolean;
  readonly setTurntableCapturing: (capturing: boolean) => void;
  readonly invalidate: () => void;
}

/** Renders screenshots and turntables through the Viewer's renderer and restores its state after. */
export class ViewerCapture {
  private readonly host: ViewerCaptureHost;

  constructor(host: ViewerCaptureHost) {
    this.host = host;
  }

  // Renders at the viewport aspect with no background so the PNG keeps alpha. Numeric sizes
  // and presets crop the same way, then resize to the longest-edge tier. The offscreen target
  // leaves the live loop alone.
  //
  // toBlob() cannot encode this buffer: additive passes leave destination alpha untouched,
  // and its unpremultiply turns those bright pixels into garbage. PNG cannot hold additive
  // light either, so each pixel is an "over" approximation: alpha = max(alpha, r, g, b).
  async captureScreenshot(size: number | ScreenshotSize): Promise<Blob> {
    // A lost context reads back as all zeros: an empty image, not an error.
    if (this.host.isContextLost()) throw new Error('The graphics context was lost; try again once the view reappears');
    const w = this.host.canvas.clientWidth || 1;
    const h = this.host.canvas.clientHeight || 1;
    // ponytail: cap the working target at an 8K pixel budget; tile the render
    // if native 16K detail ever becomes a real requirement.
    const { width, height, paddingScale, outputMaxEdge } = fitScreenshotCapture(
      resolveScreenshotCapture(size, w, h),
      this.host.renderer.capabilities.maxTextureSize,
      7680 * 4320,
    );
    const target = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: true,
      stencilBuffer: false,
      // Large exports already carry enough edge detail, and multisampling would
      // multiply their GPU memory cost.
      samples: width * height <= 2560 * 1440 ? 4 : 0,
    });
    target.texture.colorSpace = this.host.renderer.outputColorSpace;
    const prevTarget = this.host.renderer.getRenderTarget();
    const prevBackground = this.host.scene.background;
    const raw = new Uint8Array(width * height * 4);
    try {
      this.host.lightEditor.setCaptureMode(true);
      this.host.scene.background = null;
      setParticlePointScale(height);
      this.host.renderer.setRenderTarget(target);
      // Captures frame the whole canvas, not the area a mobile panel leaves.
      this.host.applyViewInset(0, 0);
      if (this.host.firstPersonStage.preview) {
        this.host.firstPersonStage.renderFirstPerson(0, 0);
      } else if (this.host.getProjectionMode() === 'orthographic') {
        this.host.syncOrthoCamera();
        this.host.renderer.render(this.host.scene, this.host.orthoCamera);
      } else {
        this.host.renderer.render(this.host.scene, this.host.camera);
      }
      this.host.renderer.readRenderTargetPixels(target, 0, 0, width, height, raw);
    } finally {
      this.host.applyViewInset(this.host.getViewInset().right, this.host.getViewInset().bottom);
      this.host.renderer.setRenderTarget(prevTarget);
      this.host.scene.background = prevBackground;
      this.host.lightEditor.setCaptureMode(false);
      setParticlePointScale(h * this.host.renderer.getPixelRatio());
      target.dispose();
    }

    return screenshotPixelsToBlob(raw, width, height, paddingScale, outputMaxEdge, !!this.host.firstPersonStage.preview);
  }

  /**
   * Renders one turntable revolution (yaw only) and streams it to `sink` as
   * top-down RGBA frames, held at the framed zoom or farther. If sheens, particles
   * or emissives run, the overrun crossfades into the start to hide the loop seam.
   */
  async captureTurntable(
    { maxEdge, fps, seconds, background, alpha, paletteSamples }: TurntableOptions,
    sink: TurntableSink,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.host.firstPersonStage.preview) throw new Error('Turntable GIFs need the Inspect view');
    if (this.host.isTurntableCapturing()) throw new Error('A turntable capture is already running');
    // Let the caller's busy state paint before the synchronous probe (the
    // timeout covers hidden tabs, where animation frames never come).
    await new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
      setTimeout(resolve, 100);
    });
    if (this.host.isDisposed()) throw new Error('Viewer disposed');

    const viewW = this.host.canvas.clientWidth || 1;
    const viewH = this.host.canvas.clientHeight || 1;
    const distance = this.host.controls.getDistance();
    this.host.controls.setDistance(Math.max(distance.current, distance.framed));
    const camera = this.host.getProjectionMode() === 'orthographic' ? this.host.orthoCamera : this.host.camera;
    if (camera === this.host.orthoCamera) this.host.syncOrthoCamera();
    const cameraMode = this.host.controls.getCameraMode();
    // The page stays live during the capture, so aborting `signal`, a resize or a
    // camera switch stops it, since any of them would warp every later frame.
    const checkInterrupted = () => {
      if (this.host.isDisposed()) throw new Error('Viewer disposed');
      if (signal?.aborted) throw new TurntableStoppedError(String(signal.reason ?? 'Cancelled'));
      if (this.host.canvas.clientWidth !== viewW || this.host.canvas.clientHeight !== viewH) {
        throw new TurntableStoppedError('The viewer was resized');
      }
      if (this.host.controls.getCameraMode() !== cameraMode) throw new TurntableStoppedError('The camera mode changed');
      if (this.host.isContextLost()) throw new TurntableStoppedError('The graphics context was lost');
    };
    const frameCount = Math.max(2, Math.round(seconds * fps));
    const dt = 1 / fps;
    const sheenActive = this.host.sheen.active && this.host.sheen.meshes.length > 0;
    const animated = !!this.host.getActiveUnusual() || sheenActive || this.host.emissive.stepEmissive(0) || this.host.weaponAttachments.stepAttachments(0) || this.host.statClock.step(0);
    const prevTarget = this.host.renderer.getRenderTarget();
    const prevBackground = this.host.scene.background;
    const prevPointerEvents = this.host.canvas.style.pointerEvents;
    const disposables: { dispose(): void }[] = [];
    const renderTarget = (width: number, height: number, samples: number) => {
      const target = new THREE.WebGLRenderTarget(width, height, { depthBuffer: true, stencilBuffer: false, samples });
      target.texture.colorSpace = this.host.renderer.outputColorSpace;
      disposables.push(target);
      return target;
    };
    this.host.setTurntableCapturing(true);
    this.host.canvas.style.pointerEvents = 'none';
    this.host.lightEditor.setCaptureMode(true);
    this.host.scene.background = null;
    try {
      // Probe: finds the screen area the model sweeps, at low resolution, through a
      // frustum `reach` viewports wide that widens again if the sweep touches its border.
      let reach = 3;
      let box: number[] = [];
      let probeScale = 1;
      for (;;) {
        probeScale = TURNTABLE_PROBE_EDGE / (reach * Math.max(viewW, viewH));
        const probeW = Math.max(1, Math.round(reach * viewW * probeScale));
        const probeH = Math.max(1, Math.round(reach * viewH * probeScale));
        const probe = renderTarget(probeW, probeH, 0);
        const probeRaw = new Uint8Array(probeW * probeH * 4);
        box = [probeW, probeH, -1, -1];
        const margin = (reach - 1) / 2;
        camera.setViewOffset(viewW, viewH, -margin * viewW, -margin * viewH, reach * viewW, reach * viewH);
        setParticlePointScale(viewH * probeScale);
        this.host.renderer.setRenderTarget(probe);
        for (let i = 0; i < TURNTABLE_PROBE_STEPS; i++) {
          this.host.controls.rotateYaw((Math.PI * 2) / TURNTABLE_PROBE_STEPS);
          this.host.renderer.render(this.host.scene, camera);
          this.host.renderer.readRenderTargetPixels(probe, 0, 0, probeW, probeH, probeRaw);
          unionContentBounds(probeRaw, probeW, probeH, box);
        }
        if (box[2] < 0) throw new Error('Nothing to capture');
        const touches = box[0] === 0 || box[1] === 0 || box[2] === probeW - 1 || box[3] === probeH - 1;
        // Viewport pixels; the sweep may start left of or above the viewport.
        const x = (px: number) => px / probeScale - margin * viewW;
        const y = (px: number) => px / probeScale - margin * viewH;
        box = [x(box[0]), y(box[1]), x(box[2] + 1), y(box[3] + 1)];
        if (!touches || reach >= TURNTABLE_MAX_REACH) break;
        reach *= 3;
      }

      // Crop in viewport pixels, padded for probe resolution and for anything
      // (particles, the angles between probe steps) that strays a little.
      const pad = 0.05 * Math.max(box[2] - box[0], box[3] - box[1]) + 1 / probeScale;
      const cropX = box[0] - pad;
      const cropY = box[1] - pad;
      const cropW = box[2] - box[0] + 2 * pad;
      const cropH = box[3] - box[1] + 2 * pad;

      const outScale = maxEdge / Math.max(cropW, cropH);
      const width = Math.max(1, Math.round(cropW * outScale));
      const height = Math.max(1, Math.round(cropH * outScale));
      // As many samples as the GPU budget allows. The paint has no mipmaps (as in
      // TF2's inspect panel), so only real subsamples stop a minified pattern sparkling.
      // MSAA on top still halves the remaining edge error.
      const msaa = Math.min(4, this.host.renderer.capabilities.maxSamples);
      const ss = Math.max(1, Math.min(
        TURNTABLE_MAX_SUPERSAMPLE,
        Math.floor(Math.sqrt(TURNTABLE_SAMPLE_BUDGET / (width * height * Math.max(1, msaa)))),
        Math.floor(this.host.renderer.capabilities.maxTextureSize / Math.max(width, height)),
      ));
      const target = renderTarget(width * ss, height * ss, msaa);
      const resolver = new TurntableFrameResolver(width, height, ss, background, alpha);
      disposables.push(resolver);
      const renderScale = outScale * ss;
      camera.setViewOffset(viewW * renderScale, viewH * renderScale, cropX * renderScale, cropY * renderScale, width * ss, height * ss);
      // Seam frames sit on the GPU (8 bytes per output pixel) until the overrun reaches
      // them; large captures get a shorter crossfade instead of more memory.
      const seamFrames = animated
        ? Math.min(Math.round(TURNTABLE_SEAM_SECONDS * fps), Math.floor(frameCount / 4), Math.floor(TURNTABLE_SEAM_BUDGET_BYTES / (width * height * 8)))
        : 0;
      const render = () => {
        // Other viewers share the particle scale uniform and may have drawn while we
        // awaited the sink. three r185 re-resolves a multisampled target only after it is
        // bound again, or repeated renders read back the first frame.
        setParticlePointScale(viewH * renderScale);
        this.host.renderer.setRenderTarget(target);
        this.host.renderer.render(this.host.scene, camera);
      };

      const advance = () => {
        this.host.controls.rotateYaw((Math.PI * 2) / frameCount);
        this.host.sheen.updateSheenAnimation(dt);
        this.host.emissive.stepEmissive(dt);
        this.host.weaponAttachments.stepAttachments(dt);
        this.host.statClock.step(dt);
        const unusual = this.host.getActiveUnusual();
        if (unusual) {
          this.host.centerGroup.updateWorldMatrix(true, false);
          unusual.updateAnchor(this.host.centerGroup.matrixWorld);
          unusual.update(dt);
        }
      };

      // Palette samples come from a rehearsal turn, simulated at full rate and rendered
      // every few frames, so they match the capture's poses and effects. The palette
      // must exist before the frames stream out.
      const samples: Uint8Array[] = [];
      const sampleCount = Math.min(TURNTABLE_PALETTE_SAMPLES, frameCount);
      for (let f = 0, next = 0; paletteSamples && f < frameCount; f++) {
        if (f === Math.floor((next * frameCount) / sampleCount)) {
          render();
          samples.push(resolver.resolve(this.host.renderer, target.texture));
          next++;
        }
        advance();
      }
      sink.start({ width, height, frames: frameCount, fps }, samples);

      // Output: the turn from `seamFrames` on, then overrun frames blended into the held
      // opening frames, so both loop joins are continuous.
      for (let f = 0; f < frameCount + seamFrames; f++) {
        checkInterrupted();
        render();
        if (f < seamFrames) {
          resolver.hold(this.host.renderer, target.texture, f);
        } else {
          const blend = f >= frameCount ? { slot: f - frameCount, t: (f - frameCount + 1) / (seamFrames + 1) } : undefined;
          await sink.frame(resolver.resolve(this.host.renderer, target.texture, blend));
        }
        advance();
      }
    } finally {
      camera.clearViewOffset();
      this.host.controls.setDistance(distance.current);
      this.host.scene.background = prevBackground;
      this.host.renderer.setRenderTarget(prevTarget);
      this.host.lightEditor.setCaptureMode(false);
      setParticlePointScale(viewH * this.host.renderer.getPixelRatio());
      for (const disposable of disposables) disposable.dispose();
      this.host.canvas.style.pointerEvents = prevPointerEvents;
      this.host.setTurntableCapturing(false);
      this.host.invalidate();
    }
  }
}
