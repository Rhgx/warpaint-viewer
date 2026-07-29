// Main-thread ProtoDefSource: spawns protodefs.worker.ts to keep the decoded
// container (tens of megabytes for a stock file) off the main thread, and
// falls back to running decoder.ts in-process when Worker is unavailable or
// fails to start - same rationale as src/source/vtfDecode.ts.

import type { DecodedContainer } from './decoder';
import type {
  ProtoDefIndex, ProtoDefJsonFragment, ProtoDefKitMessages, ProtoDefOpenOptions, ProtoDefRecipe,
  ProtoDefSource,
} from './types';

type Team = 'red' | 'blu';

interface WorkerSuccess {
  id: number;
  ok: true;
  result: unknown;
}

interface WorkerFailure {
  id: number;
  ok: false;
  message: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

// What to replay against a fresh in-process fallback: either the last open()
// or the last openJsonFragments() call, whichever ran most recently.
type LastOpen =
  | { kind: 'bytes'; bytes: Uint8Array; options: ProtoDefOpenOptions }
  | { kind: 'json'; baseBytes: Uint8Array; fragments: ProtoDefJsonFragment[]; options: ProtoDefOpenOptions };

// In-process fallback: decoder.ts is a plain module, so without a Worker this
// just calls it directly and keeps the parsed container in this object instead.
class InProcessSource {
  private decoded: DecodedContainer | null = null;

  async open(bytes: Uint8Array, options: ProtoDefOpenOptions): Promise<ProtoDefIndex> {
    const { decodeProtoDefs } = await import('./decoder');
    this.decoded = decodeProtoDefs(bytes, options);
    return this.decoded.index;
  }

  async openJsonFragments(
    baseBytes: Uint8Array,
    fragments: ProtoDefJsonFragment[],
    options: ProtoDefOpenOptions,
  ): Promise<ProtoDefIndex> {
    const { decodeProtoDefsFromJson } = await import('./decoder');
    this.decoded = decodeProtoDefsFromJson(baseBytes, fragments, options);
    return this.decoded.index;
  }

  async resolveRecipe(defindex: number, weaponKey: string, team: Team, wearIndex: number): Promise<ProtoDefRecipe | null> {
    if (!this.decoded) return null;
    const { resolveKitRecipe } = await import('./decoder');
    return resolveKitRecipe(this.decoded, defindex, weaponKey, team, wearIndex);
  }

  async exportKit(defindex: number): Promise<ProtoDefKitMessages | null> {
    if (!this.decoded) return null;
    const { extractKitMessages } = await import('./decoder');
    return extractKitMessages(this.decoded, defindex);
  }

  dispose(): void {
    this.decoded = null;
  }
}

export class ProtoDefClient implements ProtoDefSource {
  private worker: Worker | null = null;
  private workerDisabled = false;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  // Cached so a worker that dies mid-session can be replaced by the in-process
  // fallback without losing the ability to keep resolving recipes.
  private lastOpen: LastOpen | null = null;
  private fallback: InProcessSource | null = null;

  private createWorker(): Worker | null {
    if (this.workerDisabled) return null;
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') { this.workerDisabled = true; return null; }
    try {
      const worker = new Worker(new URL('./protodefs.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerSuccess | WorkerFailure>) => {
        const message = event.data;
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.ok) request.resolve(message.result);
        else request.reject(new Error(message.message));
      };
      worker.onerror = () => this.disableWorkerAndFallBack();
      worker.onmessageerror = () => this.disableWorkerAndFallBack();
      this.worker = worker;
      return worker;
    } catch {
      this.workerDisabled = true;
      return null;
    }
  }

  private disableWorkerAndFallBack(): void {
    this.worker?.terminate();
    this.worker = null;
    this.workerDisabled = true;
    const pending = [...this.pending.values()];
    this.pending.clear();
    // Requests in flight when the worker died would otherwise hang forever;
    // fail them so callers can retry (open() will re-run through the fallback).
    for (const request of pending) request.reject(new Error('The proto_defs worker terminated unexpectedly.'));
  }

  private async ensureFallback(): Promise<InProcessSource> {
    if (this.fallback) return this.fallback;
    const source = new InProcessSource();
    if (this.lastOpen?.kind === 'bytes') await source.open(this.lastOpen.bytes, this.lastOpen.options);
    else if (this.lastOpen?.kind === 'json') await source.openJsonFragments(this.lastOpen.baseBytes, this.lastOpen.fragments, this.lastOpen.options);
    this.fallback = source;
    return source;
  }

  private post(message: Record<string, unknown>, transfer?: Transferable[]): Promise<unknown> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error('No worker available.'));
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, ...message }, transfer ?? []);
    });
  }

  async open(bytes: Uint8Array, options: ProtoDefOpenOptions): Promise<ProtoDefIndex> {
    this.lastOpen = { kind: 'bytes', bytes, options };
    const worker = this.createWorker();
    if (!worker) return (await this.ensureFallback()).open(bytes, options);
    try {
      // Keep the caller's bytes intact: if the browser cannot clone the
      // message the same request can still fall back to the in-process path.
      const transferable = bytes.slice().buffer;
      return (await this.post({ kind: 'open', bytes: transferable, options }, [transferable])) as ProtoDefIndex;
    } catch {
      return (await this.ensureFallback()).open(bytes, options);
    }
  }

  async openJsonFragments(
    baseBytes: Uint8Array,
    fragments: ProtoDefJsonFragment[],
    options: ProtoDefOpenOptions,
  ): Promise<ProtoDefIndex> {
    this.lastOpen = { kind: 'json', baseBytes, fragments, options };
    const worker = this.createWorker();
    if (!worker) return (await this.ensureFallback()).openJsonFragments(baseBytes, fragments, options);
    try {
      // Same rationale as open(): keep the caller's bytes intact so a failed
      // postMessage can still retry through the in-process fallback.
      const transferable = baseBytes.slice().buffer;
      return (await this.post({ kind: 'openJson', baseBytes: transferable, fragments, options }, [transferable])) as ProtoDefIndex;
    } catch {
      return (await this.ensureFallback()).openJsonFragments(baseBytes, fragments, options);
    }
  }

  async resolveRecipe(defindex: number, weaponKey: string, team: Team, wearIndex: number): Promise<ProtoDefRecipe | null> {
    if (this.fallback) return this.fallback.resolveRecipe(defindex, weaponKey, team, wearIndex);
    if (!this.worker) return (await this.ensureFallback()).resolveRecipe(defindex, weaponKey, team, wearIndex);
    try {
      return (await this.post({ kind: 'resolveRecipe', defindex, weaponKey, team, wearIndex })) as ProtoDefRecipe | null;
    } catch {
      return (await this.ensureFallback()).resolveRecipe(defindex, weaponKey, team, wearIndex);
    }
  }

  async exportKit(defindex: number): Promise<ProtoDefKitMessages | null> {
    if (this.fallback) return this.fallback.exportKit(defindex);
    if (!this.worker) return (await this.ensureFallback()).exportKit(defindex);
    try {
      return (await this.post({ kind: 'exportKit', defindex })) as ProtoDefKitMessages | null;
    } catch {
      return (await this.ensureFallback()).exportKit(defindex);
    }
  }

  dispose(): void {
    if (this.worker) {
      // Best-effort: let the worker drop its references before terminating,
      // but don't wait on it, dispose() is synchronous.
      void this.post({ kind: 'dispose' }).catch(() => undefined);
      this.worker.terminate();
      this.worker = null;
    }
    this.pending.clear();
    this.fallback?.dispose();
    this.fallback = null;
    this.lastOpen = null;
  }
}

export function createProtoDefSource(): ProtoDefSource {
  return new ProtoDefClient();
}
