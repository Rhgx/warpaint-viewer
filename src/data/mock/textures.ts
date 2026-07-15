// Procedurally generated placeholder textures, produced at runtime as PNG data:
// URLs so the compositor's TextureLoader can consume them like any other path.
// These stand in for real materials/patterns/**.png when no pipeline data exists.

function makeCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('2d canvas context unavailable');
  return [c, ctx];
}

function checkerboard(size: number, cells: number, a: string, b: string): string {
  const [c, ctx] = makeCanvas(size);
  const step = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? a : b;
      ctx.fillRect(x * step, y * step, step, step);
    }
  }
  return c.toDataURL('image/png');
}

function noise(size: number, tint: [number, number, number]): string {
  const [c, ctx] = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  for (let i = 0; i < size * size; i++) {
    const n = Math.random();
    img.data[i * 4 + 0] = Math.min(255, tint[0] * n + 30);
    img.data[i * 4 + 1] = Math.min(255, tint[1] * n + 30);
    img.data[i * 4 + 2] = Math.min(255, tint[2] * n + 30);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function stripes(size: number, a: string, b: string, count: number): string {
  const [c, ctx] = makeCanvas(size);
  const w = size / count;
  for (let i = 0; i < count; i++) {
    ctx.fillStyle = i % 2 === 0 ? a : b;
    ctx.fillRect(i * w, 0, w, size);
  }
  return c.toDataURL('image/png');
}

// Region-index map for the select stage: byte value V => region round(V/16).
// Left half byte 16 (region 1), right half byte 32 (region 2).
function groups(size: number): string {
  const [c, ctx] = makeCanvas(size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = x < size / 2 ? 16 : 32;
      const i = (y * size + x) * 4;
      img.data[i] = v;
      img.data[i + 1] = v;
      img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

const S = 256;

// Built lazily so nothing touches the DOM until the app actually asks for mock
// data (keeps module import safe under SSR / test import).
let cache: Record<string, string> | null = null;

export function mockTextures(): Record<string, string> {
  if (cache) return cache;
  cache = {
    'mock/checker': checkerboard(S, 8, '#c8c8c8', '#404040'),
    'mock/hazard': stripes(S, '#e0b000', '#202020', 10),
    'mock/camo': noise(S, [90, 110, 70]),
    'mock/rust': noise(S, [150, 80, 50]),
    'mock/groups': groups(S),
    'mock/sticker': checkerboard(S, 4, '#ff2020', '#ffffff'),
  };
  return cache;
}
