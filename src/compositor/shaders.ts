// GLSL for the compositor. One uber fragment shader implements every combine op
// from compositor_ps2x.fxc. Modes mirror ECombineOperation plus a TEXTURE mode
// used for texture_lookup leaves and for applying a stage's own output
// transform/adjust (combine stages carry these fields too).

export const MODE_MULTIPLY = 0;
export const MODE_ADD = 1;
export const MODE_LERP = 2;
export const MODE_SELECT = 3;
export const MODE_BLEND = 6;
export const MODE_TEXTURE = 10; // sample with UV transform + AdjustLevels

// RawShaderMaterial: three injects nothing, so declare the geometry attributes.
export const VERT = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// Source enables sRGB reads and writes around almost every compositor pass.
// Shader math is linear, but the 8-bit intermediate targets store sRGB values;
// this matters because quantizing linear RGB produced visibly wrong dark wear.
// AdjustLevels replicates the fxc: Photoshop levels performed in sRGB space
// (convert linear->sRGB, level, convert back), which is what TF2 does.
export const FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform int  uMode;
uniform sampler2D uTex0;
uniform sampler2D uTex1;
uniform sampler2D uTex2;
uniform sampler2D uTex3;
uniform vec3 uAdjust0; // black, white, gamma
uniform vec3 uAdjust1;
uniform vec3 uAdjust2;
uniform vec3 uAdjust3;
uniform float uSrgb0;
uniform float uSrgb1;
uniform float uSrgb2;
uniform float uSrgb3;
uniform mat3 uUv0;
uniform mat3 uUv1;
uniform mat3 uUv2;
uniform mat3 uUv3;
uniform float uSelect[16];  // select group ids pre-scaled by 1/16 (cFac)
uniform int uNumSelect;
uniform vec2 uDestTl;       // sticker parallelogram corners in dest UV space
uniform vec2 uDestTr;
uniform vec2 uDestBl;

vec3 srgb2lin(vec3 c) {
  vec3 lo = c / 12.92;
  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));
  return mix(lo, hi, step(vec3(0.04045), c));
}
vec3 lin2srgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055;
  return mix(lo, hi, step(vec3(0.0031308), c));
}

vec4 samp(sampler2D t, vec2 uvc, float srgb) {
  vec4 c = texture(t, uvc);
  if (srgb > 0.5) c.rgb = srgb2lin(c.rgb);
  return c;
}

void writeLinear(vec4 c) {
  fragColor = vec4(lin2srgb(clamp(c.rgb, 0.0, 1.0)), clamp(c.a, 0.0, 1.0));
}

// Photoshop levels, as compositor_ps2x.fxc AdjustLevels(float4). Real recipes
// carry degenerate ranges (white == black, e.g. adjustOffset [0,0]); HLSL's
// saturate(inf/NaN) turns that into a threshold at the black point, which we
// reproduce explicitly since GLSL clamp(NaN) is undefined.
vec4 adjustLevels(vec4 src, vec3 bwg) {
  float black = bwg.x, white = bwg.y, gamma = bwg.z;
  if (black == 0.0 && white == 1.0 && gamma == 1.0) return src;
  vec4 s = vec4(lin2srgb(src.rgb), src.a); // ConvertLinearTosRGB leaves alpha
  vec4 pcg;
  if (white == black) {
    pcg = vec4(greaterThan(s, vec4(black))); // 1 where src > black, else 0
  } else {
    pcg = clamp((s - black) / (white - black), 0.0, 1.0);
  }
  vec4 g = pow(pcg, vec4(gamma));
  return clamp(vec4(srgb2lin(g.rgb), g.a), 0.0, 1.0);
}

void main() {
  if (uMode == ${MODE_TEXTURE}) {
    vec2 uvc = (uUv0 * vec3(vUv, 1.0)).xy;
    writeLinear(adjustLevels(samp(uTex0, uvc, uSrgb0), uAdjust0));
    return;
  }
  if (uMode == ${MODE_SELECT}) {
    // fxc: fTestColor = round(byte * 255 / 16); constants are id * (1/16).
    // sampler0 read is linear (no sRGB decode) for select in compositor.cpp.
    float x = texture(uTex0, vUv).r;
    float testColor = floor(x * 255.0 / 16.0 + 0.5);
    bool matched = false;
    for (int i = 0; i < 16; ++i) {
      if (i >= uNumSelect) break;
      if (uSelect[i] != 0.0 && floor(uSelect[i] + 0.5) == testColor) matched = true;
    }
    writeLinear(matched ? vec4(1.0) : vec4(0.0));
    return;
  }
  if (uMode == ${MODE_MULTIPLY}) {
    vec4 c0 = adjustLevels(samp(uTex0, (uUv0 * vec3(vUv, 1.0)).xy, uSrgb0), uAdjust0);
    vec4 c1 = adjustLevels(samp(uTex1, (uUv1 * vec3(vUv, 1.0)).xy, uSrgb1), uAdjust1);
    vec4 c2 = adjustLevels(samp(uTex2, (uUv2 * vec3(vUv, 1.0)).xy, uSrgb2), uAdjust2);
    vec4 c3 = adjustLevels(samp(uTex3, (uUv3 * vec3(vUv, 1.0)).xy, uSrgb3), uAdjust3);
    writeLinear(c0 * c1 * c2 * c3);
    return;
  }
  if (uMode == ${MODE_ADD}) {
    vec4 c0 = adjustLevels(samp(uTex0, (uUv0 * vec3(vUv, 1.0)).xy, uSrgb0), uAdjust0);
    vec4 c1 = adjustLevels(samp(uTex1, (uUv1 * vec3(vUv, 1.0)).xy, uSrgb1), uAdjust1);
    vec4 c2 = adjustLevels(samp(uTex2, (uUv2 * vec3(vUv, 1.0)).xy, uSrgb2), uAdjust2);
    vec4 c3 = adjustLevels(samp(uTex3, (uUv3 * vec3(vUv, 1.0)).xy, uSrgb3), uAdjust3);
    writeLinear(c0 + c1 + c2 + c3);
    return;
  }
  if (uMode == ${MODE_LERP}) {
    vec4 c0 = adjustLevels(samp(uTex0, (uUv0 * vec3(vUv, 1.0)).xy, uSrgb0), uAdjust0);
    vec4 c1 = adjustLevels(samp(uTex1, (uUv1 * vec3(vUv, 1.0)).xy, uSrgb1), uAdjust1);
    vec4 sel = adjustLevels(samp(uTex2, (uUv2 * vec3(vUv, 1.0)).xy, uSrgb2), uAdjust2);
    writeLinear(mix(c0, c1, sel.x)); // lerp(color0, color1, colSel.xxxx)
    return;
  }
  if (uMode == ${MODE_BLEND}) {
    // Sticker blend. tex0 = surface so far, tex1 = sticker mapped onto the
    // parallelogram TL/TR/BL, tex2 = the optional grayscale specular map.
    vec4 c0 = adjustLevels(samp(uTex0, (uUv0 * vec3(vUv, 1.0)).xy, uSrgb0), uAdjust0);
    vec2 U = uDestTr - uDestTl;
    vec2 V = uDestBl - uDestTl;
    float det = U.x * V.y - U.y * V.x;
    vec2 rel = vUv - uDestTl;
    float a = det != 0.0 ? ( rel.x * V.y - rel.y * V.x) / det : -1.0;
    float b = det != 0.0 ? (-rel.x * U.y + rel.y * U.x) / det : -1.0;
    float inside = step(0.0, a) * step(a, 1.0) * step(0.0, b) * step(b, 1.0);
    // a runs TL->TR (sticker u), b runs TL->BL (sticker v downward). Sources
    // upload unflipped (flipY=false), so image top is v=0 and (a, b) samples
    // the sticker upright in the v-down composite space.
    vec4 c1 = adjustLevels(samp(uTex1, vec2(a, b), uSrgb1), uAdjust1);
    float stickerSpec = samp(uTex2, vec2(a, b), uSrgb2).r;
    float alpha = c1.a * inside;
    vec3 col = (1.0 - alpha) * c0.rgb + alpha * c1.rgb;
    float spec = (1.0 - alpha) * c0.a + alpha * stickerSpec;
    writeLinear(vec4(col, spec));
    return;
  }
  writeLinear(vec4(0.0, 1.0, 0.0, 1.0)); // cErrColor
}
`;
