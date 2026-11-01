import { encodeRgbaPng } from './png';
import { decodeVtfToPngPair, VtfDecodeError } from './vtfDecodeCore';
import type { DecodedVtfPng, VtfHeaderDetails } from './vtfDecodeCore';

export { VtfDecodeError };
export type { DecodedVtfPng };

export interface DecodeVtfOptions {
  maxPixels?: number;
  limitDescription?: string;
}

interface WorkerSuccess {
  id: number;
  ok: true;
  png: ArrayBuffer;
  thumbnailPng: ArrayBuffer;
  width: number;
  height: number;
  header: VtfHeaderDetails;
}

interface WorkerFailure {
  id: number;
  ok: false;
  message: string;
  header?: VtfHeaderDetails;
}

interface PendingDecode {
  bytes: Uint8Array;
  options: Required<DecodeVtfOptions>;
  resolve: (value: DecodedVtfPng) => void;
  reject: (reason?: unknown) => void;
}

/** Largest decoded image or cubemap face set, in pixels. Shared by every source decode path. */
const MAX_DECODED_PIXELS = 16 * 1024 * 1024;
/** The same limit as it appears in error messages. */
const MAX_DECODED_PIXELS_LABEL = `${MAX_DECODED_PIXELS / (1024 * 1024)} megapixel limit`;

const DEFAULT_OPTIONS: Required<DecodeVtfOptions> = {
  maxPixels: MAX_DECODED_PIXELS,
  limitDescription: MAX_DECODED_PIXELS_LABEL,
};

let worker: Worker | null = null;
let workerDisabled = false;
let nextRequestId = 1;
const pending = new Map<number, PendingDecode>();

function normalizedOptions(options: DecodeVtfOptions | undefined): Required<DecodeVtfOptions> {
  return { ...DEFAULT_OPTIONS, ...options };
}

function asHeader(header: unknown): VtfHeaderDetails | undefined {
  if (!header || typeof header !== 'object') return undefined;
  const value = header as Partial<VtfHeaderDetails>;
  return typeof value.width === 'number' && typeof value.height === 'number'
    && typeof value.verMajor === 'number' && typeof value.verMinor === 'number' && typeof value.highResFormat === 'number'
    ? value as VtfHeaderDetails
    : undefined;
}

function decodeFailure(message: string, header?: VtfHeaderDetails): VtfDecodeError {
  return new VtfDecodeError(message, header);
}

async function decodeOnMainThread(bytes: Uint8Array, options: Required<DecodeVtfOptions>): Promise<DecodedVtfPng> {
  // Dynamic import keeps the decoder out of the main bundle; browsers without Worker land here.
  const codec = await import('../../tools/lib/vtf-core.mjs');
  return decodeVtfToPngPair(codec, bytes, options);
}

function fallBackPending(decodes: Iterable<PendingDecode>): void {
  for (const decode of decodes) {
    void decodeOnMainThread(decode.bytes, decode.options).then(decode.resolve, decode.reject);
  }
}

function disableWorkerAndFallBack(): void {
  worker?.terminate();
  worker = null;
  workerDisabled = true;
  const decodes = [...pending.values()];
  pending.clear();
  fallBackPending(decodes);
}

function createWorker(): Worker | null {
  if (workerDisabled) return null;
  if (worker) return worker;
  if (typeof Worker === 'undefined') { workerDisabled = true; return null; }
  try {
    worker = new Worker(new URL('./vtfDecode.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerSuccess | WorkerFailure>) => {
      const result = event.data;
      const decode = pending.get(result.id);
      if (!decode) return;
      pending.delete(result.id);
      if (result.ok) decode.resolve({
        png: result.png,
        thumbnailPng: result.thumbnailPng,
        width: result.width,
        height: result.height,
        header: result.header,
      });
      else decode.reject(decodeFailure(result.message, asHeader(result.header)));
    };
    worker.onerror = () => disableWorkerAndFallBack();
    worker.onmessageerror = () => disableWorkerAndFallBack();
    return worker;
  } catch {
    workerDisabled = true;
    return null;
  }
}

/** Decode and losslessly PNG-encode an imported VTF away from the UI thread. */
export async function decodeVtfToPng(bytes: Uint8Array, options?: DecodeVtfOptions): Promise<DecodedVtfPng> {
  const resolvedOptions = normalizedOptions(options);
  const decoder = createWorker();
  if (!decoder) return decodeOnMainThread(bytes, resolvedOptions);
  return new Promise<DecodedVtfPng>((resolve, reject) => {
    const id = nextRequestId++;
    pending.set(id, { bytes, options: resolvedOptions, resolve, reject });
    try {
      // Copy so the bytes survive a worker failure for the fallback to use.
      const transferable = bytes.slice().buffer;
      decoder.postMessage({ id, bytes: transferable, ...resolvedOptions }, [transferable]);
    } catch {
      const decode = pending.get(id);
      pending.delete(id);
      if (decode) void decodeOnMainThread(decode.bytes, decode.options).then(resolve, reject);
    }
  });
}

/** Decode the six largest-mip VTF cubemap faces in Three.js CubeTexture order. */
export async function decodeVtfCubemapToPng(bytes: Uint8Array): Promise<ArrayBuffer[]> {
  const { decodeVTFCubemap, parseVTFHeader } = await import('../../tools/lib/vtf-core.mjs');
  const header = parseVTFHeader(bytes) as VtfHeaderDetails & { faces: number };
  const pixels = header.width * header.height * 6;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_DECODED_PIXELS) {
    throw new VtfDecodeError(`VTF cubemap exceeds the ${MAX_DECODED_PIXELS_LABEL}.`, header);
  }
  return Promise.all(decodeVTFCubemap(bytes).map((face) => encodeRgbaPng(face.rgba, face.width, face.height)));
}
