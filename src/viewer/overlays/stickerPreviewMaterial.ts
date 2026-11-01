// Shader for the sticker preview decal. It maps each mesh UV back to the sticker's local UV.
import * as THREE from 'three';

export function createStickerPreviewMaterial(side: THREE.Side): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uStickerMap: { value: null as THREE.Texture | null },
      uSelectorBase: { value: null as THREE.Texture | null },
      uEndpointZero: { value: null as THREE.Texture | null },
      uEndpointOne: { value: null as THREE.Texture | null },
      uPreviewMode: { value: 0 },
      uGroupLevels: { value: new THREE.Vector3(0, 1, 1) },
      uStickerTl: { value: new THREE.Vector2() },
      uStickerTr: { value: new THREE.Vector2(1, 0) },
      uStickerBl: { value: new THREE.Vector2(0, 1) },
      uStickerCenter: { value: new THREE.Vector2(0.5, 0.5) },
      uStickerOpacity: { value: 1 },
    },
    vertexShader: `
      varying vec2 vStickerUv;
      void main() {
        vStickerUv = uv;
        #include <begin_vertex>
        #include <project_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      uniform sampler2D uStickerMap;
      uniform sampler2D uSelectorBase;
      uniform sampler2D uEndpointZero;
      uniform sampler2D uEndpointOne;
      uniform float uPreviewMode;
      uniform vec3 uGroupLevels;
      uniform vec2 uStickerTl;
      uniform vec2 uStickerTr;
      uniform vec2 uStickerBl;
      uniform vec2 uStickerCenter;
      uniform float uStickerOpacity;
      varying vec2 vStickerUv;

      vec4 adjustGroupMask(vec4 source) {
        float black = uGroupLevels.x;
        float white = uGroupLevels.y;
        float gamma = uGroupLevels.z;
        vec4 normalized;
        if (white == black) {
          normalized = vec4(greaterThan(source, vec4(black)));
        } else {
          normalized = clamp((source - black) / (white - black), 0.0, 1.0);
        }
        return pow(normalized, vec4(gamma));
      }

      void main() {
        // Pick the nearest periodic copy first, so a compact decal can straddle the 0/1 seam.
        vec2 sourceUv = vStickerUv + floor(uStickerCenter - vStickerUv + vec2(0.5));
        vec2 axisX = uStickerTr - uStickerTl;
        vec2 axisY = uStickerBl - uStickerTl;
        vec2 local = sourceUv - uStickerTl;
        float determinant = axisX.x * axisY.y - axisX.y * axisY.x;
        if (abs(determinant) < 0.00000001) discard;
        vec2 stickerUv = vec2(
          (local.x * axisY.y - local.y * axisY.x) / determinant,
          (axisX.x * local.y - axisX.y * local.x) / determinant
        );
        if (stickerUv.x < 0.0 || stickerUv.x > 1.0 || stickerUv.y < 0.0 || stickerUv.y > 1.0) discard;
        vec4 sticker = texture2D(uStickerMap, stickerUv);
        if (uPreviewMode > 0.5) {
          vec4 mask = adjustGroupMask(sticker);
          if (mask.a <= 0.001) discard;
          float selectorBase = sRGBTransferEOTF(texture2D(uSelectorBase, vStickerUv)).r;
          float selector = mix(selectorBase, mask.r, mask.a);
          vec4 endpointZero = sRGBTransferEOTF(texture2D(uEndpointZero, vStickerUv));
          vec4 endpointOne = sRGBTransferEOTF(texture2D(uEndpointOne, vStickerUv));
          vec3 desired = mix(endpointZero.rgb, endpointOne.rgb, selector);
          gl_FragColor = vec4(desired, uStickerOpacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return;
        }
        if (sticker.a <= 0.001) discard;
        gl_FragColor = vec4(sRGBTransferEOTF(sticker).rgb, sticker.a * uStickerOpacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side,
  });
}
