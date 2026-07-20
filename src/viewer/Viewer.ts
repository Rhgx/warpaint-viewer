import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getPreset } from './lighting';
import { loadEditorEnvCube, makeEnvCube } from './env';
import { InspectControls } from './inspectControls';
import { getSheen } from './presets';
import type { ViewAnglePreset } from './presets';
import {
  loadSheenAssets,
  createSheenMaterial,
  computeSheenFrameData,
  SHEEN_SWEEP_SECONDS,
  SHEEN_PAUSE_SECONDS,
  SHEEN_FRAMERATE,
  SHEEN_MASK_FRAMES,
} from './sheen';
import type { SheenAssets, SheenFrameData } from './sheen';
import { createUnusualEffect, setParticlePointScale } from './particles';
import type { UnusualEffect } from './particles';
import type { WeaponMaterial } from '../data/types';

// three.js viewer with TF2's important VertexLitGeneric/Skin controls layered
// onto MeshPhongMaterial: base-alpha phong mask, exponent/lightwarp textures,
// optional tangent normal, albedo tint, Fresnel, rim light, and env-map mask.
// Interaction is handled by InspectControls (model rotates, camera stays fixed,
// like the in-game inspect panel). The model never moves on its own.
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: InspectControls;
  private lightGroup = new THREE.Group();
  private modelGroup = new THREE.Group(); // rotated/panned by InspectControls
  private centerGroup = new THREE.Group(); // offsets the mesh so its center sits at the origin
  private material: THREE.MeshPhongMaterial;
  private lensMaterial = new THREE.MeshPhysicalMaterial({
    color: 0x111820,
    roughness: 0.08,
    metalness: 0,
    transmission: 0.92,
    thickness: 0.18,
    ior: 1.33,
    transparent: true,
    opacity: 0.72,
    side: THREE.DoubleSide,
    envMapIntensity: 1,
  });
  private meshes: THREE.Mesh[] = [];
  private envMap: THREE.CubeTexture;
  private envReady: Promise<void>;
  private gltfLoader = new GLTFLoader();
  private texLoader = new THREE.TextureLoader();
  private normalTexture: THREE.Texture | null = null;
  private exponentTexture: THREE.Texture | null = null;
  private lightwarpTexture: THREE.Texture | null = null;
  private selfIllumTexture: THREE.Texture | null = null;
  private materialLoadToken = 0;
  private tf2Uniforms = {
    uTf2PhongEnabled: { value: 0 },
    uTf2BaseAlphaPhongMask: { value: 0 },
    uTf2NormalAlphaEnvMask: { value: 0 },
    uTf2PhongBoost: { value: 1 },
    uTf2PhongExponent: { value: 5 },
    uTf2PhongExponentFactor: { value: 0 },
    uTf2UseExponentMap: { value: 0 },
    uTf2ExponentMap: { value: null as THREE.Texture | null },
    uTf2UseLightwarp: { value: 0 },
    uTf2HalfLambert: { value: 0 },
    uTf2LightwarpMap: { value: null as THREE.Texture | null },
    uTf2AlbedoTint: { value: 0 },
    uTf2UsePhongTint: { value: 0 },
    uTf2PhongTint: { value: new THREE.Color(1, 1, 1) },
    uTf2Fresnel: { value: new THREE.Vector3(0, 0.5, 1) },
    uTf2RimLight: { value: 0 },
    uTf2RimExponent: { value: 4 },
    uTf2RimBoost: { value: 1 },
    uTf2RimMask: { value: 0 },
    uTf2SelfIllum: { value: 0 },
    uTf2UseSelfIllumMask: { value: 0 },
    uTf2SelfIllumMaskMap: { value: null as THREE.Texture | null },
    uTf2SelfIllumTint: { value: new THREE.Color(1, 1, 1) },
    uTf2SelfIllumFresnel: { value: 0 },
    uTf2SelfIllumFresnelParams: { value: new THREE.Vector4(1, 0, 1, 1) },
    uTf2EnvTint: { value: new THREE.Color(0, 0, 0) },
    uTf2AmbientCube: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0.4, 0.4, 0.4)) },
    uTf2AmbientBasis: { value: new THREE.Matrix3() },
  };
  private raf = 0;
  private lastTime = 0;
  private disposed = false;
  private canvas: HTMLCanvasElement;
  private activeUnusual: UnusualEffect | null = null;
  private unusualId = 'none';
  private unusualWeaponKey = '';
  // Set by frameCamera; reused by setFov to reframe without resetting pose.
  private framedDims: [number, number, number] | null = null;
  private framedRadius = 1;
  private perspectiveCenterNdc = new THREE.Vector2();
  // Model bounding-box center in GEOMETRY space (raw, uncentered), cached so
  // every rebuildUnusualEffect call (including setUnusual between model
  // loads) can pass a fallback control point without re-deriving it.
  private framedCenter = new THREE.Vector3();

  private resizeObserver: ResizeObserver | null = null;
  private resizeTimer = 0;

  // Killstreak sheen: a shared second-pass material over per-mesh clones of
  // the weapon geometry. Assets/material are created lazily on first enable
  // and kept for this Viewer's lifetime.
  private sheenId = 'none';
  private sheenTeam: 'red' | 'blu' = 'red';
  private sheenAssets: SheenAssets | null = null;
  private sheenAssetsPromise: Promise<SheenAssets> | null = null;
  private sheenMaterial: THREE.ShaderMaterial | null = null;
  private sheenMeshes: THREE.Mesh[] = [];
  private sheenElapsed = 0;
  private sheenFrameData: SheenFrameData = { scaleX: 1, offsetX: 0, scaleY: 1, offsetY: 0, sweepAxis: 0, sideAxis: 1 };
  private meshIsLens: boolean[] = [];

  // Orthographic projection: derived every frame from the perspective camera,
  // which InspectControls always drives.
  private orthoCamera: THREE.OrthographicCamera;
  private projectionMode: 'perspective' | 'orthographic' = 'perspective';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setClearAlpha(0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.LinearToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.01, 1000);
    this.camera.position.set(4, 2, 5);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, this.camera.near, this.camera.far);

    this.modelGroup.add(this.centerGroup);
    this.scene.add(this.lightGroup);
    this.scene.add(this.modelGroup);

    this.controls = new InspectControls(this.camera, this.modelGroup, canvas);

    this.envMap = makeEnvCube(0x9fb8d6, 0x40382c);
    this.material = new THREE.MeshPhongMaterial({
      color: 0xffffff,
      shininess: 30,
      specular: new THREE.Color(0x333333),
      envMap: this.envMap,
      combine: THREE.AddOperation,
      reflectivity: 1,
    });
    this.installTf2Shader();

    this.envReady = new Promise<void>((resolve) => {
      loadEditorEnvCube((texture) => {
        if (this.disposed) { texture.dispose(); resolve(); return; }
        this.envMap.dispose();
        this.envMap = texture;
        this.material.envMap = texture;
        this.material.needsUpdate = true;
        resolve();
      }, () => {
        console.warn('[warpaint-viewer] TF2 editor cubemap unavailable; using fallback');
        resolve();
      });
    });

    this.setLighting('inspect');

    this.onResize();
    window.addEventListener('resize', this.onResize);
    // The canvas also changes size when the app's layout reflows (inspector
    // sections collapsing, responsive breakpoint stacking) without a window
    // resize event; ResizeObserver catches that directly on the element.
    // Layout panels animate their width/height. Resizing the WebGL drawing
    // buffer on every animation frame causes visible clears and flicker, so
    // keep the existing frame CSS-scaled during the short transition and do
    // one real renderer resize after the layout has settled.
    this.resizeObserver = new ResizeObserver(() => {
      this.syncDisplayAspect();
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = window.setTimeout(this.onResize, 240);
    });
    this.resizeObserver.observe(canvas);
    this.lastTime = performance.now();
    this.loop();
  }

  private onResize = () => {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.syncDisplayAspect();
  };

  // Keep projection matched to the CSS box while a panel transition changes
  // its aspect ratio. The existing drawing buffer can then be CSS-scaled
  // briefly without making the weapon look squeezed or stretched.
  private syncDisplayAspect() {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    setParticlePointScale(h * this.renderer.getPixelRatio());
    this.syncOrthoCamera();
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.controls.update(dt);
    // Panning is a framing operation, not physical movement through the map.
    // Move the light rig with the model's translation, but not its rotation.
    this.lightGroup.position.copy(this.modelGroup.position);
    this.updateSheenAnimation(dt);
    if (this.activeUnusual) {
      // Particles simulate in world space; re-anchor the control points to
      // the weapon's current transform first so they follow the model the way
      // PATTACH_POINT_FOLLOW attachments do in game.
      this.centerGroup.updateWorldMatrix(true, false);
      this.activeUnusual.updateAnchor(this.centerGroup.matrixWorld);
      this.activeUnusual.update(dt);
    }
    if (this.projectionMode === 'orthographic') {
      this.syncOrthoCamera();
      this.renderer.render(this.scene, this.orthoCamera);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  };

  // Derives the ortho camera from the perspective camera every frame: same
  // position/orientation, with a frustum sized to match what the perspective
  // camera currently sees at its dolly distance (InspectControls always keeps
  // the camera on a ray through the origin, so position.length() is that
  // distance).
  private syncOrthoCamera() {
    this.orthoCamera.position.copy(this.camera.position);
    this.orthoCamera.quaternion.copy(this.camera.quaternion);
    const dist = this.camera.position.length();
    const halfH = dist * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const halfW = halfH * this.camera.aspect;
    this.orthoCamera.left = -halfW;
    this.orthoCamera.right = halfW;
    this.orthoCamera.top = halfH;
    this.orthoCamera.bottom = -halfH;
    this.orthoCamera.near = this.camera.near;
    this.orthoCamera.far = this.camera.far;
    this.orthoCamera.updateProjectionMatrix();
  }

  resetView() {
    this.activeUnusual?.notifyTeleport();
    this.controls.reset();
  }

  ready(): Promise<void> {
    return this.envReady;
  }

  setLighting(presetId: string) {
    const preset = getPreset(presetId);
    this.renderer.toneMappingExposure = preset.exposure ?? 1;
    this.lightGroup.clear();
    for (const l of preset.build(this.camera)) {
      this.lightGroup.add(l);
      if (l instanceof THREE.DirectionalLight || l instanceof THREE.SpotLight) this.lightGroup.add(l.target);
    }
    preset.ambientCube.forEach((color, i) => this.tf2Uniforms.uTf2AmbientCube.value[i].copy(color));
    this.tf2Uniforms.uTf2AmbientBasis.value.copy(preset.ambientBasis?.(this.camera) ?? new THREE.Matrix3());
    const host = this.canvas.parentElement;
    host?.classList.toggle('has-backplate', Boolean(preset.backplate));
    host?.style.setProperty('--backplate-image', preset.backplate ? `url("${preset.backplate}")` : 'none');
    this.scene.background = preset.backplate ? null : new THREE.Color(preset.background);
  }

  // The compositor result is stored as sRGB, matching Source's output target.
  setMap(texture: THREE.Texture | null) {
    this.material.map = texture;
    this.material.needsUpdate = true;
  }

  setSheen(sheenId: string, team: 'red' | 'blu') {
    const wasOff = this.sheenId === 'none';
    this.sheenId = sheenId;
    this.sheenTeam = team;
    if (sheenId === 'none') {
      this.teardownSheenMeshes();
      return;
    }
    if (wasOff) this.sheenElapsed = 0;
    void this.ensureSheenReady().then(() => {
      if (this.disposed || this.sheenId === 'none') return;
      this.rebuildSheenMeshes();
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
        if (this.disposed) return;
        this.sheenAssets = assets;
        this.sheenMaterial = createSheenMaterial(assets, this.material.side);
      })
      .catch(() => undefined);
  }

  private teardownSheenMeshes() {
    for (const mesh of this.sheenMeshes) this.centerGroup.remove(mesh);
    this.sheenMeshes = [];
  }

  private rebuildSheenMeshes() {
    this.teardownSheenMeshes();
    if (this.sheenId === 'none' || !this.sheenMaterial) return;
    for (let i = 0; i < this.meshes.length; i++) {
      if (this.meshIsLens[i]) continue;
      const mesh = new THREE.Mesh(this.meshes[i].geometry, this.sheenMaterial);
      mesh.renderOrder = 1;
      this.centerGroup.add(mesh);
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
  private updateSheenAnimation(dt: number) {
    if (this.sheenId === 'none' || !this.sheenMaterial || this.sheenMeshes.length === 0) return;
    this.sheenElapsed += dt;
    const cycle = SHEEN_SWEEP_SECONDS + SHEEN_PAUSE_SECONDS;
    const tInCycle = this.sheenElapsed % cycle;
    const sweeping = tInCycle < SHEEN_SWEEP_SECONDS;
    for (const mesh of this.sheenMeshes) mesh.visible = sweeping;
    if (sweeping) {
      this.sheenMaterial.uniforms.uFrame.value = Math.min(SHEEN_MASK_FRAMES - 1, Math.floor(SHEEN_FRAMERATE * tInCycle));
    }
  }

  setUnusual(effectId: string, weaponKey: string) {
    this.unusualId = effectId;
    this.unusualWeaponKey = weaponKey;
    this.rebuildUnusualEffect();
  }

  private rebuildUnusualEffect() {
    if (this.activeUnusual) {
      this.scene.remove(this.activeUnusual.object);
      this.activeUnusual.dispose();
      this.activeUnusual = null;
    }
    const effect = createUnusualEffect(this.unusualId, this.framedRadius, this.unusualWeaponKey, this.framedCenter);
    if (!effect) return;
    // Added at the scene root: particles simulate in WORLD space (like the
    // game, where control points follow the weapon but particles do not).
    // The render loop re-anchors the effect's control points from
    // centerGroup.matrixWorld every frame.
    this.scene.add(effect.object);
    this.activeUnusual = effect;
  }

  setViewAngle(preset: ViewAnglePreset) {
    this.activeUnusual?.notifyTeleport();
    this.controls.setViewDirection(preset.dir ? new THREE.Vector3(...preset.dir) : null);
  }

  setProjection(mode: 'perspective' | 'orthographic') {
    this.projectionMode = mode;
    this.controls.setDefaultPan(mode === 'perspective' ? this.computePerspectivePan() : new THREE.Vector2());
  }

  setFov(fov: number) {
    this.camera.fov = THREE.MathUtils.clamp(fov, 30, 110);
    this.camera.updateProjectionMatrix();
    if (!this.framedDims) return;
    const dist = this.computeFramingDistance(this.framedDims, this.framedRadius);
    this.controls.rescaleFraming(dist, this.projectionMode === 'perspective' ? this.computePerspectivePan(dist) : new THREE.Vector2());
  }

  // Renders at `scale`x resolution with no background so the PNG carries
  // alpha. The canvas drawing buffer isn't preserved, so pixels must be read
  // synchronously off the same render (no await in between).
  //
  // The buffer can't go through canvas.toBlob() directly: additive passes
  // (unusual particles, sheens) add color while leaving destination alpha
  // untouched, which reads correctly when the page composites the (nominally
  // premultiplied) canvas over the backplate but is invalid premultiplied
  // data on a transparent background. toBlob's unpremultiply divides those
  // bright low-alpha pixels into rainbow garbage. PNG's straight alpha
  // cannot represent additive light at all, so convert each pixel to the
  // closest "over" approximation: alpha = max(alpha, r, g, b) and color
  // rescaled to keep color * alpha unchanged. Over dark backgrounds this
  // reproduces the glow exactly; opaque weapon pixels pass through untouched.
  async captureScreenshot(scale = 2): Promise<Blob> {
    const prevPixelRatio = this.renderer.getPixelRatio();
    const prevSize = new THREE.Vector2();
    this.renderer.getSize(prevSize);
    const prevBackground = this.scene.background;
    const prevAspect = this.camera.aspect;
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    try {
      this.scene.background = null;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(w * scale, h * scale, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      if (this.projectionMode === 'orthographic') {
        this.syncOrthoCamera();
        this.renderer.render(this.scene, this.orthoCamera);
      } else {
        this.renderer.render(this.scene, this.camera);
      }

      const width = w * scale;
      const height = h * scale;
      const gl = this.renderer.getContext();
      const raw = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);

      // readPixels rows run bottom-up; ImageData expects top-down.
      const image = new ImageData(width, height);
      const out = image.data;
      for (let y = 0; y < height; y++) {
        const src = (height - 1 - y) * width * 4;
        const dst = y * width * 4;
        for (let x = 0; x < width * 4; x += 4) {
          const r = raw[src + x];
          const g = raw[src + x + 1];
          const b = raw[src + x + 2];
          const a = raw[src + x + 3];
          const cover = Math.max(a, r, g, b);
          if (cover === 0) continue; // fully empty, ImageData is zeroed
          out[dst + x] = Math.min(255, Math.round((r * 255) / cover));
          out[dst + x + 1] = Math.min(255, Math.round((g * 255) / cover));
          out[dst + x + 2] = Math.min(255, Math.round((b * 255) / cover));
          out[dst + x + 3] = cover;
        }
      }

      const scratch = document.createElement('canvas');
      scratch.width = width;
      scratch.height = height;
      const ctx = scratch.getContext('2d');
      if (!ctx) throw new Error('[warpaint-viewer] screenshot canvas 2d context unavailable');
      ctx.putImageData(image, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => {
        scratch.toBlob(resolve, 'image/png');
      });
      if (!blob) throw new Error('[warpaint-viewer] screenshot capture failed');
      return blob;
    } finally {
      this.renderer.setPixelRatio(prevPixelRatio);
      this.renderer.setSize(prevSize.x, prevSize.y, false);
      this.scene.background = prevBackground;
      this.camera.aspect = prevAspect;
      this.camera.updateProjectionMatrix();
    }
  }

  private installTf2Shader() {
    this.material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.tf2Uniforms);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <common>',
        `#include <common>
uniform float uTf2PhongEnabled, uTf2BaseAlphaPhongMask, uTf2NormalAlphaEnvMask;
uniform float uTf2PhongBoost, uTf2PhongExponent, uTf2PhongExponentFactor;
uniform float uTf2UseExponentMap, uTf2UseLightwarp, uTf2HalfLambert, uTf2AlbedoTint, uTf2UsePhongTint;
uniform float uTf2RimLight, uTf2RimExponent, uTf2RimBoost, uTf2RimMask;
uniform float uTf2SelfIllum, uTf2SelfIllumFresnel, uTf2UseSelfIllumMask;
uniform sampler2D uTf2ExponentMap, uTf2LightwarpMap, uTf2SelfIllumMaskMap;
uniform vec3 uTf2PhongTint, uTf2Fresnel, uTf2SelfIllumTint, uTf2EnvTint;
uniform vec4 uTf2SelfIllumFresnelParams;
uniform vec3 uTf2AmbientCube[6];
uniform mat3 uTf2AmbientBasis;
vec3 tf2AmbientLight( vec3 worldNormal ) {
  vec3 sourceNormal = normalize( uTf2AmbientBasis * worldNormal );
  vec3 n2 = sourceNormal * sourceNormal;
  return n2.x * uTf2AmbientCube[sourceNormal.x < 0.0 ? 1 : 0]
       + n2.y * uTf2AmbientCube[sourceNormal.y < 0.0 ? 3 : 2]
       + n2.z * uTf2AmbientCube[sourceNormal.z < 0.0 ? 5 : 4];
}`,
      );

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <specularmap_fragment>',
        `float tf2NormalAlpha = 1.0;
#ifdef USE_NORMALMAP
  tf2NormalAlpha = texture2D( normalMap, vNormalMapUv ).a;
#endif
float tf2SpecMask = mix( tf2NormalAlpha, diffuseColor.a, uTf2BaseAlphaPhongMask );
// skin_ps20b.fxc: fEnvMapMask = lerp( baseColor.a, fSpecMask, $normalmapalphaenvmapmask ).
// The skin (phong) path always masks the cubemap by base alpha, which for
// warpaints is the composited metal mask; $basealphaenvmapmask is never read.
float tf2EnvMask = mix( diffuseColor.a, tf2SpecMask, uTf2NormalAlphaEnvMask );
float specularStrength = uTf2PhongEnabled * uTf2PhongBoost * tf2SpecMask;`,
      );

      // Compositor targets stay raw RGBA8 so pooled targets never change GPU
      // formats. Their RGB bytes are sRGB-encoded; decode only the base color
      // here while preserving alpha as the Source phong/environment mask.
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  vec4 sampledDiffuseColor = sRGBTransferEOTF( texture2D( map, vMapUv ) );
  diffuseColor *= sampledDiffuseColor;
#endif`,
      );

      const normalChunk = THREE.ShaderChunk.normal_fragment_maps
        .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale;\n\tmapN = mix( mapN, vec3( 0.0, 0.0, 1.0 ), uTf2BaseAlphaPhongMask );')
        .replace('normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'normal = mix( texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0, vec3( 0.0, 0.0, 1.0 ), uTf2BaseAlphaPhongMask );');
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', normalChunk);

      const phongPars = THREE.ShaderChunk.lights_phong_pars_fragment
        .replace('float specularStrength;\n', 'float specularStrength;\n\tfloat tf2RimMask;\n')
        .replace(
          'vec3 irradiance = dotNL * directLight.color;',
          `float tf2Half = saturate( dot( geometryNormal, directLight.direction ) * 0.5 + 0.5 );
\tfloat tf2DiffuseScalar = mix( dotNL, tf2Half * tf2Half, uTf2HalfLambert );
\tvec3 tf2Warp = 2.0 * texture2D( uTf2LightwarpMap, vec2( mix( dotNL, tf2Half, uTf2HalfLambert ), 0.5 ) ).rgb;
\tvec3 irradiance = directLight.color * mix( vec3( tf2DiffuseScalar ), tf2Warp, uTf2UseLightwarp );`,
        )
        .replace(
          'reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
          'reflectedLight.directDiffuse += irradiance * material.diffuseColor;',
        )
        .replace(
          'reflectedLight.directSpecular += irradiance * BRDF_BlinnPhong( directLight.direction, geometryViewDir, geometryNormal, material.specularColor, material.specularShininess ) * material.specularStrength;',
          `float tf2NdotV = saturate( dot( geometryNormal, geometryViewDir ) );
\tfloat tf2Facing = 1.0 - tf2NdotV; tf2Facing *= tf2Facing;
\tfloat tf2Fresnel = tf2Facing > 0.5
\t\t? mix( uTf2Fresnel.y, uTf2Fresnel.z, 2.0 * tf2Facing - 1.0 )
\t\t: mix( uTf2Fresnel.x, uTf2Fresnel.y, 2.0 * tf2Facing );
\tvec3 tf2Reflect = reflect( -geometryViewDir, geometryNormal );
\tfloat tf2LdotR = saturate( dot( tf2Reflect, directLight.direction ) );
\tvec3 tf2Specular = directLight.color * dotNL * pow( tf2LdotR, material.specularShininess )
\t\t* material.specularColor * material.specularStrength * tf2Fresnel;
\tfloat tf2RimFacing = tf2Facing * tf2Facing;
\tvec3 tf2Rim = directLight.color * dotNL * pow( tf2LdotR, max( uTf2RimExponent, 0.001 ) )
\t\t* material.specularColor * tf2RimFacing * material.tf2RimMask * uTf2RimLight;
\treflectedLight.directSpecular += max( tf2Specular, tf2Rim );`,
        )
        .replace(
          'reflectedLight.indirectDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );',
          'reflectedLight.indirectDiffuse += irradiance * material.diffuseColor;',
        );
      shader.fragmentShader = shader.fragmentShader.replace('#include <lights_phong_pars_fragment>', phongPars);
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <lights_phong_fragment>',
        `BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
vec4 tf2Exp = vec4( 1.0 );
#ifdef USE_MAP
  tf2Exp = texture2D( uTf2ExponentMap, vMapUv );
#endif
vec3 tf2MappedTint = mix( vec3( 1.0 ), diffuseColor.rgb, tf2Exp.g * uTf2AlbedoTint );
material.specularColor = mix( tf2MappedTint, uTf2PhongTint, uTf2UsePhongTint );
material.specularShininess = max( 1.0, mix( uTf2PhongExponent, 1.0 + uTf2PhongExponentFactor * tf2Exp.r, uTf2UseExponentMap ) );
material.specularStrength = specularStrength;
material.tf2RimMask = mix( 1.0, tf2Exp.a, uTf2RimMask );`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;',
        `vec3 tf2AmbientWorldNormal = normalize( transformNormalByInverseViewMatrix( normal, viewMatrix ) );
vec3 tf2AmbientDiffuse = diffuseColor.rgb * tf2AmbientLight( tf2AmbientWorldNormal );
vec3 tf2WorldEyeDir = normalize( transformNormalByInverseViewMatrix( geometryViewDir, viewMatrix ) );
float tf2AmbientFacing = 1.0 - saturate( dot( tf2AmbientWorldNormal, tf2WorldEyeDir ) );
float tf2AmbientRimFresnel = tf2AmbientFacing * tf2AmbientFacing;
tf2AmbientRimFresnel *= tf2AmbientRimFresnel;
float tf2AmbientRimMask = material.tf2RimMask * tf2AmbientRimFresnel * uTf2RimLight;
vec3 tf2AmbientRim = tf2AmbientLight( tf2WorldEyeDir ) * uTf2RimBoost
  * saturate( tf2AmbientRimMask * tf2AmbientWorldNormal.y ) * material.specularColor;
// skin_ps20b.fxc blends lit diffuse toward an albedo-colored self-illumination
// target using base alpha and a view-facing Fresnel mask. Macaw override
// materials (Blackout, Steel Brushed, etc.) use this as their characteristic
// colored metal sheen; it is separate from the glossy phong highlight.
float tf2SelfIllumFacing = saturate( dot( geometryNormal, geometryViewDir ) );
float tf2SelfIllumFresnelMask = saturate(
  pow( tf2SelfIllumFacing, uTf2SelfIllumFresnelParams.z ) * uTf2SelfIllumFresnelParams.x
  + uTf2SelfIllumFresnelParams.y
);
tf2SelfIllumFresnelMask = mix( 1.0, tf2SelfIllumFresnelMask, uTf2SelfIllumFresnel );
// vMapUv only exists when the material has a map; before the first composite
// lands the shader compiles without one, so guard the separate-mask sample.
#ifdef USE_MAP
float tf2SeparateSelfIllumMask = texture2D( uTf2SelfIllumMaskMap, vMapUv ).r;
#else
float tf2SeparateSelfIllumMask = 0.0;
#endif
float tf2BaseSelfIllumMask = mix( diffuseColor.a, tf2SeparateSelfIllumMask, uTf2UseSelfIllumMask );
float tf2SelfIllumMask = uTf2SelfIllum * tf2BaseSelfIllumMask * tf2SelfIllumFresnelMask;
float tf2SelfIllumBrightness = mix( 1.0, uTf2SelfIllumFresnelParams.w, uTf2SelfIllumFresnel );
vec3 tf2LitDiffuse = reflectedLight.directDiffuse + tf2AmbientDiffuse;
tf2LitDiffuse = mix(
  tf2LitDiffuse,
  diffuseColor.rgb * uTf2SelfIllumTint * tf2SelfIllumBrightness,
  tf2SelfIllumMask
);
vec3 outgoingLight = tf2LitDiffuse + reflectedLight.directSpecular
  + reflectedLight.indirectSpecular + tf2AmbientRim + totalEmissiveRadiance;`,
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <envmap_fragment>',
        `#ifdef USE_ENVMAP
  #ifdef ENV_WORLDPOS
    vec3 tf2CameraToFrag = isOrthographic
      ? normalize( vec3( -viewMatrix[0][2], -viewMatrix[1][2], -viewMatrix[2][2] ) )
      : normalize( vWorldPosition - cameraPosition );
    vec3 tf2WorldNormal = transformNormalByInverseViewMatrix( normal, viewMatrix );
    vec3 tf2ReflectVec = reflect( tf2CameraToFrag, tf2WorldNormal );
  #else
    vec3 tf2ReflectVec = vReflect;
  #endif
  vec3 tf2Env = textureCube( envMap, envMapRotation * tf2ReflectVec ).rgb;
  outgoingLight += tf2Env * uTf2EnvTint * tf2EnvMask;
#endif`,
      );
    };
    this.material.customProgramCacheKey = () => 'tf2-vertexlit-v6-selfillum';
  }

  async applyMaterialParams(mat: WeaponMaterial, resolveTexture: (ref: string) => string = (ref) => ref): Promise<void> {
    const u = this.tf2Uniforms;
    u.uTf2PhongEnabled.value = mat.phong ? 1 : 0;
    u.uTf2BaseAlphaPhongMask.value = mat.baseMapAlphaPhongMask ? 1 : 0;
    u.uTf2NormalAlphaEnvMask.value = mat.normalMapAlphaEnvmapMask ? 1 : 0;
    u.uTf2PhongBoost.value = mat.phongBoost ?? 1;
    u.uTf2PhongExponent.value = mat.phongExponent ?? 5;
    u.uTf2PhongExponentFactor.value = mat.phongExponentFactor ?? 0;
    u.uTf2AlbedoTint.value = mat.phongAlbedoTint ? 1 : 0;
    u.uTf2UsePhongTint.value = mat.phongTint ? 1 : 0;
    if (mat.phongTint) u.uTf2PhongTint.value.setRGB(...mat.phongTint);
    u.uTf2Fresnel.value.fromArray(mat.phongFresnelRanges ?? [0, 0.5, 1]);
    u.uTf2RimLight.value = mat.rimLight ? 1 : 0;
    u.uTf2RimExponent.value = mat.rimLightExponent ?? 4;
    u.uTf2RimBoost.value = mat.rimLightBoost ?? 1;
    u.uTf2RimMask.value = mat.rimMask ? 1 : 0;
    u.uTf2SelfIllum.value = mat.selfIllum ? 1 : 0;
    u.uTf2SelfIllumFresnel.value = mat.selfIllumFresnel ? 1 : 0;
    // ModelGlowColor resolves to white outside crit/glow states in TF2's
    // inspection view, replacing the static warm fallback in these VMTs.
    const selfIllumTint = mat.modelGlowColor ? [1, 1, 1] : (mat.selfIllumTint ?? [1, 1, 1]);
    u.uTf2SelfIllumTint.value.setRGB(selfIllumTint[0], selfIllumTint[1], selfIllumTint[2]);
    const [selfIllumMin, selfIllumMax, selfIllumExp] = mat.selfIllumFresnelMinMaxExp ?? [0, 1, 1];
    const selfIllumBias = Math.abs(selfIllumMax) > 1e-6 ? selfIllumMin / selfIllumMax : 0;
    u.uTf2SelfIllumFresnelParams.value.set(
      1 - selfIllumBias,
      selfIllumBias,
      Math.max(selfIllumExp, 0.001),
      selfIllumMax,
    );
    u.uTf2HalfLambert.value = mat.halfLambert ? 1 : 0;
    u.uTf2EnvTint.value.setRGB(...mat.envmapTint);
    this.material.specular.setRGB(1, 1, 1);
    this.material.shininess = THREE.MathUtils.clamp(mat.phongExponent ?? 5, 1, 300);
    this.material.reflectivity = 1;
    this.material.needsUpdate = true;

    const token = ++this.materialLoadToken;
    this.normalTexture?.dispose();
    this.exponentTexture?.dispose();
    this.lightwarpTexture?.dispose();
    this.selfIllumTexture?.dispose();
    this.normalTexture = this.exponentTexture = this.lightwarpTexture = this.selfIllumTexture = null;
    this.material.normalMap = null;
    u.uTf2ExponentMap.value = null;
    u.uTf2LightwarpMap.value = null;
    u.uTf2UseExponentMap.value = 0;
    u.uTf2UseLightwarp.value = 0;
    u.uTf2UseSelfIllumMask.value = 0;
    u.uTf2SelfIllumMaskMap.value = null;

    const loads: Promise<void>[] = [];
    if (mat.normalMap) loads.push(this.texLoader.loadAsync(resolveTexture(mat.normalMap)).then((t) => {
      if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
      t.colorSpace = THREE.NoColorSpace;
      t.flipY = false; // glTF UV convention, same as the composited map
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      // Source normal maps use the DirectX (green-down) convention.
      this.material.normalScale.set(1, -1);
      this.normalTexture = t;
      this.material.normalMap = t;
      this.material.needsUpdate = true;
      this.renderer.initTexture(t);
    }).catch(() => undefined));
    if (mat.phongExponentTexture) {
      loads.push(this.texLoader.loadAsync(resolveTexture(mat.phongExponentTexture)).then((t) => {
        if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        this.exponentTexture = t; u.uTf2ExponentMap.value = t; u.uTf2UseExponentMap.value = 1;
        this.renderer.initTexture(t);
      }).catch(() => undefined));
    }
    if (mat.lightwarpTexture) {
      loads.push(this.texLoader.loadAsync(resolveTexture(mat.lightwarpTexture)).then((t) => {
        if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
        // skin_dx9_helper.cpp does not enable sRGB reads for the diffuse-warp
        // sampler. Source therefore uses the stored ramp values directly.
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        this.lightwarpTexture = t; u.uTf2LightwarpMap.value = t; u.uTf2UseLightwarp.value = 1;
        this.renderer.initTexture(t);
      }).catch(() => undefined));
    }
    if (mat.selfIllumMask) {
      loads.push(this.texLoader.loadAsync(resolveTexture(mat.selfIllumMask)).then((t) => {
        if (token !== this.materialLoadToken || this.disposed) { t.dispose(); return; }
        t.colorSpace = THREE.NoColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        this.selfIllumTexture = t; u.uTf2SelfIllumMaskMap.value = t; u.uTf2UseSelfIllumMask.value = 1;
        this.renderer.initTexture(t);
      }).catch(() => undefined));
    }
    this.material.needsUpdate = true;
    await Promise.all(loads);
  }

  // Geometry cache: switching weapons back and forth never refetches a GLB.
  private geoCache = new Map<string, Promise<Array<{ geometry: THREE.BufferGeometry; materialName: string }>>>();
  private currentGeoCached = false;
  private loadToken = 0;

  private setMeshGeometries(parts: Array<{ geometry: THREE.BufferGeometry; materialName: string }>, fromCache: boolean) {
    this.teardownSheenMeshes();
    for (const mesh of this.meshes) {
      this.centerGroup.remove(mesh);
      // Cached geometries are shared and disposed with the cache, not per swap.
      if (!this.currentGeoCached) mesh.geometry.dispose();
    }
    this.currentGeoCached = fromCache;
    this.meshIsLens = parts.map(({ materialName }) => /(?:^|_)lens(?:$|_)/i.test(materialName));
    this.meshes = parts.map(({ geometry }, i) => new THREE.Mesh(geometry, this.meshIsLens[i] ? this.lensMaterial : this.material));
    this.centerGroup.add(...this.meshes);
    this.frameCamera(parts.map((part) => part.geometry));
    if (this.sheenId !== 'none' && this.sheenMaterial) this.rebuildSheenMeshes();
  }

  private clearModel() {
    this.teardownSheenMeshes();
    for (const mesh of this.meshes) {
      this.centerGroup.remove(mesh);
      if (!this.currentGeoCached) mesh.geometry.dispose();
    }
    this.meshes = [];
    this.meshIsLens = [];
    this.currentGeoCached = false;
  }

  // Load a weapon GLB. Concurrent calls resolve in call order via a token so a
  // stale load never wins; missing models leave the stage empty.
  async loadModel(url: string | null): Promise<void> {
    const token = ++this.loadToken;
    if (!url) {
      this.clearModel();
      return;
    }
    let promise = this.geoCache.get(url);
    if (!promise) {
      promise = this.gltfLoader.loadAsync(url).then((gltf) => {
        const geometries: Array<{ geometry: THREE.BufferGeometry; materialName: string }> = [];
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            const mesh = o as THREE.Mesh;
            const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
            geometries.push({ geometry: mesh.geometry as THREE.BufferGeometry, materialName: material?.name ?? '' });
          }
        });
        if (!geometries.length) throw new Error('no mesh in GLB');
        return geometries;
      });
      this.geoCache.set(url, promise);
    }
    try {
      const geometries = await promise;
      if (token !== this.loadToken || this.disposed) return;
      this.setMeshGeometries(geometries, true);
    } catch (err) {
      this.geoCache.delete(url); // allow retry later
      if (token !== this.loadToken || this.disposed) return;
      console.warn('[warpaint-viewer] model load failed:', err);
      this.clearModel();
      throw err;
    }
  }

  private frameCamera(geometries: THREE.BufferGeometry[]) {
    const box = new THREE.Box3();
    for (const geo of geometries) {
      geo.computeBoundingBox();
      if (geo.boundingBox) box.union(geo.boundingBox);
    }
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    // The inspect pose keeps a weapon's longest axis mostly horizontal, so fit
    // that axis against the horizontal fov and the next-largest against the
    // vertical one. Fitting everything against the vertical fov (the old
    // sphere fit) framed long weapons far too small on wide canvases.
    const dims = [size.x, size.y, size.z].sort((a, b) => b - a) as [number, number, number];
    this.framedDims = dims;
    this.framedRadius = radius;
    this.framedCenter.copy(center);
    const dist = this.computeFramingDistance(dims, radius);

    // Sheen mask placement (CProxyAnimatedWeaponSheen::InitParams) uses the
    // model's raw, uncentered local-space bounding box.
    this.sheenFrameData = computeSheenFrameData(box.min, box.max);
    this.updateSheenFrameUniforms();

    // Center the mesh at the origin; the controls own modelGroup's transform.
    this.centerGroup.position.set(-center.x, -center.y, -center.z);
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.setFraming(dist, radius);

    // A centered 3D bounding box can still look off-center after perspective
    // projection (especially long, deep weapons such as the rocket launcher).
    // Measure the actual projected vertices and make that visual center the
    // controls' reset position.
    const projectedMin = new THREE.Vector2(Infinity, Infinity);
    const projectedMax = new THREE.Vector2(-Infinity, -Infinity);
    const point = new THREE.Vector3();
    for (const geometry of geometries) {
      const positions = geometry.getAttribute('position');
      if (!positions) continue;
      for (let i = 0; i < positions.count; i++) {
        point.fromBufferAttribute(positions, i).sub(center).project(this.camera);
        projectedMin.x = Math.min(projectedMin.x, point.x);
        projectedMin.y = Math.min(projectedMin.y, point.y);
        projectedMax.x = Math.max(projectedMax.x, point.x);
        projectedMax.y = Math.max(projectedMax.y, point.y);
      }
    }
    if (Number.isFinite(projectedMin.x)) {
      this.perspectiveCenterNdc.copy(projectedMin.add(projectedMax).multiplyScalar(0.5));
      const defaultPan = this.projectionMode === 'perspective' ? this.computePerspectivePan(dist) : new THREE.Vector2();
      this.controls.setFraming(dist, radius, defaultPan);
    }
    this.rebuildUnusualEffect();
  }

  private computePerspectivePan(distance = this.camera.position.length()): THREE.Vector2 {
    const vHalf = (this.camera.fov * Math.PI) / 360;
    return new THREE.Vector2(
      -this.perspectiveCenterNdc.x * distance * Math.tan(vHalf) * this.camera.aspect,
      -this.perspectiveCenterNdc.y * distance * Math.tan(vHalf),
    );
  }

  private computeFramingDistance(dims: [number, number, number], radius: number): number {
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * Math.max(1, this.camera.aspect));
    const margin = 1.35; // headroom for the angled default view direction
    return Math.max(
      (dims[0] * 0.5 * margin) / Math.tan(hHalf),
      (dims[1] * 0.5 * margin) / Math.tan(vHalf),
      radius * 1.6, // keep the camera outside the model with room to orbit
    );
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.parentElement?.classList.remove('has-backplate');
    this.canvas.parentElement?.style.removeProperty('--backplate-image');
    this.controls.dispose();
    if (this.activeUnusual) {
      this.scene.remove(this.activeUnusual.object);
      this.activeUnusual.dispose();
      this.activeUnusual = null;
    }
    this.teardownSheenMeshes();
    this.sheenMaterial?.dispose();
    this.sheenMaterial = null;
    this.sheenAssets?.maskTexture.dispose();
    this.sheenAssets?.cubeTexture.dispose();
    this.sheenAssets = null;
    this.material.dispose();
    this.lensMaterial.dispose();
    this.materialLoadToken++;
    this.normalTexture?.dispose();
    this.exponentTexture?.dispose();
    this.lightwarpTexture?.dispose();
    this.selfIllumTexture?.dispose();
    this.envMap.dispose();
    if (!this.currentGeoCached) for (const mesh of this.meshes) mesh.geometry.dispose();
    for (const p of this.geoCache.values()) p.then((parts) => parts.forEach((part) => part.geometry.dispose())).catch(() => undefined);
    this.geoCache.clear();
    this.renderer.dispose();
  }
}
