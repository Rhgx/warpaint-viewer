import * as THREE from 'three';

export interface ScreenshotSize {
  readonly maxEdge: number;
}

export interface ScreenshotCapture {
  readonly width: number;
  readonly height: number;
  readonly paddingScale: number;
  readonly outputMaxEdge: number | null;
}

export function resolveScreenshotCapture(
  size: number | ScreenshotSize,
  viewportWidth: number,
  viewportHeight: number,
): ScreenshotCapture {
  if (typeof size === 'number') {
    return {
      width: viewportWidth * size,
      height: viewportHeight * size,
      paddingScale: size,
      outputMaxEdge: null,
    };
  }
  const scale = size.maxEdge / Math.max(viewportWidth, viewportHeight);
  return {
    width: Math.max(1, Math.round(viewportWidth * scale)),
    height: Math.max(1, Math.round(viewportHeight * scale)),
    paddingScale: scale,
    outputMaxEdge: size.maxEdge,
  };
}

export function fitScreenshotCapture(
  capture: ScreenshotCapture,
  maxDimension: number,
  maxPixels: number,
): ScreenshotCapture {
  const scale = Math.min(
    1,
    maxDimension / Math.max(capture.width, capture.height),
    Math.sqrt(maxPixels / (capture.width * capture.height)),
  );
  if (scale === 1) return capture;
  return {
    ...capture,
    width: Math.max(1, Math.floor(capture.width * scale)),
    height: Math.max(1, Math.floor(capture.height * scale)),
    paddingScale: capture.paddingScale * scale,
  };
}

export function screenshotOutputSize(
  croppedWidth: number,
  croppedHeight: number,
  outputMaxEdge: number | null,
): { readonly width: number; readonly height: number } {
  if (outputMaxEdge === null) return { width: croppedWidth, height: croppedHeight };
  if (croppedWidth >= croppedHeight) {
    return {
      width: outputMaxEdge,
      height: Math.max(1, Math.round(croppedHeight * outputMaxEdge / croppedWidth)),
    };
  }
  return {
    width: Math.max(1, Math.round(croppedWidth * outputMaxEdge / croppedHeight)),
    height: outputMaxEdge,
  };
}

export function screenshotWatermarkScale(width: number, height: number): number {
  // Fit the same watermark proportions in landscape and portrait exports.
  return Math.min(Math.max(width, height) / 1280, Math.min(width, height) / 720);
}

export async function screenshotPixelsToBlob(
  raw: Uint8Array,
  width: number,
  height: number,
  paddingScale: number,
  outputMaxEdge: number | null,
  firstPersonWatermark = false,
): Promise<Blob> {
  const image = new ImageData(width, height);
  const out = image.data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = y * width * 4;
    for (let x = 0; x < width * 4; x += 4) {
      const r = raw[src + x];
      const g = raw[src + x + 1];
      const b = raw[src + x + 2];
      const a = raw[src + x + 3];
      const cover = Math.max(a, r, g, b);
      if (cover === 0) continue;
      out[dst + x] = Math.min(255, Math.round((r * 255) / cover));
      out[dst + x + 1] = Math.min(255, Math.round((g * 255) / cover));
      out[dst + x + 2] = Math.min(255, Math.round((b * 255) / cover));
      out[dst + x + 3] = cover;
      const pixelX = x / 4;
      minX = Math.min(minX, pixelX);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, pixelX);
      maxY = Math.max(maxY, y);
    }
  }

  const hasContent = maxX >= minX && maxY >= minY;
  const padding = Math.max(8, Math.round(24 * paddingScale));
  const cropLeft = hasContent ? Math.max(0, minX - padding) : 0;
  const cropTop = hasContent ? Math.max(0, minY - padding) : 0;
  const cropRight = hasContent ? Math.min(width, maxX + 1 + padding) : width;
  const cropBottom = hasContent ? Math.min(height, maxY + 1 + padding) : height;
  const cropped = document.createElement('canvas');
  cropped.width = cropRight - cropLeft;
  cropped.height = cropBottom - cropTop;
  const croppedContext = cropped.getContext('2d');
  if (!croppedContext) throw new Error('[warpaint-viewer] screenshot canvas 2d context unavailable');
  croppedContext.putImageData(image, -cropLeft, -cropTop);

  const outputSize = screenshotOutputSize(cropped.width, cropped.height, outputMaxEdge);
  let output = cropped;
  if (outputSize.width !== cropped.width || outputSize.height !== cropped.height) {
    output = document.createElement('canvas');
    output.width = outputSize.width;
    output.height = outputSize.height;
    const outputContext = output.getContext('2d');
    if (!outputContext) throw new Error('[warpaint-viewer] screenshot resize canvas 2d context unavailable');
    outputContext.imageSmoothingQuality = 'high';
    outputContext.drawImage(cropped, 0, 0, output.width, output.height);
  }

  if (firstPersonWatermark) {
    const logo = new Image();
    logo.src = `${import.meta.env.BASE_URL}watermark-logo.svg`;
    await Promise.all([
      logo.decode(),
      document.fonts.load('600 18px "Barlow Semi Condensed"'),
      document.fonts.load('400 14px "Barlow Semi Condensed"'),
    ]);
    const context = output.getContext('2d');
    if (!context) throw new Error('[warpaint-viewer] watermark canvas 2d context unavailable');
    // Draw after cropping and resizing so the label stays inside every export.
    const scale = screenshotWatermarkScale(output.width, output.height);
    context.save();
    context.scale(scale, scale);
    context.translate(28, output.height / scale - 70);
    context.globalAlpha = 0.62;
    context.drawImage(logo, 0, 0, 38, 41);
    context.fillStyle = '#fff';
    context.textBaseline = 'top';
    context.font = '600 18px "Barlow Semi Condensed", sans-serif';
    context.letterSpacing = '1.5px';
    context.fillText('WAR PAINT VIEWER', 52, 3);
    context.globalAlpha = 0.48;
    context.font = '400 14px "Barlow Semi Condensed", sans-serif';
    context.letterSpacing = '0px';
    context.fillText('Not an in-game screenshot', 52, 26);
    context.restore();
  }

  const blob = await new Promise<Blob | null>((resolve) => output.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('[warpaint-viewer] screenshot capture failed');
  return blob;
}

/**
 * Bounding box (top-left origin) of every non-empty pixel in a bottom-up
 * WebGL readback, merged into `box` as [minX, minY, maxX, maxY].
 */
export function unionContentBounds(raw: Uint8Array, width: number, height: number, box: number[]): void {
  for (let row = 0; row < height; row++) {
    const y = height - 1 - row;
    for (let x = 0; x < width; x++) {
      const i = (row * width + x) * 4;
      if (Math.max(raw[i], raw[i + 1], raw[i + 2], raw[i + 3]) === 0) continue;
      box[0] = Math.min(box[0], x);
      box[1] = Math.min(box[1], y);
      box[2] = Math.max(box[2], x);
      box[3] = Math.max(box[3], y);
    }
  }
}

/** How a flattened turntable frame treats transparency (see TurntableFrameResolver). */
type TurntableAlpha = 'binary' | 'full';

/**
 * Brightness (display terms) below which glow and translucent effects become
 * transparent in binary-alpha frames. Low, so most of a glow's falloff survives.
 */
const TURNTABLE_GLOW_CUTOFF = 0.25;

// Pass 1: exact box filter of each output pixel's factor x factor subsamples,
// fetched from the render target's sRGB texture (decoded to linear on fetch).
// Alpha carries +2 when any subsample is fully covered, marking solid geometry.
const FILTER_SHADER = `
  uniform sampler2D source;
  uniform int factor;
  void main() {
    ivec2 origin = ivec2(gl_FragCoord.xy) * factor;
    vec4 sum = vec4(0.0);
    float solid = 0.0;
    for (int y = 0; y < factor; y++) {
      for (int x = 0; x < factor; x++) {
        vec4 texel = texelFetch(source, origin + ivec2(x, y), 0);
        sum += texel;
        solid = max(solid, step(0.999, texel.a));
      }
    }
    vec4 mean = sum / float(factor * factor);
    gl_FragColor = vec4(mean.rgb, mean.a + 2.0 * solid);
  }`;

// Pass 2: optional seam crossfade toward a held frame, then flatten to 8-bit
// straight-alpha sRGB, written upside down so the readback is top-down.
const FLATTEN_SHADER = `
  uniform sampler2D filtered;
  uniform sampler2D held;
  uniform float blend;
  uniform int mode; // 0: over background, 1: full alpha, 2: binary alpha
  uniform vec3 background;
  uniform float glowCutoff;
  uniform int outHeight;
  float encode(float v) {
    v = clamp(v, 0.0, 1.0);
    return v <= 0.0031308 ? v * 12.92 : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
  }
  vec3 encode3(vec3 v) { return vec3(encode(v.r), encode(v.g), encode(v.b)); }
  void main() {
    ivec2 coord = ivec2(int(gl_FragCoord.x), outHeight - 1 - int(gl_FragCoord.y));
    vec4 p = texelFetch(filtered, coord, 0);
    float solid = step(1.5, p.a);
    p.a -= 2.0 * solid;
    if (blend > 0.0) {
      vec4 h = texelFetch(held, coord, 0);
      float heldSolid = step(1.5, h.a);
      h.a -= 2.0 * heldSolid;
      p = mix(p, h, blend);
      solid = max(solid, heldSolid);
    }
    float a = min(p.a, 1.0);
    if (mode == 0) {
      gl_FragColor = vec4(encode3(p.rgb + background * (1.0 - a)), 1.0);
    } else if (mode == 1) {
      vec3 e = encode3(p.rgb);
      float cover = max(a, max(e.r, max(e.g, e.b)));
      gl_FragColor = cover < 0.5 / 255.0 ? vec4(0.0) : vec4(min(e / cover, 1.0), cover);
    } else if (solid > 0.5) {
      gl_FragColor = a < 0.5 ? vec4(0.0) : vec4(encode3(p.rgb / a), 1.0);
    } else {
      bool faint = a < glowCutoff && max(p.r, max(p.g, p.b)) < glowCutoff;
      gl_FragColor = faint ? vec4(0.0) : vec4(encode3(p.rgb), 1.0);
    }
  }`;

/**
 * Turns supersampled turntable renders into finished frames on the GPU: box
 * filter, optional seam crossfade, then flatten to straight-alpha 8-bit RGBA,
 * so only the final bytes cross back to the CPU.
 *
 * With a `background` (0xRRGGBB) everything is composited over it and every
 * pixel is opaque. Otherwise `alpha` picks the transparency the format holds:
 *
 * 'full' matches PNG screenshots: display-encoded, premultiplied colour is
 * divided by its coverage, where coverage also counts additive light (glows
 * carry colour without alpha), so glows fade out smoothly.
 *
 * 'binary' is for GIF's on/off pixels. No pixel may borrow a colour it does
 * not have, since the frame cannot know what it will sit on: the rim of solid
 * geometry shows its own surface colour, coverage divided out, wherever it
 * covers at least half the pixel; glow and translucent smoke keep their colour
 * as it would look on black and stay visible down to TURNTABLE_GLOW_CUTOFF.
 */
export class TurntableFrameResolver {
  private readonly width: number;
  private readonly height: number;
  private readonly filtered: THREE.WebGLRenderTarget;
  private readonly output: THREE.WebGLRenderTarget;
  private readonly held: THREE.WebGLRenderTarget[] = [];
  private readonly filter: THREE.ShaderMaterial;
  private readonly flatten: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor(width: number, height: number, factor: number, background: number | null, alpha: TurntableAlpha) {
    this.width = width;
    this.height = height;
    this.filtered = this.floatTarget();
    this.output = new THREE.WebGLRenderTarget(width, height, {
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    // three compiles ShaderMaterial as GLSL ES 3.00 under WebGL2, which is what
    // texelFetch needs; an explicit GLSL3 version would drop its gl_FragColor
    // output mapping.
    const pass = (fragmentShader: string, uniforms: Record<string, THREE.IUniform>) => new THREE.ShaderMaterial({
      uniforms,
      vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.filter = pass(FILTER_SHADER, { source: { value: null }, factor: { value: factor } });
    const linear = (channel: number) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const back = background ?? 0;
    this.flatten = pass(FLATTEN_SHADER, {
      filtered: { value: this.filtered.texture },
      held: { value: this.filtered.texture },
      blend: { value: 0 },
      mode: { value: background !== null ? 0 : alpha === 'full' ? 1 : 2 },
      background: { value: new THREE.Vector3(linear((back >> 16) & 0xff), linear((back >> 8) & 0xff), linear(back & 0xff)) },
      glowCutoff: { value: linear(Math.round(TURNTABLE_GLOW_CUTOFF * 255)) },
      outHeight: { value: height },
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.filter);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** Output-sized half-float target for filtered (premultiplied linear) frames. */
  private floatTarget() {
    return new THREE.WebGLRenderTarget(this.width, this.height, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
  }

  private draw(renderer: THREE.WebGLRenderer, material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget) {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  /** Filters `source` (a render `factor` times this size) into held slot `slot` for a later crossfade. */
  hold(renderer: THREE.WebGLRenderer, source: THREE.Texture, slot: number) {
    this.held[slot] ??= this.floatTarget();
    this.filter.uniforms.source.value = source;
    this.draw(renderer, this.filter, this.held[slot]);
  }

  /** Filters and flattens `source`, crossfading `blend.t` toward held `blend.slot`; returns top-down RGBA. */
  resolve(renderer: THREE.WebGLRenderer, source: THREE.Texture, blend?: { slot: number; t: number }): Uint8Array {
    this.filter.uniforms.source.value = source;
    this.draw(renderer, this.filter, this.filtered);
    this.flatten.uniforms.held.value = blend ? this.held[blend.slot].texture : this.filtered.texture;
    this.flatten.uniforms.blend.value = blend?.t ?? 0;
    this.draw(renderer, this.flatten, this.output);
    const rgba = new Uint8Array(this.width * this.height * 4);
    renderer.readRenderTargetPixels(this.output, 0, 0, this.width, this.height, rgba);
    return rgba;
  }

  dispose() {
    for (const target of [this.filtered, this.output, ...this.held]) target.dispose();
    this.filter.dispose();
    this.flatten.dispose();
    this.quad.geometry.dispose();
  }
}
