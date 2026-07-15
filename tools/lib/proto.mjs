// Proto loader + proto_defs.vpd container parser.
// protobufjs cannot handle the custom option extensions in tf_proto_def_messages.proto,
// so we preprocess the schema text to strip them before loading.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, '..', 'proto', 'tf_proto_def_messages.proto');

// Container defType values. Empirically the container tags each block with the ProtoDefTypes
// enum value (NOT the 9..12 from the task brief, which are the CMsgProtoDefID.instance field
// numbers). Verified against block counts: type 6=0, 7=827 ops, 8=207 item defs, 9=250 paintkits.
// These same enum values appear in CMsgProtoDefID.type for operation_template references.
export const DEF_TYPE = {
  PAINTKIT_VARIABLES: 6,
  PAINTKIT_OPERATION: 7,
  PAINTKIT_ITEM_DEFINITION: 8,
  PAINTKIT_DEFINITION: 9,
};

export const MSG_FOR_DEFTYPE = {
  6: 'CMsgPaintKit_Variables',
  7: 'CMsgPaintKit_Operation',
  8: 'CMsgPaintKit_ItemDefinition',
  9: 'CMsgPaintKit_Definition',
};

// Remove custom options / extends / imports that protobufjs's parser rejects.
function stripProtoOptions(src) {
  let s = src;
  // Drop the descriptor import (we do not need descriptor.proto for decoding).
  s = s.replace(/import\s+"google\/protobuf\/descriptor\.proto"\s*;/g, '');
  // Drop the two `extend google.protobuf.*Options { ... }` blocks (no nested braces inside).
  s = s.replace(/extend\s+google\.protobuf\.\w+\s*\{[^}]*\}/g, '');
  // Drop standalone option statements (top-level and message-level like `option (start_expanded) = false;`).
  s = s.replace(/^\s*option\s+[^;]*;/gm, '');
  // Drop all field option brackets `[ ... ]` (non-nested, may span multiple lines).
  s = s.replace(/\[[\s\S]*?\]/g, '');
  return s;
}

let cachedRoot = null;

export function loadRoot() {
  if (cachedRoot) return cachedRoot;
  const raw = fs.readFileSync(PROTO_PATH, 'utf8');
  const stripped = stripProtoOptions(raw);
  const parsed = protobuf.parse(stripped, { keepCase: true });
  cachedRoot = parsed.root;
  return cachedRoot;
}

// Parse the proto_defs.vpd container. Little-endian. Repeated blocks until EOF:
//   int32 defType; int32 numDefs; repeat numDefs: int32 size; byte[size] payload
// Returns { root, byType: { [defType]: [ {size, buffer} ] } }.
export function parseContainer(vpdPath) {
  const buf = fs.readFileSync(vpdPath);
  const byType = {};
  let off = 0;
  const blocks = [];
  while (off + 8 <= buf.length) {
    const defType = buf.readInt32LE(off); off += 4;
    const numDefs = buf.readInt32LE(off); off += 4;
    if (numDefs < 0 || numDefs > 1000000) {
      throw new Error(`Suspicious numDefs=${numDefs} at offset ${off - 4} (defType=${defType})`);
    }
    const list = byType[defType] || (byType[defType] = []);
    for (let i = 0; i < numDefs; i++) {
      const size = buf.readInt32LE(off); off += 4;
      if (size < 0 || off + size > buf.length) {
        throw new Error(`Bad size=${size} at offset ${off - 4} for defType=${defType} idx=${i}`);
      }
      const payload = buf.subarray(off, off + size);
      off += size;
      list.push({ size, buffer: payload });
    }
    blocks.push({ defType, numDefs });
  }
  return { byType, blocks, totalBytes: buf.length, consumed: off };
}

// Decode all payloads of the given container into plain JS objects keyed by defindex.
export function decodeType(root, byType, defType) {
  const typeName = MSG_FOR_DEFTYPE[defType];
  if (!typeName) throw new Error(`No message mapping for defType ${defType}`);
  const Msg = root.lookupType(typeName);
  const list = byType[defType] || [];
  const out = [];
  for (const { buffer } of list) {
    const decoded = Msg.decode(buffer);
    const obj = Msg.toObject(decoded, {
      longs: Number,
      enums: Number,
      bytes: String,
      defaults: false,
      arrays: false,
      objects: false,
    });
    out.push(obj);
  }
  return out;
}
