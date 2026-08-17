import { encodeRgbaPng } from '../source/png';
export { revokeTextureUrl } from './assetUrls';

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_VTF_PIXELS = 16 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'tga', 'vtf'];

interface TgaWorkerSuccess {
  id: number;
  ok: true;
  kind: 'decode-tga';
  png: ArrayBuffer;
  width: number;
  height: number;
}

interface MergeWorkerSuccess {
  id: number;
  ok: true;
  kind: 'merge-alpha';
  png: ArrayBuffer;
  width: number;
  height: number;
}

interface WorkerFailure {
  id: number;
  ok: false;
  code?: string;
  message: string;
}

type ProcessingResult = TgaWorkerSuccess | MergeWorkerSuccess | WorkerFailure;

interface PendingProcessing {
  fallback: () => Promise<ArrayBuffer>;
  resolve: (value: ArrayBuffer) => void;
  reject: (reason?: unknown) => void;
}

let processingWorker: Worker | null = null;
let processingWorkerDisabled = false;
let nextProcessingId = 1;
const pendingProcessing = new Map<number, PendingProcessing>();

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function createObjectUrl(blob: Blob): string | null {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
    ? URL.createObjectURL(blob)
    : null;
}

async function sourceFromBlob(blob: Blob): Promise<string> {
  return createObjectUrl(blob) ?? readAsDataUrl(blob);
}

async function sourceFromPng(png: ArrayBuffer): Promise<string> {
  return sourceFromBlob(new Blob([png], { type: 'image/png' }));
}

export function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onerror = () => reject(new Error('The image could not be decoded.'));
    image.onload = () => resolve(image);
    image.src = source;
  });
}

async function decodeTgaOnMainThread(file: File): Promise<ArrayBuffer> {
  const { TGALoader } = await import('three/addons/loaders/TGALoader.js');
  const parsed = new TGALoader().parse(await file.arrayBuffer());
  if (!parsed.data || !parsed.width || !parsed.height) {
    throw new Error('This TGA has no readable pixel data.');
  }
  return encodeRgbaPng(
    Uint8Array.from(parsed.data as ArrayLike<number>),
    parsed.width,
    parsed.height,
  );
}

async function mergeAlphaOnMainThread(colorUrl: string, alphaUrl: string): Promise<ArrayBuffer> {
  const [color, alpha] = await Promise.all([
    loadImage(colorUrl),
    loadImage(alphaUrl),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = color.naturalWidth;
  canvas.height = color.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('The browser could not merge the alpha mask.');
  context.drawImage(color, 0, 0);
  const colorPixels = context.getImageData(0, 0, canvas.width, canvas.height);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(alpha, 0, 0, canvas.width, canvas.height);
  const maskPixels = context.getImageData(0, 0, canvas.width, canvas.height);
  let hasTransparency = false;
  for (let index = 3; index < maskPixels.data.length; index += 4) {
    if (maskPixels.data[index] < 255) {
      hasTransparency = true;
      break;
    }
  }
  for (let index = 0; index < colorPixels.data.length; index += 4) {
    colorPixels.data[index + 3] = hasTransparency
      ? maskPixels.data[index + 3]
      : Math.round(
          maskPixels.data[index] * 0.299
            + maskPixels.data[index + 1] * 0.587
            + maskPixels.data[index + 2] * 0.114,
        );
  }
  context.putImageData(colorPixels, 0, 0);
  return encodeRgbaPng(
    new Uint8Array(colorPixels.data.buffer, colorPixels.data.byteOffset, colorPixels.data.byteLength),
    canvas.width,
    canvas.height,
  );
}

function disableProcessingWorker(): void {
  processingWorker?.terminate();
  processingWorker = null;
  processingWorkerDisabled = true;
  const pending = [...pendingProcessing.entries()];
  pendingProcessing.clear();
  for (const [, request] of pending) void request.fallback().then(request.resolve, request.reject);
}

function createProcessingWorker(): Worker | null {
  if (processingWorkerDisabled) return null;
  if (processingWorker) return processingWorker;
  if (typeof Worker === 'undefined') {
    processingWorkerDisabled = true;
    return null;
  }
  try {
    processingWorker = new Worker(new URL('./textureProcessing.worker.ts', import.meta.url), { type: 'module' });
    processingWorker.onmessage = (event: MessageEvent<ProcessingResult>) => {
      const result = event.data;
      const request = pendingProcessing.get(result.id);
      if (!request) return;
      pendingProcessing.delete(result.id);
      if (result.ok) request.resolve(result.png);
      else if (result.code === 'unsupported') void request.fallback().then(request.resolve, request.reject);
      else request.reject(new Error(result.message));
    };
    processingWorker.onerror = disableProcessingWorker;
    processingWorker.onmessageerror = disableProcessingWorker;
    return processingWorker;
  } catch {
    processingWorkerDisabled = true;
    return null;
  }
}

function processInWorker(
  message: Record<string, unknown>,
  transfer: Transferable[],
  fallback: () => Promise<ArrayBuffer>,
): Promise<ArrayBuffer> {
  const worker = createProcessingWorker();
  if (!worker) return fallback();
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const id = nextProcessingId++;
    pendingProcessing.set(id, { fallback, resolve, reject });
    try {
      worker.postMessage({ ...message, id }, transfer);
    } catch {
      pendingProcessing.delete(id);
      void fallback().then(resolve, reject);
    }
  });
}

async function decodeTga(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const png = await processInWorker(
    { kind: 'decode-tga', bytes },
    [bytes],
    () => decodeTgaOnMainThread(file),
  );
  return sourceFromPng(png);
}

async function decodeVtf(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { decodeVtfToPng, VtfDecodeError } = await import('../source/vtfDecode');
  try {
    const decoded = await decodeVtfToPng(bytes, {
      maxPixels: MAX_VTF_PIXELS,
      limitDescription: '16 megapixel import limit',
    });
    return sourceFromPng(decoded.png);
  } catch (cause) {
    const detail =
      cause instanceof Error
        ? cause.message
        : 'The image data could not be decoded.';
    const header = cause instanceof VtfDecodeError ? cause.header : undefined;
    if (detail.startsWith('VTF dimensions '))
      throw new Error(`${file.name}: ${detail}`);
    throw new Error(
      header
        ? `${file.name}: VTF ${header.verMajor}.${header.verMinor}, format ${header.highResFormat}: ${detail}`
        : `${file.name}: ${detail}`,
    );
  }
}

export async function readTexture(file: File, alphaOnly = false) {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (
    !SUPPORTED_EXTENSIONS.includes(extension) ||
    (alphaOnly && extension === 'tga')
  ) {
    throw new Error(
      alphaOnly
        ? 'Choose a PNG, JPG, or WebP alpha mask.'
        : 'Choose a PNG, JPG, WebP, TGA, or VTF texture.',
    );
  }
  if (alphaOnly && extension === 'vtf')
    throw new Error(
      'VTF textures contain their own alpha channel and cannot be used as a separate alpha mask.',
    );
  if (file.size > MAX_FILE_BYTES)
    throw new Error('Files must be 32 MB or smaller.');
  return {
    dataUrl:
      extension === 'tga'
        ? await decodeTga(file)
        : extension === 'vtf'
          ? await decodeVtf(file)
          : await sourceFromBlob(file),
    fileName: file.name,
    isTga: extension === 'tga',
    hasEmbeddedAlpha: extension === 'tga' || extension === 'vtf',
  };
}

export async function mergeAlpha(
  colorUrl: string,
  alphaUrl: string,
): Promise<string> {
  let color: Blob;
  let alpha: Blob;
  try {
    [color, alpha] = await Promise.all([
      fetch(colorUrl).then((response) => {
        if (!response.ok) throw new Error('The color texture could not be read.');
        return response.blob();
      }),
      fetch(alphaUrl).then((response) => {
        if (!response.ok) throw new Error('The alpha mask could not be read.');
        return response.blob();
      }),
    ]);
  } catch {
    return sourceFromPng(await mergeAlphaOnMainThread(colorUrl, alphaUrl));
  }
  const png = await processInWorker(
    { kind: 'merge-alpha', color, alpha },
    [],
    () => mergeAlphaOnMainThread(colorUrl, alphaUrl),
  );
  return sourceFromPng(png);
}
