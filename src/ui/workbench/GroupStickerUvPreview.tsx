import { useEffect, useLayoutEffect, useRef } from 'react';
import type { StickerAffineQuad } from '../../editor/stickerGeometry';

export interface GroupStickerPreviewSources {
  readonly maskSrc: string;
  readonly selectorBaseSrc: string;
  readonly endpointZeroSrc: string;
  readonly endpointOneSrc: string;
  readonly levels: readonly [number, number, number];
}

interface PreviewRuntime {
  draw(quad: StickerAffineQuad): void;
  dispose(): void;
}

const VERTEX_SHADER = `
  attribute vec2 aPosition;
  varying vec2 vLocalUv;

  void main() {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    vLocalUv = vec2((aPosition.x + 1.0) * 0.5, (1.0 - aPosition.y) * 0.5);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;

  uniform sampler2D uMask;
  uniform sampler2D uSelectorBase;
  uniform sampler2D uEndpointZero;
  uniform sampler2D uEndpointOne;
  uniform vec3 uLevels;
  uniform vec2 uDestTl;
  uniform vec2 uDestTr;
  uniform vec2 uDestBl;
  varying vec2 vLocalUv;

  vec3 srgbToLinear(vec3 value) {
    vec3 low = value / 12.92;
    vec3 high = pow((value + 0.055) / 1.055, vec3(2.4));
    return mix(low, high, step(vec3(0.04045), value));
  }

  vec3 linearToSrgb(vec3 value) {
    vec3 low = value * 12.92;
    vec3 high = 1.055 * pow(max(value, 0.0), vec3(1.0 / 2.4)) - 0.055;
    return mix(low, high, step(vec3(0.0031308), value));
  }

  vec4 adjustMask(vec4 source) {
    float black = uLevels.x;
    float white = uLevels.y;
    float gamma = uLevels.z;
    vec4 normalized;
    if (white == black) {
      normalized = vec4(greaterThan(source, vec4(black)));
    } else {
      normalized = clamp((source - black) / (white - black), 0.0, 1.0);
    }
    return pow(normalized, vec4(gamma));
  }

  void main() {
    vec4 mask = adjustMask(texture2D(uMask, vLocalUv));
    if (mask.a <= 0.001) {
      gl_FragColor = vec4(0.0);
      return;
    }

    vec2 destinationUv = uDestTl
      + (uDestTr - uDestTl) * vLocalUv.x
      + (uDestBl - uDestTl) * vLocalUv.y;
    destinationUv = fract(destinationUv);
    float selectorBase = srgbToLinear(texture2D(uSelectorBase, destinationUv).rgb).r;
    float selector = mix(selectorBase, mask.r, mask.a);
    vec3 endpointZero = srgbToLinear(texture2D(uEndpointZero, destinationUv).rgb);
    vec3 endpointOne = srgbToLinear(texture2D(uEndpointOne, destinationUv).rgb);
    vec3 desired = mix(endpointZero, endpointOne, selector);
    gl_FragColor = vec4(linearToSrgb(clamp(desired, 0.0, 1.0)), 1.0);
  }
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('The browser could not create the group sticker preview shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const message = gl.getShaderInfoLog(shader) ?? 'The group sticker preview shader did not compile.';
  gl.deleteShader(shader);
  throw new Error(message);
}

function loadImage(source: string, signal: AbortSignal): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    const abort = () => {
      image.onload = null;
      image.onerror = null;
      image.src = '';
      reject(new DOMException('Image loading was cancelled.', 'AbortError'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    image.onload = () => {
      signal.removeEventListener('abort', abort);
      resolve(image);
    };
    image.onerror = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('A group sticker preview texture could not be loaded.'));
    };
    image.src = source;
  });
}

function createTexture(gl: WebGLRenderingContext, image: HTMLImageElement): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('The browser could not create a group sticker preview texture.');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  return texture;
}

async function createRuntime(
  canvas: HTMLCanvasElement,
  sources: GroupStickerPreviewSources,
  signal: AbortSignal,
): Promise<PreviewRuntime> {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: false,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('WebGL is unavailable for the group sticker preview.');

  const [mask, selectorBase, endpointZero, endpointOne] = await Promise.all([
    loadImage(sources.maskSrc, signal),
    loadImage(sources.selectorBaseSrc, signal),
    loadImage(sources.endpointZeroSrc, signal),
    loadImage(sources.endpointOneSrc, signal),
  ]);
  if (signal.aborted) throw new DOMException('Preview creation was cancelled.', 'AbortError');

  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  const program = gl.createProgram();
  if (!program) throw new Error('The browser could not create the group sticker preview program.');
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) ?? 'The group sticker preview program did not link.';
    gl.deleteProgram(program);
    throw new Error(message);
  }

  const buffer = gl.createBuffer();
  if (!buffer) {
    gl.deleteProgram(program);
    throw new Error('The browser could not create the group sticker preview geometry.');
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1, 1, -1, -1, 1,
    -1, 1, 1, -1, 1, 1,
  ]), gl.STATIC_DRAW);

  const textures = [mask, selectorBase, endpointZero, endpointOne].map((image) => createTexture(gl, image));
  gl.useProgram(program);
  const position = gl.getAttribLocation(program, 'aPosition');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const samplers = ['uMask', 'uSelectorBase', 'uEndpointZero', 'uEndpointOne'];
  samplers.forEach((name, index) => {
    gl.activeTexture(gl.TEXTURE0 + index);
    gl.bindTexture(gl.TEXTURE_2D, textures[index]);
    gl.uniform1i(gl.getUniformLocation(program, name), index);
  });
  gl.uniform3fv(gl.getUniformLocation(program, 'uLevels'), sources.levels);
  gl.disable(gl.BLEND);

  const destinationUniforms = {
    tl: gl.getUniformLocation(program, 'uDestTl'),
    tr: gl.getUniformLocation(program, 'uDestTr'),
    bl: gl.getUniformLocation(program, 'uDestBl'),
  };

  return {
    draw(quad) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program);
      gl.uniform2fv(destinationUniforms.tl, quad.tl);
      gl.uniform2fv(destinationUniforms.tr, quad.tr);
      gl.uniform2fv(destinationUniforms.bl, quad.bl);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
    dispose() {
      for (const texture of textures) gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}

export function GroupStickerUvPreview({
  sources,
  quad,
}: {
  readonly sources: GroupStickerPreviewSources;
  readonly quad: StickerAffineQuad;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<PreviewRuntime | null>(null);
  const quadRef = useRef(quad);
  quadRef.current = quad;
  const { maskSrc, selectorBaseSrc, endpointZeroSrc, endpointOneSrc, levels } = sources;
  const [black, white, gamma] = levels;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const controller = new AbortController();
    runtimeRef.current?.dispose();
    runtimeRef.current = null;
    void createRuntime(canvas, {
      maskSrc,
      selectorBaseSrc,
      endpointZeroSrc,
      endpointOneSrc,
      levels: [black, white, gamma],
    }, controller.signal).then((runtime) => {
      if (controller.signal.aborted) {
        runtime.dispose();
        return;
      }
      runtimeRef.current = runtime;
      runtime.draw(quadRef.current);
    }).catch(() => {
      // The editor remains usable through its handles and exact values if a
      // browser cannot create this optional live visual.
    });
    return () => {
      controller.abort();
      runtimeRef.current?.dispose();
      runtimeRef.current = null;
    };
  }, [black, endpointOneSrc, endpointZeroSrc, gamma, maskSrc, selectorBaseSrc, white]);

  useLayoutEffect(() => {
    runtimeRef.current?.draw(quad);
  }, [quad]);

  return <canvas ref={canvasRef} width={1024} height={1024} aria-hidden="true" />;
}
