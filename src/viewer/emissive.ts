import * as THREE from 'three';

// ---------------------------------------------------------------------------
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
// The fxc, in full:
//
//   float4 cBaseColor = tex2D( g_tBaseSampler, i.vTexCoord0.xy );
//   float4 vFlowValue = tex2D( g_tFlowSampler, i.vTexCoord0.xy );
//   float2 vEmissiveTexCoord = vFlowValue.xy + ( g_vEmissiveScrollVector.xy * g_flTime );
//   float4 cEmissiveColor = tex2D( g_tSelfIllumSampler, vEmissiveTexCoord.xy );
//   result.rgb = cBaseColor.rgb * cEmissiveColor.rgb * g_cSelfIllumTint.rgb;
//   result.rgb *= g_flBlendStrength;
//   result.a = 0.0f;
//
// Note the flow texture supplies the emissive sample's UV outright rather
// than offsetting it, and that only the base and emissive samplers take sRGB
// reads (emissive_scroll_blended_pass_helper.cpp InitEmissiveScrollBlendedPass).
// ---------------------------------------------------------------------------

/** SHADER_PARAM defaults from vertexlitgeneric_dx9.cpp. */
export const EMISSIVE_DEFAULT_SCROLL: [number, number] = [0.11, 0.124];
export const EMISSIVE_DEFAULT_STRENGTH = 1;

const EMISSIVE_VERTEX = /* glsl */ `
varying vec2 vEmissiveUv;
void main() {
  vEmissiveUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
}
`;

const EMISSIVE_FRAGMENT = /* glsl */ `
#include <common>
#include <colorspace_pars_fragment>
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
