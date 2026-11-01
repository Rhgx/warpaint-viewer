// Main-thread ProtoDefSource. Decoding runs in protodefs.worker.ts to keep the container
// off the main thread; decoder.ts runs in-process when Workers are unavailable or fail.

import type { DecodedContainer } from './decoderShared';
import type { Team } from '../data/types';
import type {
  ProtoDefIndex, ProtoDefJsonFragment, ProtoDefKitBundle, ProtoDefKitMessages, ProtoDefKitWeaponSlot, ProtoDefOpenOptions,
  ProtoDefRecipe, ProtoDefRecipeWithProvenance, ProtoDefSource,
} from './types';

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

  // The last open call, replayed into a fresh in-process fallback if the worker dies.
type LastOpen =
  | { kind: 'bytes'; bytes: Uint8Array; options: ProtoDefOpenOptions }
  | { kind: 'json'; baseBytes: Uint8Array; fragments: ProtoDefJsonFragment[]; options: ProtoDefOpenOptions };

  // In-process fallback: calls decoder.ts directly and holds the parsed container itself.
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
    const { resolveKitRecipe } = await import('./kitQueries');
    return resolveKitRecipe(this.decoded, defindex, weaponKey, team, wearIndex);
  }

  async resolveRecipeWithProvenance(
    defindex: number,
    weaponKey: string,
    team: Team,
    wearIndex: number,
  ): Promise<ProtoDefRecipeWithProvenance | null> {
    if (!this.decoded) return null;
    const { resolveKitRecipeWithProvenance } = await import('./kitQueries');
    return resolveKitRecipeWithProvenance(this.decoded, defindex, weaponKey, team, wearIndex);
  }

  async exportKit(defindex: number): Promise<ProtoDefKitMessages | null> {
    if (!this.decoded) return null;
    const { extractKitMessages } = await import('./kitQueries');
    return extractKitMessages(this.decoded, defindex);
  }

  async exportKitBundle(defindex: number): Promise<ProtoDefKitBundle | null> {
    if (!this.decoded) return null;
    const { extractKitBundle } = await import('./kitQueries');
    return extractKitBundle(this.decoded, defindex);
  }

  async exportKitWeaponSlots(defindex: number): Promise<ProtoDefKitWeaponSlot[] | null> {
    if (!this.decoded) return null;
    const { getKitWeaponSlots } = await import('./kitQueries');
    return getKitWeaponSlots(this.decoded, defindex);
  }

  dispose(): void {
    this.decoded = null;
  }
}

class ProtoDefClient implements ProtoDefSource {
  private worker: Worker | null = null;
  private workerDisabled = false;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  // Cached so a dead worker can be swapped for the in-process fallback mid-session.
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
    // Fail in-flight requests so callers can retry; they would otherwise hang.
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
      // Copy so the caller's bytes survive a failed postMessage and the in-process fallback.
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
      // Same copy as open().
      const transferable = baseBytes.slice().buffer;
      return (await this.post({ kind: 'openJson', baseBytes: transferable, fragments, options }, [transferable])) as ProtoDefIndex;
    } catch {
      return (await this.ensureFallback()).openJsonFragments(baseBytes, fragments, options);
    }
  }

  // Once the in-process fallback is active it serves every call. Otherwise the
  // worker runs the request, and a failed or missing worker falls back for it.
  private async dispatch<T>(
    message: Record<string, unknown>,
    inProcess: (source: InProcessSource) => Promise<T>,
  ): Promise<T> {
    if (this.fallback) return inProcess(this.fallback);
    if (!this.worker) return inProcess(await this.ensureFallback());
    try {
      return (await this.post(message)) as T;
    } catch {
      return inProcess(await this.ensureFallback());
    }
  }

  async resolveRecipe(defindex: number, weaponKey: string, team: Team, wearIndex: number): Promise<ProtoDefRecipe | null> {
    return this.dispatch<ProtoDefRecipe | null>(
      { kind: 'resolveRecipe', defindex, weaponKey, team, wearIndex },
      (source) => source.resolveRecipe(defindex, weaponKey, team, wearIndex),
    );
  }

  async resolveRecipeWithProvenance(
    defindex: number,
    weaponKey: string,
    team: Team,
    wearIndex: number,
  ): Promise<ProtoDefRecipeWithProvenance | null> {
    return this.dispatch<ProtoDefRecipeWithProvenance | null>(
      { kind: 'resolveRecipeWithProvenance', defindex, weaponKey, team, wearIndex },
      (source) => source.resolveRecipeWithProvenance(defindex, weaponKey, team, wearIndex),
    );
  }

  async exportKit(defindex: number): Promise<ProtoDefKitMessages | null> {
    return this.dispatch<ProtoDefKitMessages | null>(
      { kind: 'exportKit', defindex },
      (source) => source.exportKit(defindex),
    );
  }

  async exportKitBundle(defindex: number): Promise<ProtoDefKitBundle | null> {
    return this.dispatch<ProtoDefKitBundle | null>(
      { kind: 'exportKitBundle', defindex },
      (source) => source.exportKitBundle(defindex),
    );
  }

  async exportKitWeaponSlots(defindex: number): Promise<ProtoDefKitWeaponSlot[] | null> {
    return this.dispatch<ProtoDefKitWeaponSlot[] | null>(
      { kind: 'exportKitWeaponSlots', defindex },
      (source) => source.exportKitWeaponSlots(defindex),
    );
  }

  dispose(): void {
    if (this.worker) {
      // Best-effort: the worker drops its references, but dispose() does not wait on it.
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
