import * as THREE from 'three';

// $EmissiveBlendEnabled is drawn as a whole extra pass over the weapon
// (emissive_scroll_blended_pass_ps2x.fxc), not a term in the lit shader. With no
// alpha test of its own, it still glows where an $alphatest body was cut away.
// The flow map supplies the emissive UV outright, rather than offsetting it.

/** SHADER_PARAM defaults from vertexlitgeneric_dx9.cpp. */
export const EMISSIVE_DEFAULT_SCROLL: [number, number] = [0.11, 0.124];
export const EMISSIVE_DEFAULT_STRENGTH = 1;

// This pass draws the weapon's own geometry coincident with it, so its depth must
// match bit for bit or the glow flickers in speckles. Use three's chunks verbatim:
// projectionMatrix * modelViewMatrix * position multiplies the matrices first and
// rounds differently from the weapon's own transform.
const EMISSIVE_VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
#include <clipping_planes_pars_vertex>
varying vec2 vEmissiveUv;
void main() {
  vEmissiveUv = uv;
  #include <skinbase_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
}
`;

// sRGBTransferEOTF and linearToOutputTexel come from the prefix three adds to every
// ShaderMaterial. Including <colorspace_pars_fragment> again would redefine them,
// fail the compile and silently drop the whole pass.
const EMISSIVE_FRAGMENT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform sampler2D uEmissiveBaseMap;
uniform sampler2D uEmissiveFlowMap;
uniform sampler2D uEmissiveMap;
uniform vec3 uEmissiveTint;
uniform vec2 uEmissiveScroll;
uniform float uEmissiveStrength;
uniform float uEmissiveTime;
uniform float uEmissiveCoverage;
varying vec2 vEmissiveUv;
void main() {
  #include <clipping_planes_fragment>
  vec3 baseColor = sRGBTransferEOTF( texture2D( uEmissiveBaseMap, vEmissiveUv ) ).rgb;
  vec2 flowValue = texture2D( uEmissiveFlowMap, vEmissiveUv ).xy;
  vec2 emissiveUv = flowValue + uEmissiveScroll * uEmissiveTime;
  vec3 emissiveColor = sRGBTransferEOTF( texture2D( uEmissiveMap, emissiveUv ) ).rgb;
  // Alpha stays zero as in the fxc, so the pass adds light without ever
  // reducing what the weapon already wrote to the frame.
  gl_FragColor = vec4( baseColor * emissiveColor * uEmissiveTint * uEmissiveStrength, 0.0 );
  // Source adds the pass into the HDR buffer before tone mapping, so the glow takes
  // the preset's exposure too or it reads as half strength on brighter maps.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // On a see-through canvas, light added over nothing is lost unless it also counts as coverage.
  gl_FragColor.a = uEmissiveCoverage * max( max( gl_FragColor.r, gl_FragColor.g ), gl_FragColor.b );
}
`;

/** The pass material, with textures and constants swapped in per applied material. */
export function createEmissiveMaterial(side: THREE.Side): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uEmissiveBaseMap: { value: null },
      uEmissiveFlowMap: { value: null },
      uEmissiveMap: { value: null },
      uEmissiveTint: { value: new THREE.Color(1, 1, 1) },
      uEmissiveScroll: { value: new THREE.Vector2(...EMISSIVE_DEFAULT_SCROLL) },
      uEmissiveStrength: { value: 0 },
      uEmissiveTime: { value: 0 },
      uEmissiveCoverage: { value: 0 },
    },
    vertexShader: EMISSIVE_VERTEX,
    fragmentShader: EMISSIVE_FRAGMENT,
    clipping: true,
    // EnableAlphaBlending(ONE, ONE) with alpha writes off. three's AdditiveBlending
    // premultiplies by src alpha, which is zero here, so the factors are set explicitly.
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendEquation: THREE.AddEquation,
    depthTest: true,
    depthWrite: false,
    side,
  });
}

let whiteFallback: THREE.DataTexture | null = null;

/**
 * The identity input for the pass's multiply: black would swallow the glow when
 * a material names no flow or emissive map.
 */
export function whiteTexture(): THREE.DataTexture {
  if (!whiteFallback) {
    whiteFallback = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteFallback.needsUpdate = true;
  }
  return whiteFallback;
}

/**
 * Sampler setup for the pass's textures. The base and emissive maps are decoded in
 * the shader; the flow map carries UVs, not color, so it is sampled raw.
 */
export function configureEmissiveTexture(texture: THREE.Texture): THREE.Texture {
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false; // glTF UV convention, same as the composited map
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}
