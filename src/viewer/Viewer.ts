import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getPreset } from './lighting';
import { loadEditorEnvCube, makeEnvCube } from './env';
import { InspectControls } from './inspectControls';
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
  private meshes: THREE.Mesh[] = [];
  private envMap: THREE.CubeTexture;
  private envReady: Promise<void>;
  private gltfLoader = new GLTFLoader();
  private texLoader = new THREE.TextureLoader();
  private normalTexture: THREE.Texture | null = null;
  private exponentTexture: THREE.Texture | null = null;
  private lightwarpTexture: THREE.Texture | null = null;
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
    uTf2EnvTint: { value: new THREE.Color(0, 0, 0) },
    uTf2AmbientCube: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0.4, 0.4, 0.4)) },
  };
  private raf = 0;
  private lastTime = 0;
  private disposed = false;
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.LinearToneMapping;
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

  ready(): Promise<void> {
    return this.envReady;
  }

  setLighting(presetId: string) {
    const preset = getPreset(presetId);
    this.lightGroup.clear();
    for (const l of preset.build()) {
      this.lightGroup.add(l);
      if (l instanceof THREE.DirectionalLight || l instanceof THREE.SpotLight) this.lightGroup.add(l.target);
    }
    preset.ambientCube.forEach((color, i) => this.tf2Uniforms.uTf2AmbientCube.value[i].copy(color));
    this.scene.background = new THREE.Color(preset.background);
  }

  // The compositor result is stored as sRGB, matching Source's output target.
  setMap(texture: THREE.Texture | null) {
    this.material.map = texture;
    this.material.needsUpdate = true;
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
uniform sampler2D uTf2ExponentMap, uTf2LightwarpMap;
uniform vec3 uTf2PhongTint, uTf2Fresnel, uTf2EnvTint;
uniform vec3 uTf2AmbientCube[6];
vec3 tf2AmbientLight( vec3 worldNormal ) {
  vec3 n2 = worldNormal * worldNormal;
  return n2.x * uTf2AmbientCube[worldNormal.x < 0.0 ? 1 : 0]
       + n2.y * uTf2AmbientCube[worldNormal.y < 0.0 ? 3 : 2]
       + n2.z * uTf2AmbientCube[worldNormal.z < 0.0 ? 5 : 4];
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
\t\t* tf2RimFacing * material.tf2RimMask * uTf2RimLight;
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
vec3 outgoingLight = reflectedLight.directDiffuse + tf2AmbientDiffuse + reflectedLight.directSpecular
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
    this.material.customProgramCacheKey = () => 'tf2-vertexlit-v5-source-panel';
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
    this.normalTexture = this.exponentTexture = this.lightwarpTexture = null;
    this.material.normalMap = null;
    u.uTf2ExponentMap.value = null;
    u.uTf2LightwarpMap.value = null;
    u.uTf2UseExponentMap.value = 0;
    u.uTf2UseLightwarp.value = 0;

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
        t.colorSpace = THREE.SRGBColorSpace; t.flipY = false;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        this.lightwarpTexture = t; u.uTf2LightwarpMap.value = t; u.uTf2UseLightwarp.value = 1;
        this.renderer.initTexture(t);
      }).catch(() => undefined));
    }
    this.material.needsUpdate = true;
    await Promise.all(loads);
  }

  // Geometry cache: switching weapons back and forth never refetches a GLB.
  private geoCache = new Map<string, Promise<THREE.BufferGeometry[]>>();
  private currentGeoCached = false;
  private loadToken = 0;

  private setMeshGeometries(geometries: THREE.BufferGeometry[], fromCache: boolean) {
    for (const mesh of this.meshes) {
      this.centerGroup.remove(mesh);
      // Cached geometries are shared and disposed with the cache, not per swap.
      if (!this.currentGeoCached) mesh.geometry.dispose();
    }
    this.currentGeoCached = fromCache;
    this.meshes = geometries.map((geo) => new THREE.Mesh(geo, this.material));
    this.centerGroup.add(...this.meshes);
    this.frameCamera(geometries);
  }

  private clearModel() {
    for (const mesh of this.meshes) {
      this.centerGroup.remove(mesh);
      if (!this.currentGeoCached) mesh.geometry.dispose();
    }
    this.meshes = [];
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
        const geometries: THREE.BufferGeometry[] = [];
        gltf.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            geometries.push((o as THREE.Mesh).geometry as THREE.BufferGeometry);
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
    const dims = [size.x, size.y, size.z].sort((a, b) => b - a);
    const vHalf = (this.camera.fov * Math.PI) / 360;
    const hHalf = Math.atan(Math.tan(vHalf) * Math.max(1, this.camera.aspect));
    const margin = 1.35; // headroom for the angled default view direction
    const dist = Math.max(
      (dims[0] * 0.5 * margin) / Math.tan(hHalf),
      (dims[1] * 0.5 * margin) / Math.tan(vHalf),
      radius * 1.6, // keep the camera outside the model with room to orbit
    );

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
    this.materialLoadToken++;
    this.normalTexture?.dispose();
    this.exponentTexture?.dispose();
    this.lightwarpTexture?.dispose();
    this.envMap.dispose();
    if (!this.currentGeoCached) for (const mesh of this.meshes) mesh.geometry.dispose();
    for (const p of this.geoCache.values()) p.then((geos) => geos.forEach((g) => g.dispose())).catch(() => undefined);
    this.geoCache.clear();
    this.renderer.dispose();
  }
}
