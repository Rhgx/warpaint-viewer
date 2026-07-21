import type { TextureMetadata } from '../data/types';
import { encodeRgbaPng } from './png';

export interface VtfHeaderDetails {
  verMajor: number;
  verMinor: number;
  width: number;
  height: number;
  highResFormat: number;
  sampling: Partial<TextureMetadata>;
}

export interface DecodedVtfPng {
  png: ArrayBuffer;
  width: number;
  height: number;
  header: VtfHeaderDetails;
}

export interface DecodeVtfOptions {
  maxPixels?: number;
  limitDescription?: string;
}

export class VtfDecodeError extends Error {
  readonly header: VtfHeaderDetails | undefined;

  constructor(message: string, header?: VtfHeaderDetails) {
    super(message);
    this.name = 'VtfDecodeError';
    this.header = header;
  }
}

interface WorkerSuccess {
  id: number;
  ok: true;
  png: ArrayBuffer;
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

const DEFAULT_OPTIONS: Required<DecodeVtfOptions> = {
  maxPixels: 16 * 1024 * 1024,
  limitDescription: '16 megapixel limit',
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
  // This is deliberately dynamic: unsupported browsers and test environments
  // retain the old behavior without pulling the decoder into the shell.
  const { decodeVTF, parseVTFHeader } = await import('../../tools/lib/vtf-core.mjs');
  let header: VtfHeaderDetails | undefined;
  try {
    header = parseVTFHeader(bytes) as VtfHeaderDetails;
    const pixels = header.width * header.height;
    if (!Number.isSafeInteger(pixels) || pixels > options.maxPixels) {
      throw new Error(`VTF dimensions ${header.width} x ${header.height} exceed the ${options.limitDescription}.`);
    }
    const decoded = decodeVTF(bytes);
    return { png: await encodeRgbaPng(decoded.rgba, decoded.width, decoded.height), width: decoded.width, height: decoded.height, header };
  } catch (cause) {
    if (cause instanceof VtfDecodeError) throw cause;
    throw decodeFailure(cause instanceof Error ? cause.message : 'The image data could not be decoded.', header);
  }
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
      if (result.ok) decode.resolve({ png: result.png, width: result.width, height: result.height, header: result.header });
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
      // Keep the caller's bytes intact: if a browser terminates the worker or
      // cannot clone a message, the same request can safely use the fallback.
      const transferable = bytes.slice().buffer;
      decoder.postMessage({ id, bytes: transferable, ...resolvedOptions }, [transferable]);
    } catch {
      const decode = pending.get(id);
      pending.delete(id);
      if (decode) void decodeOnMainThread(decode.bytes, decode.options).then(resolve, reject);
    }
  });
}
