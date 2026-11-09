/// <reference lib="webworker" />

// Thin message plumbing over decoder.ts. The decoded container is tens of megabytes of
// plain objects; holding it here keeps the main thread's heap small, and dispose() frees
// it by dropping the reference.

import { decodeProtoDefs, decodeProtoDefsFromJson } from './decoder';
import {
  extractKitBundle,
  extractKitMessages,
  getKitWeaponSlots,
  resolveKitRecipe,
  resolveKitRecipeWithProvenance,
} from './kitQueries';
import { AppError } from '../errors';
import type { DecodedContainer } from './decoderShared';
import type { Team } from '../data/types';
import type { ProtoDefJsonFragment, ProtoDefOpenOptions } from './types';

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

interface ResolveRecipeWithProvenanceRequest {
  id: number;
  kind: 'resolveRecipeWithProvenance';
  defindex: number;
  weaponKey: string;
  team: Team;
  wearIndex: number;
}

interface ExportKitRequest {
  id: number;
  kind: 'exportKit';
  defindex: number;
}

interface ExportKitBundleRequest {
  id: number;
  kind: 'exportKitBundle';
  defindex: number;
}

interface ExportKitWeaponSlotsRequest {
  id: number;
  kind: 'exportKitWeaponSlots';
  defindex: number;
}

interface DisposeRequest {
  id: number;
  kind: 'dispose';
}

type Request =
  | OpenRequest | OpenJsonRequest | ResolveRecipeRequest | ResolveRecipeWithProvenanceRequest
  | ExportKitRequest | ExportKitBundleRequest | ExportKitWeaponSlotsRequest | DisposeRequest;

let decoded: DecodedContainer | null = null;

function reply(id: number, result: unknown): void {
  self.postMessage({ id, ok: true, result });
}

function fail(id: number, cause: unknown): void {
  const message = cause instanceof Error ? cause.message : 'Failed to process the proto_defs container.';
  // An AppError's code and location do not survive postMessage as a class, so its fields travel as plain data.
  const appError = cause instanceof AppError
    ? { code: cause.code, userMessage: cause.userMessage, technicalDetail: cause.technicalDetail, path: cause.path, location: cause.location }
    : undefined;
  self.postMessage({ id, ok: false, message, appError });
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
      case 'resolveRecipeWithProvenance': {
        if (!decoded) { reply(request.id, null); break; }
        const recipe = resolveKitRecipeWithProvenance(
          decoded,
          request.defindex,
          request.weaponKey,
          request.team,
          request.wearIndex,
        );
        reply(request.id, recipe);
        break;
      }
      case 'exportKit': {
        reply(request.id, decoded ? extractKitMessages(decoded, request.defindex) : null);
        break;
      }
      case 'exportKitBundle': {
        reply(request.id, decoded ? extractKitBundle(decoded, request.defindex) : null);
        break;
      }
      case 'exportKitWeaponSlots': {
        reply(request.id, decoded ? getKitWeaponSlots(decoded, request.defindex) : null);
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
