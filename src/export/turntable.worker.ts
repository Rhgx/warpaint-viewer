/// <reference lib="webworker" />

import { ApngEncoder, Mp4Encoder, type AnimationEncoder } from './animated';
import { buildPalette, GifEncoder } from './gif';
import type { TurntableFormat, TurntableQuality } from '../viewer/controls';

export type { TurntableFormat };

// Streaming protocol: `start` picks the encoder (GIF fits its palette to the
// sample frames), each `frame` is encoded on arrival and acknowledged (the
// sender throttles on acks), `finish` returns the file.
export type TurntableWorkerRequest =
  | {
    type: 'start';
    /** WebP encodes on the page instead (see createWebpSession). */
    format: Exclude<TurntableFormat, 'webp'>;
    width: number;
    height: number;
    fps: number;
    quality: TurntableQuality;
    samples: Uint8Array[];
  }
  | { type: 'frame'; rgba: Uint8Array }
  | { type: 'finish' };

export type TurntableWorkerResponse =
  | { type: 'ack' }
  | { type: 'done'; bytes: Uint8Array<ArrayBuffer> }
  | { type: 'error'; message: string };

async function createEncoder(request: Extract<TurntableWorkerRequest, { type: 'start' }>): Promise<AnimationEncoder> {
  const { width, height, fps, quality } = request;
  switch (request.format) {
    case 'gif': return new GifEncoder(width, height, Math.round(100 / fps), buildPalette(request.samples));
    case 'apng': return new ApngEncoder(width, height, fps);
    case 'mp4': return Mp4Encoder.create(width, height, fps, quality);
  }
}

let encoder: Promise<AnimationEncoder> | null = null;
// Requests run strictly in order even though some encoders are asynchronous.
let queue: Promise<void> = Promise.resolve();

const reply = (message: TurntableWorkerResponse, transfer: Transferable[] = []) => self.postMessage(message, transfer);

async function handle(request: TurntableWorkerRequest) {
  if (request.type === 'start') {
    encoder = createEncoder(request);
    await encoder;
    return;
  }
  if (!encoder) throw new Error('Turntable encoder not started');
  if (request.type === 'frame') {
    await (await encoder).addFrame(request.rgba);
    reply({ type: 'ack' });
    return;
  }
  const bytes = await (await encoder).finish() as Uint8Array<ArrayBuffer>;
  encoder = null;
  reply({ type: 'done', bytes }, [bytes.buffer]);
}

self.onmessage = (event: MessageEvent<TurntableWorkerRequest>) => {
  queue = queue
    .then(() => handle(event.data))
    .catch((cause: unknown) => reply({ type: 'error', message: cause instanceof Error ? cause.message : String(cause) }));
};
