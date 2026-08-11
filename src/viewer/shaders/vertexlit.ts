import * as THREE from 'three';

// TF2's VertexLitGeneric/Skin controls, layered onto three's MeshPhongMaterial.
//
// This is not a standalone shader: three compiles its own phong program and
// this module rewrites pieces of it, keyed to the `#include <...>` markers in
// the generated source. Two chunks additionally start from three's own text
// and patch lines inside it, because the parts being replaced sit in the
// middle of code worth keeping. The marker-to-source mapping therefore lives
// here with the GLSL rather than beside the Viewer, since neither half means
// anything without the other.
//
// Ports are noted against the SDK file they came from
// (materialsystem/stdshaders). The uniforms these read are created and driven
// by the Viewer; adding one here means adding it to tf2Uniforms as well.

/**
 * three caches compiled programs across materials, so anything that changes
 * the source below has to change this key too or a stale program is reused.
 */
export const TF2_VERTEXLIT_CACHE_KEY = 'tf2-vertexlit-v8-detail-alphatest';

const PARAMETERS = /* glsl */ `#include <common>
uniform float uTf2PhongEnabled, uTf2BaseAlphaPhongMask, uTf2NormalAlphaEnvMask;
uniform float uTf2PhongBoost, uTf2PhongExponent, uTf2PhongExponentFactor;
uniform float uTf2UseExponentMap, uTf2UseLightwarp, uTf2HalfLambert, uTf2AlbedoTint, uTf2UsePhongTint;
uniform float uTf2RimLight, uTf2RimExponent, uTf2RimBoost, uTf2RimMask;
uniform float uTf2SelfIllum, uTf2SelfIllumFresnel, uTf2UseSelfIllumMask;
uniform float uTf2AlphaTestRef;
uniform float uTf2Detail, uTf2DetailMode, uTf2DetailScale, uTf2DetailFactor;
uniform float uTf2SpotFalloff;
uniform sampler2D uTf2ExponentMap, uTf2LightwarpMap, uTf2SelfIllumMaskMap, uTf2DetailMap;
uniform vec3 uTf2PhongTint, uTf2Fresnel, uTf2SelfIllumTint, uTf2EnvTint, uTf2DetailTint;
uniform vec4 uTf2SelfIllumFresnelParams;
uniform vec3 uTf2AmbientCube[6];
uniform mat3 uTf2AmbientBasis;
// common_ps_fxc.h TextureCombine, verbatim apart from dropping the modes that
// need inputs this viewer has no equivalent for (ssbump). Mode numbers are the
// TCOMBINE_* values a VMT names through $detailblendmode.
vec4 tf2TextureCombine( vec4 baseColor, vec4 detailColor, float mode, float blendFactor ) {
  if ( mode == 7.0 ) { // MOD2X_SELECT_TWO_PATTERNS
    vec3 dc = vec3( mix( detailColor.r, detailColor.a, baseColor.a ) );
    baseColor.rgb *= mix( vec3( 1.0 ), 2.0 * dc, blendFactor );
  }
  if ( mode == 0.0 ) // RGB_EQUALS_BASE_x_DETAILx2
    baseColor.rgb *= mix( vec3( 1.0 ), 2.0 * detailColor.rgb, blendFactor );
  if ( mode == 1.0 ) // RGB_ADDITIVE
    baseColor.rgb += blendFactor * detailColor.rgb;
  if ( mode == 2.0 ) // DETAIL_OVER_BASE
    baseColor.rgb = mix( baseColor.rgb, detailColor.rgb, blendFactor * detailColor.a );
  if ( mode == 3.0 ) // FADE
    baseColor = mix( baseColor, detailColor, blendFactor );
  if ( mode == 4.0 ) { // BASE_OVER_DETAIL
    baseColor.rgb = mix( baseColor.rgb, detailColor.rgb, blendFactor * ( 1.0 - baseColor.a ) );
    baseColor.a = detailColor.a;
  }
  if ( mode == 8.0 ) // MULTIPLY
    baseColor = mix( baseColor, baseColor * detailColor, blendFactor );
  if ( mode == 9.0 ) // MASK_BASE_BY_DETAIL_ALPHA
    baseColor.a = mix( baseColor.a, baseColor.a * detailColor.a, blendFactor );
  return baseColor;
}
// TextureCombinePostLighting: modes 5 and 6 leave the albedo alone and add to
// the lit diffuse instead, which is why a war paint's wear pass shows up as
// light rather than as a darker albedo.
vec3 tf2TextureCombinePostLighting( vec3 litBaseColor, vec4 detailColor, float mode, float blendFactor ) {
  if ( mode == 5.0 ) // RGB_ADDITIVE_SELFILLUM
    litBaseColor += blendFactor * detailColor.rgb;
  if ( mode == 6.0 ) { // RGB_ADDITIVE_SELFILLUM_THRESHOLD_FADE
    float f = blendFactor - 0.5;
    float fMult = ( f >= 0.0 ) ? 1.0 / blendFactor : 4.0 * blendFactor;
    float fAdd = ( f >= 0.0 ) ? 1.0 - fMult : -0.5 * fMult;
    litBaseColor += saturate( fMult * detailColor.rgb + fAdd );
  }
  return litBaseColor;
}
vec3 tf2AmbientLight( vec3 worldNormal ) {
  vec3 sourceNormal = normalize( uTf2AmbientBasis * worldNormal );
  vec3 n2 = sourceNormal * sourceNormal;
  return n2.x * uTf2AmbientCube[sourceNormal.x < 0.0 ? 1 : 0]
       + n2.y * uTf2AmbientCube[sourceNormal.y < 0.0 ? 3 : 2]
       + n2.z * uTf2AmbientCube[sourceNormal.z < 0.0 ? 5 : 4];
}`;

const SPECULAR_MASK = /* glsl */ `float tf2NormalAlpha = 1.0;
#ifdef USE_NORMALMAP
  tf2NormalAlpha = texture2D( normalMap, vNormalMapUv ).a;
#endif
float tf2SpecMask = mix( tf2NormalAlpha, diffuseColor.a, uTf2BaseAlphaPhongMask );
// skin_ps20b.fxc: fEnvMapMask = lerp( baseColor.a, fSpecMask, $normalmapalphaenvmapmask ).
// The skin (phong) path always masks the cubemap by base alpha, which for
// warpaints is the composited metal mask; $basealphaenvmapmask is never read.
float tf2EnvMask = mix( diffuseColor.a, tf2SpecMask, uTf2NormalAlphaEnvMask );
float specularStrength = uTf2PhongEnabled * uTf2PhongBoost * tf2SpecMask;`;

// Compositor targets stay raw RGBA8 so pooled targets never change GPU
// formats. Their RGB bytes are sRGB-encoded; decode only the base color here
// while preserving alpha as the Source phong/environment mask.
const BASE_AND_DETAIL = /* glsl */ `#ifdef USE_MAP
  vec4 sampledDiffuseColor = sRGBTransferEOTF( texture2D( map, vMapUv ) );
  diffuseColor *= sampledDiffuseColor;
#endif
// $detail, sampled at base UV * $detailscale (the detail transform is the base
// transform scaled, see BaseVSShader SetVertexShaderTextureScaledTransform).
// Kept in scope because modes 5 and 6 need it again after lighting.
vec4 tf2DetailColor = vec4( 1.0 );
#ifdef USE_MAP
if ( uTf2Detail > 0.0 ) {
  vec4 tf2DetailTexel = texture2D( uTf2DetailMap, vMapUv * uTf2DetailScale );
  // vertexlitgeneric_dx9_helper.cpp loads $detail with TEXTUREFLAGS_SRGB for
  // every blend mode except Mod2X, which reads it raw.
  tf2DetailColor = uTf2DetailMode == 0.0 ? tf2DetailTexel : sRGBTransferEOTF( tf2DetailTexel );
  tf2DetailColor.rgb *= uTf2DetailTint;
  diffuseColor = tf2TextureCombine( diffuseColor, tf2DetailColor, uTf2DetailMode, uTf2DetailFactor );
}
#endif`;

// Source's alpha test, which is a plain compare against the reference. It runs
// here, against a uniform, so that an imported material switching it on costs
// no recompile, and because three's own chunk can remap alpha through
// smoothstep( alphaTest, alphaTest + fwidth( a ), a ) to antialias the cut edge
// of a foliage-style texture. A war paint's alpha is flat across the whole
// weapon, so fwidth is zero there and that remap would snap every fragment back
// to fully opaque, losing exactly the see-through $allowalphatocoverage asks
// for. Whatever survives the compare keeps its alpha and is blended by it.
const ALPHA_TEST = /* glsl */ `if ( uTf2AlphaTestRef > 0.0 && diffuseColor.a < uTf2AlphaTestRef ) discard;`;

const PHONG_MATERIAL = /* glsl */ `BlinnPhongMaterial material;
material.diffuseColor = diffuseColor.rgb;
vec4 tf2Exp = vec4( 1.0 );
#ifdef USE_MAP
  tf2Exp = texture2D( uTf2ExponentMap, vMapUv );
#endif
vec3 tf2MappedTint = mix( vec3( 1.0 ), diffuseColor.rgb, tf2Exp.g * uTf2AlbedoTint );
material.specularColor = mix( tf2MappedTint, uTf2PhongTint, uTf2UsePhongTint );
material.specularShininess = max( 1.0, mix( uTf2PhongExponent, 1.0 + uTf2PhongExponentFactor * tf2Exp.r, uTf2UseExponentMap ) );
material.specularStrength = specularStrength;
material.tf2RimMask = mix( 1.0, tf2Exp.a, uTf2RimMask );`;

// three assembles the final colour on one line inside <opaque_fragment>, so
// this replaces that statement rather than an include.
const OUTGOING_LIGHT_MARKER = 'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;';

const OUTGOING_LIGHT = /* glsl */ `vec3 tf2AmbientWorldNormal = normalize( transformNormalByInverseViewMatrix( normal, viewMatrix ) );
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
// vertexlit_and_unlit_generic_ps2x.fxc combines the detail texture into the
// lit diffuse before self-illumination and before specular is added.
if ( uTf2Detail > 0.0 ) {
  tf2LitDiffuse = tf2TextureCombinePostLighting( tf2LitDiffuse, tf2DetailColor, uTf2DetailMode, uTf2DetailFactor );
}
tf2LitDiffuse = mix(
  tf2LitDiffuse,
  diffuseColor.rgb * uTf2SelfIllumTint * tf2SelfIllumBrightness,
  tf2SelfIllumMask
);
vec3 outgoingLight = tf2LitDiffuse + reflectedLight.directSpecular
  + reflectedLight.indirectSpecular + tf2AmbientRim + totalEmissiveRadiance;`;

const ENVIRONMENT_MAP = /* glsl */ `#ifdef USE_ENVMAP
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
#endif`;

/** Whole-chunk substitutions, applied in order. */
const CHUNKS: readonly [marker: string, source: string][] = [
  ['#include <common>', PARAMETERS],
  ['#include <specularmap_fragment>', SPECULAR_MASK],
  ['#include <map_fragment>', BASE_AND_DETAIL],
  ['#include <alphatest_fragment>', ALPHA_TEST],
  ['#include <lights_phong_fragment>', PHONG_MATERIAL],
  [OUTGOING_LIGHT_MARKER, OUTGOING_LIGHT],
  ['#include <envmap_fragment>', ENVIRONMENT_MAP],
];

/**
 * A tangent normal map is only meaningful when the material is not spending
 * base alpha on the phong mask, so the sampled normal is flattened when it is.
 */
function normalFragmentMaps(): string {
  return THREE.ShaderChunk.normal_fragment_maps
    .replace('mapN.xy *= normalScale;', 'mapN.xy *= normalScale;\n\tmapN = mix( mapN, vec3( 0.0, 0.0, 1.0 ), uTf2BaseAlphaPhongMask );')
    .replace('normal = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;', 'normal = mix( texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0, vec3( 0.0, 0.0, 1.0 ), uTf2BaseAlphaPhongMask );');
}

/**
 * Source's direct lighting in place of three's: a half-lambert or lightwarp
 * diffuse term, and a specular highlight built from the reflection vector with
 * a Fresnel ramp, which the rim light then competes with rather than adds to.
 * Patched into three's own chunk because the surrounding light loop stays.
 */
function lightsPhongPars(): string {
  return THREE.ShaderChunk.lights_phong_pars_fragment
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
}

/** Rewrites a freshly generated phong fragment shader into the TF2 one. */
export function installTf2VertexLit(shader: THREE.WebGLProgramParametersWithUniforms): void {
  for (const [marker, source] of CHUNKS) {
    shader.fragmentShader = shader.fragmentShader.replace(marker, source);
  }
  shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', normalFragmentMaps());
  shader.fragmentShader = shader.fragmentShader.replace('#include <lights_phong_pars_fragment>', lightsPhongPars());
  shader.fragmentShader = shader.fragmentShader.replace(
    'return smoothstep( coneCosine, penumbraCosine, angleCosine );',
    `if ( uTf2SpotFalloff > 0.0 ) {
      float tf2Cone = saturate( ( angleCosine - coneCosine ) / max( penumbraCosine - coneCosine, 1e-6 ) );
      return pow( tf2Cone, uTf2SpotFalloff );
    }
    return smoothstep( coneCosine, penumbraCosine, angleCosine );`,
  );
}
