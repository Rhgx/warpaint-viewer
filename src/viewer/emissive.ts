import * as THREE from 'three';

// $EmissiveBlendEnabled
//
// VertexLitGeneric draws this as a whole extra pass over the weapon
// (materialsystem/stdshaders/emissive_scroll_blended_pass_ps2x.fxc, wired up
// in vertexlitgeneric_dx9.cpp SetupVarsEmissiveScrollBlendedPass), not as a
// term inside the lit shader. That matters for more than tidiness: the pass
// has no alpha test of its own, so an $alphatest material still glows where
// its body was cut away (which is how the Ghastly Guns pack gets a weapon
// that is see-through and still lit up).
//
// Note the flow texture supplies the emissive sample's UV outright rather
// than offsetting it, and that only the base and emissive samplers take sRGB
// reads (emissive_scroll_blended_pass_helper.cpp InitEmissiveScrollBlendedPass).

/** SHADER_PARAM defaults from vertexlitgeneric_dx9.cpp. */
export const EMISSIVE_DEFAULT_SCROLL: [number, number] = [0.11, 0.124];
export const EMISSIVE_DEFAULT_STRENGTH = 1;

// This pass draws a copy of the weapon's own geometry, exactly coincident with
// it, so its depth has to come out bit for bit the same as the weapon's or the
// depth test rejects the glow on a shifting speckle of pixels as the model
// turns. three's chunks are used verbatim for that reason: writing the same
// transform out by hand is not enough, since
// projectionMatrix * modelViewMatrix * position multiplies the two matrices
// together first and rounds differently to the weapon's two matrix by vector
// products.
const EMISSIVE_VERTEX = /* glsl */ `
varying vec2 vEmissiveUv;
void main() {
  vEmissiveUv = uv;
  #include <begin_vertex>
  #include <project_vertex>
}
`;

// sRGBTransferEOTF and linearToOutputTexel come from the fragment prefix three
// prepends to every ShaderMaterial; including <colorspace_pars_fragment> here
// as well would redefine them and fail the compile, which silently costs the
// whole pass (the draw still issues, against a program that never linked).
const EMISSIVE_FRAGMENT = /* glsl */ `
#include <common>
uniform sampler2D uEmissiveBaseMap;
uniform sampler2D uEmissiveFlowMap;
uniform sampler2D uEmissiveMap;
uniform vec3 uEmissiveTint;
uniform vec2 uEmissiveScroll;
uniform float uEmissiveStrength;
uniform float uEmissiveTime;
varying vec2 vEmissiveUv;
void main() {
  vec3 baseColor = sRGBTransferEOTF( texture2D( uEmissiveBaseMap, vEmissiveUv ) ).rgb;
  vec2 flowValue = texture2D( uEmissiveFlowMap, vEmissiveUv ).xy;
  vec2 emissiveUv = flowValue + uEmissiveScroll * uEmissiveTime;
  vec3 emissiveColor = sRGBTransferEOTF( texture2D( uEmissiveMap, emissiveUv ) ).rgb;
  // Alpha stays zero as in the fxc, so the pass adds light without ever
  // reducing what the weapon already wrote to the frame.
  gl_FragColor = vec4( baseColor * emissiveColor * uEmissiveTint * uEmissiveStrength, 0.0 );
  // The pass belongs to the same frame as the weapon under it: Source adds it
  // into the HDR buffer and tone maps the result, so the glow has to take the
  // preset's exposure too or it reads as half strength on the brighter maps.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

/**
 * The pass material. One is created per Viewer and reused; the textures and
 * constants are swapped in whenever a material is applied.
 */
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
    },
    vertexShader: EMISSIVE_VERTEX,
    fragmentShader: EMISSIVE_FRAGMENT,
    // EnableAlphaBlending( SHADER_BLEND_ONE, SHADER_BLEND_ONE ) with alpha
    // writes off. three's AdditiveBlending would premultiply by src alpha,
    // which is zero here, so the factors are set explicitly.
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
 * The identity input for this pass's multiply. A material that names no flow
 * or emissive map still has to sample something, and black would swallow the
 * glow entirely.
 */
export function whiteTexture(): THREE.DataTexture {
  if (!whiteFallback) {
    whiteFallback = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    whiteFallback.needsUpdate = true;
  }
  return whiteFallback;
}

/**
 * Sampler setup shared by the pass's three textures. The base and emissive
 * maps are decoded in the shader (the fxc's sRGB reads); the flow map carries
 * UV coordinates, not color, and is sampled raw.
 */
export function configureEmissiveTexture(texture: THREE.Texture): THREE.Texture {
  texture.colorSpace = THREE.NoColorSpace;
  texture.flipY = false; // glTF UV convention, same as the composited map
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}
