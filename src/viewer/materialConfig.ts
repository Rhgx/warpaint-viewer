import * as THREE from 'three';
import type { WeaponMaterial } from '../data/types';

export function createTf2Uniforms() {
  return {
    uTf2PhongEnabled: { value: 0 }, uTf2BaseAlphaPhongMask: { value: 0 },
    uTf2NormalAlphaEnvMask: { value: 0 }, uTf2PhongBoost: { value: 1 },
    uTf2PhongExponent: { value: 5 }, uTf2PhongExponentFactor: { value: 0 },
    uTf2UseExponentMap: { value: 0 }, uTf2ExponentMap: { value: null as THREE.Texture | null },
    uTf2UseLightwarp: { value: 0 }, uTf2HalfLambert: { value: 0 },
    uTf2LightwarpMap: { value: null as THREE.Texture | null }, uTf2AlbedoTint: { value: 0 },
    uTf2UsePhongTint: { value: 0 }, uTf2PhongTint: { value: new THREE.Color(1, 1, 1) },
    uTf2Fresnel: { value: new THREE.Vector3(0, .5, 1) }, uTf2RimLight: { value: 0 },
    uTf2RimExponent: { value: 4 }, uTf2RimBoost: { value: 1 }, uTf2RimMask: { value: 0 },
    uTf2SelfIllum: { value: 0 }, uTf2UseSelfIllumMask: { value: 0 },
    uTf2SelfIllumMaskMap: { value: null as THREE.Texture | null },
    uTf2SelfIllumTint: { value: new THREE.Color(1, 1, 1) }, uTf2SelfIllumFresnel: { value: 0 },
    uTf2SelfIllumFresnelParams: { value: new THREE.Vector4(1, 0, 1, 1) },
    uTf2EnvTint: { value: new THREE.Color(0, 0, 0) }, uTf2AlphaTestRef: { value: 0 },
    uTf2Detail: { value: 0 }, uTf2DetailMap: { value: null as THREE.Texture | null },
    uTf2DetailMode: { value: 0 }, uTf2DetailScale: { value: 4 },
    uTf2DetailFactor: { value: 1 }, uTf2DetailTint: { value: new THREE.Color(1, 1, 1) },
    uTf2AmbientCube: { value: Array.from({ length: 6 }, () => new THREE.Vector3(.4, .4, .4)) },
    uTf2AmbientBasis: { value: new THREE.Matrix3() },
    uTf2SpotFalloff: { value: 0 },
  };
}

export type Tf2Uniforms = ReturnType<typeof createTf2Uniforms>;

export function configureTf2Material(
  source: WeaponMaterial,
  material: THREE.MeshPhongMaterial,
  uniforms: Tf2Uniforms,
): void {
  uniforms.uTf2PhongEnabled.value = source.phong ? 1 : 0;
  uniforms.uTf2BaseAlphaPhongMask.value = source.baseMapAlphaPhongMask ? 1 : 0;
  uniforms.uTf2NormalAlphaEnvMask.value = source.normalMapAlphaEnvmapMask ? 1 : 0;
  uniforms.uTf2PhongBoost.value = source.phongBoost ?? 1;
  uniforms.uTf2PhongExponent.value = source.phongExponent ?? 5;
  uniforms.uTf2PhongExponentFactor.value = source.phongExponentFactor ?? 0;
  uniforms.uTf2AlbedoTint.value = source.phongAlbedoTint ? 1 : 0;
  uniforms.uTf2UsePhongTint.value = source.phongTint ? 1 : 0;
  if (source.phongTint) uniforms.uTf2PhongTint.value.setRGB(...source.phongTint);
  uniforms.uTf2Fresnel.value.fromArray(source.phongFresnelRanges ?? [0, .5, 1]);
  uniforms.uTf2RimLight.value = source.rimLight ? 1 : 0;
  uniforms.uTf2RimExponent.value = source.rimLightExponent ?? 4;
  uniforms.uTf2RimBoost.value = source.rimLightBoost ?? 1;
  uniforms.uTf2RimMask.value = source.rimMask ? 1 : 0;
  uniforms.uTf2SelfIllum.value = source.selfIllum ? 1 : 0;
  uniforms.uTf2SelfIllumFresnel.value = source.selfIllumFresnel ? 1 : 0;
  const tint = source.modelGlowColor ? [1, 1, 1] : (source.selfIllumTint ?? [1, 1, 1]);
  uniforms.uTf2SelfIllumTint.value.setRGB(tint[0], tint[1], tint[2]);
  const [min, max, exponent] = source.selfIllumFresnelMinMaxExp ?? [0, 1, 1];
  const bias = Math.abs(max) > 1e-6 ? min / max : 0;
  uniforms.uTf2SelfIllumFresnelParams.value.set(1 - bias, bias, Math.max(exponent, .001), max);
  uniforms.uTf2HalfLambert.value = source.halfLambert ? 1 : 0;
  uniforms.uTf2EnvTint.value.setRGB(...source.envmapTint);
  uniforms.uTf2Detail.value = source.detailTexture ? 1 : 0;
  uniforms.uTf2DetailMode.value = source.detailBlendMode ?? 0;
  uniforms.uTf2DetailScale.value = source.detailScale ?? 4;
  uniforms.uTf2DetailFactor.value = source.detailBlendFactor ?? 1;
  uniforms.uTf2DetailTint.value.setRGB(...(source.detailTint ?? [1, 1, 1]));
  uniforms.uTf2AlphaTestRef.value = source.alphaTest ? (source.alphaTestReference ?? .5) : 0;
  material.alphaTest = 0;
  material.alphaToCoverage = false;
  material.transparent = !!source.alphaTest && !!source.alphaToCoverage;
  material.depthWrite = true;
  material.specular.setRGB(1, 1, 1);
  material.shininess = THREE.MathUtils.clamp(source.phongExponent ?? 5, 1, 300);
  material.reflectivity = 1;
  material.needsUpdate = true;
}
