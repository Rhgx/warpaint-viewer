/**
 * Exact RGBA readback for the export builder.
 *
 * Every obvious way to get pixels out of an image in a browser goes through a
 * 2D canvas, whose backing store is premultiplied. That destroys RGB wherever
 * alpha is 0, and in a TF2 paint texture RGB and alpha are two independent data
 * channels: a pattern carries its wear mask in alpha, a sticker carries its
 * spec there. src/source/png.ts already documents the same trap on the write
 * side, and the WebP pipeline hit it once too (lossless without `exact` drops
 * the same pixels).
 *
 * So decoding runs through WebGL instead: an unpremultiplied ImageBitmap into a
 * texture, one passthrough draw into a byte framebuffer, and readPixels. The
 * whole app is a WebGL renderer, so requiring a context here costs nothing.
 */

import { encodeRgbaPng } from '../source/png';

export interface DecodedImage {
  width: number;
  height: number;
  /** Unpremultiplied RGBA, 4 bytes per pixel, first row is the top of the image. */
  pixels: Uint8Array;
}

const VERTEX_SHADER = `#version 300 es
in vec2 a_position;
out vec2 v_uv;
void main() {
  v_uv = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_image;
in vec2 v_uv;
out vec4 fragColor;
void main() {
  fragColor = texture(u_image, v_uv);
}`;

interface ReadbackContext {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  /**
   * Whether readPixels comes back in the opposite row order to the source
   * image. GL's framebuffer origin is bottom left while an ImageBitmap's is top
   * left, and which way that lands depends on the unpack settings and the draw.
   * Rather than reason about it, the context probes itself once at startup with
   * a two-pixel image whose rows are known, and trusts the answer.
   */
  flipRows: boolean;
}

let contextPromise: Promise<ReadbackContext> | null = null;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('The browser could not create a shader for texture export.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown error';
    gl.deleteShader(shader);
    throw new Error(`Texture export shader failed to compile: ${log}`);
  }
  return shader;
}

function createContext(): ReadbackContext {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) throw new Error('Exporting textures needs WebGL 2, which this browser did not provide.');

  const program = gl.createProgram();
  if (!program) throw new Error('The browser could not create a program for texture export.');
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown error';
    throw new Error(`Texture export program failed to link: ${log}`);
  }
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  // One triangle covering clip space, so there is no seam down the diagonal of
  // a quad and no vertex buffer larger than it needs to be.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_position');
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.SCISSOR_TEST);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  return { gl, program, flipRows: false };
}

function readBitmap(context: ReadbackContext, bitmap: ImageBitmap): DecodedImage {
  const { gl, program } = context;
  const { width, height } = bitmap;
  const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
  if (width > maxSize || height > maxSize) {
    throw new Error(`This image is ${width} x ${height}, past the ${maxSize} pixel limit this browser can read back.`);
  }

  const texture = gl.createTexture();
  const target = gl.createTexture();
  const framebuffer = gl.createFramebuffer();
  try {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // NEAREST with a 1:1 draw means every output pixel is exactly one texel,
    // never a filtered blend of two.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);

    gl.bindTexture(gl.TEXTURE_2D, target);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error('The browser could not allocate a readback target for this texture.');
    }

    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(program, 'u_image'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return { width, height, pixels: context.flipRows ? flipRows(pixels, width, height) : pixels };
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    gl.deleteTexture(target);
  }
}

function flipRows(pixels: Uint8Array, width: number, height: number): Uint8Array {
  const stride = width * 4;
  const flipped = new Uint8Array(pixels.length);
  for (let y = 0; y < height; y += 1) {
    flipped.set(pixels.subarray(y * stride, (y + 1) * stride), (height - 1 - y) * stride);
  }
  return flipped;
}

async function toBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
}

/**
 * Renders a two-pixel image whose rows differ and checks which one comes back
 * first, so the row order is measured rather than assumed.
 */
async function probeRowOrder(context: ReadbackContext): Promise<boolean> {
  const top = [255, 0, 0, 255];
  const bottom = [0, 0, 255, 255];
  const png = await encodeRgbaPng(Uint8Array.from([...top, ...bottom]), 1, 2);
  const bitmap = await toBitmap(new Blob([png], { type: 'image/png' }));
  try {
    const read = readBitmap(context, bitmap);
    // Red first means the first row read back is the top of the image already.
    return read.pixels[0] !== 255;
  } finally {
    bitmap.close();
  }
}

async function getContext(): Promise<ReadbackContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const context = createContext();
      context.flipRows = await probeRowOrder(context);
      return context;
    })().catch((cause: unknown) => {
      // A failed probe must not poison every later export with a cached
      // rejection: the next call gets a fresh attempt.
      contextPromise = null;
      throw cause;
    });
  }
  return contextPromise;
}

/**
 * Decodes an image to unpremultiplied top-down RGBA. Accepts a Blob or any URL
 * the browser can fetch, including the data: URLs the file workbench holds.
 */
export async function decodeImageExact(source: Blob | string): Promise<DecodedImage> {
  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source;
  const context = await getContext();
  const bitmap = await toBitmap(blob);
  try {
    return readBitmap(context, bitmap);
  } finally {
    bitmap.close();
  }
}
