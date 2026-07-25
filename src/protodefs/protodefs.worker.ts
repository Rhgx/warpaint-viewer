/// <reference lib="webworker" />

// Thin message plumbing over decoder.ts. A stock container decodes to tens of
// megabytes of plain objects (paintkit/item/operation definitions); this worker
// is what actually holds that memory, so the main thread's heap stays small and
// dispose() can release it all at once by just dropping the reference.

import { decodeProtoDefs, decodeProtoDefsFromJson, resolveKitRecipe } from './decoder';
import type { DecodedContainer } from './decoder';
import type { ProtoDefJsonFragment, ProtoDefOpenOptions } from './types';

type Team = 'red' | 'blu';

interface OpenRequest {
  id: number;
  kind: 'open';
  bytes: ArrayBuffer;
  options: ProtoDefOpenOptions;
}

interface OpenJsonRequest {
  id: number;
  kind: 'openJson';
  baseBytes: ArrayBuffer;
  fragments: ProtoDefJsonFragment[];
  options: ProtoDefOpenOptions;
}

interface ResolveRecipeRequest {
  id: number;
  kind: 'resolveRecipe';
  defindex: number;
  weaponKey: string;
  team: Team;
  wearIndex: number;
}

interface DisposeRequest {
  id: number;
  kind: 'dispose';
}

type Request = OpenRequest | OpenJsonRequest | ResolveRecipeRequest | DisposeRequest;

let decoded: DecodedContainer | null = null;

function reply(id: number, result: unknown): void {
  self.postMessage({ id, ok: true, result });
}

function fail(id: number, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : 'Failed to process the proto_defs container.';
  self.postMessage({ id, ok: false, message });
}

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    switch (request.kind) {
      case 'open': {
        decoded = decodeProtoDefs(new Uint8Array(request.bytes), request.options);
        reply(request.id, decoded.index);
        break;
      }
      case 'openJson': {
        decoded = decodeProtoDefsFromJson(new Uint8Array(request.baseBytes), request.fragments, request.options);
        reply(request.id, decoded.index);
        break;
      }
      case 'resolveRecipe': {
        if (!decoded) { reply(request.id, null); break; }
        const recipe = resolveKitRecipe(decoded, request.defindex, request.weaponKey, request.team, request.wearIndex);
        reply(request.id, recipe);
        break;
      }
      case 'dispose': {
        decoded = null;
        reply(request.id, null);
        break;
      }
    }
  } catch (cause) {
    fail(request.id, cause);
  }
};
