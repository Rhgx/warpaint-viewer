import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createPlaceholderWeaponGeometry } from './placeholderMesh';
import { getPreset } from './lighting';
import { makeEnvCube } from './env';
import { InspectControls } from './inspectControls';
import type { WeaponMaterial } from '../data/types';

// three.js viewer: a weapon mesh with a MeshPhongMaterial (approximating TF2's
// VertexLitGeneric phong + envmap) whose map is the composited paint texture.
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
  private mesh: THREE.Mesh | null = null;
  private envMap: THREE.CubeTexture;
  private gltfLoader = new GLTFLoader();
  private texLoader = new THREE.TextureLoader();
  private raf = 0;
  private lastTime = 0;
  private disposed = false;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    this.camera.position.set(4, 2, 5);

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
      reflectivity: 0.35,
    });

    this.setLighting('inspect');
    this.setModelToPlaceholder();

    this.onResize();
    window.addEventListener('resize', this.onResize);
    this.lastTime = performance.now();
    this.loop();
  }

  private onResize = () => {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.controls.update(dt);
    this.renderer.render(this.scene, this.camera);
  };

  resetView() {
    this.controls.reset();
  }

  setLighting(presetId: string) {
    const preset = getPreset(presetId);
    this.lightGroup.clear();
    for (const l of preset.build()) this.lightGroup.add(l);
    this.scene.background = new THREE.Color(preset.background);
    // Refresh the env cube to roughly match the environment.
    const sky = new THREE.Color(preset.background).lerp(new THREE.Color(0xffffff), 0.3);
    const ground = new THREE.Color(preset.background).lerp(new THREE.Color(0x000000), 0.4);
    this.envMap.dispose();
    this.envMap = makeEnvCube(sky, ground);
    this.material.envMap = this.envMap;
    this.material.needsUpdate = true;
  }

  setExposure(v: number) {
    this.renderer.toneMappingExposure = v;
  }

  // The composited paint texture (already linear albedo).
  setMap(texture: THREE.Texture | null) {
    this.material.map = texture;
    this.material.needsUpdate = true;
  }

  applyMaterialParams(mat: WeaponMaterial) {
    // VertexLitGeneric phong exponent -> Phong shininess (rough mapping).
    // When the VMT uses an exponent texture, phongExponent is null and
    // phongExponentFactor approximates the exponent scale.
    const exponent = mat.phongExponent ?? mat.phongExponentFactor ?? 10;
    this.material.shininess = THREE.MathUtils.clamp(exponent * 4, 2, 300);
    const boost = mat.phong === false ? 0 : mat.phongBoost;
    const s = THREE.MathUtils.clamp(boost * 0.25, 0, 1);
    this.material.specular.setRGB(s, s, s);
    const tint = mat.envmapTint;
    this.material.reflectivity = THREE.MathUtils.clamp((tint[0] + tint[1] + tint[2]) / 3, 0, 1);
    this.material.needsUpdate = true;

    if (mat.normalMap) {
      this.texLoader.load(
        mat.normalMap,
        (t) => {
          t.colorSpace = THREE.NoColorSpace;
          t.flipY = false; // glTF UV convention, same as the composited map
          this.material.normalMap = t;
          this.material.needsUpdate = true;
        },
        undefined,
        () => undefined,
      );
    } else {
      this.material.normalMap = null;
      this.material.needsUpdate = true;
    }
  }

  // Geometry cache: switching weapons back and forth never refetches a GLB.
  private geoCache = new Map<string, Promise<THREE.BufferGeometry>>();
  private currentGeoCached = false;
  private loadToken = 0;

  private setMeshGeometry(geo: THREE.BufferGeometry, fromCache: boolean) {
    if (this.mesh) {
      this.centerGroup.remove(this.mesh);
      // Cached geometries are shared and disposed with the cache, not per swap.
      if (!this.currentGeoCached) (this.mesh.geometry as THREE.BufferGeometry).dispose();
    }
    this.currentGeoCached = fromCache;
    this.mesh = new THREE.Mesh(geo, this.material);
    this.centerGroup.add(this.mesh);
    this.frameCamera(geo);
  }

  setModelToPlaceholder() {
    this.setMeshGeometry(createPlaceholderWeaponGeometry(), false);
  }

  // Load a weapon GLB; falls back to the placeholder on any failure. Concurrent
  // calls resolve in call order via a token so a stale load never wins.
  async loadModel(url: string | null): Promise<void> {
    const token = ++this.loadToken;
    if (!url) {
      this.setModelToPlaceholder();
      return;
    }
    let promise = this.geoCache.get(url);
    if (!promise) {
      promise = this.gltfLoader.loadAsync(url).then((gltf) => {
        let geo: THREE.BufferGeometry | null = null;
        gltf.scene.traverse((o) => {
          if (!geo && (o as THREE.Mesh).isMesh) {
            geo = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
          }
        });
        if (!geo) throw new Error('no mesh in GLB');
        return geo;
      });
      this.geoCache.set(url, promise);
    }
    try {
      const geo = await promise;
      if (token !== this.loadToken || this.disposed) return;
      this.setMeshGeometry(geo, true);
    } catch (err) {
      this.geoCache.delete(url); // allow retry later
      if (token !== this.loadToken || this.disposed) return;
      console.warn('[warpaint-viewer] model load failed, using placeholder:', err);
      this.setModelToPlaceholder();
    }
  }

  private frameCamera(geo: THREE.BufferGeometry) {
    geo.computeBoundingBox();
    const box = geo.boundingBox!;
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const radius = Math.max(size.x, size.y, size.z) * 0.5;
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (radius / Math.sin(fov / 2)) * 1.5;

    // Center the mesh at the origin; the controls own modelGroup's transform.
    this.centerGroup.position.set(-center.x, -center.y, -center.z);
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.setFraming(dist, radius);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();
    this.material.dispose();
    this.envMap.dispose();
    if (this.mesh && !this.currentGeoCached) (this.mesh.geometry as THREE.BufferGeometry).dispose();
    for (const p of this.geoCache.values()) p.then((g) => g.dispose()).catch(() => undefined);
    this.geoCache.clear();
    this.renderer.dispose();
  }
}
