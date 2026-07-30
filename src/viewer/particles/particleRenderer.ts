import * as THREE from 'three';

export const particlePointScale = { value: 600 };

export function setParticlePointScale(pixelHeight: number) {
  particlePointScale.value = Math.max(1, pixelHeight) * 0.5;
}

export const PARTICLE_VERTEX = /* glsl */ `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
attribute float aFrame;
attribute float aRotation;
attribute vec4 aUvRect;
uniform float uPointScale;
varying float vAlpha;
varying vec3 vColor;
varying float vFrame;
varying float vRotation;
varying vec4 vUvRect;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  vFrame = aFrame;
  vRotation = aRotation;
  vUvRect = aUvRect;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = aSize * uPointScale * projectionMatrix[1][1] / gl_Position.w;
}
`;

export const PARTICLE_FRAGMENT = /* glsl */ `
uniform sampler2D uMap;
uniform float uFrames;
varying float vAlpha;
varying vec3 vColor;
varying float vFrame;
varying float vRotation;
varying vec4 vUvRect;
void main() {
  vec2 pc = gl_PointCoord - 0.5;
  float cr = cos( vRotation );
  float sr = sin( vRotation );
  pc = vec2( cr * pc.x - sr * pc.y, sr * pc.x + cr * pc.y ) + 0.5;
  if ( pc.x < 0.0 || pc.x > 1.0 || pc.y < 0.0 || pc.y > 1.0 ) discard;
  float raw = 1.0 - pc.y;
  float frame = clamp( floor( vFrame + 0.5 ), 0.0, uFrames - 1.0 );
  vec2 uv = vec2( pc.x, ( raw + ( uFrames - 1.0 - frame ) ) / uFrames );
  uv = mix( vUvRect.xy, vUvRect.zw, uv );
  vec4 tex = texture2D( uMap, uv );
  float a = tex.a * vAlpha;
  if ( a < 0.004 ) discard;
  gl_FragColor = vec4( tex.rgb * vColor, a );
  #include <colorspace_fragment>
}
`;

export function applyAdditiveBlending(material: THREE.ShaderMaterial) {
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.SrcAlphaFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquationAlpha = THREE.AddEquation;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
}
