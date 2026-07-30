// Generates src/protodefs/schema.generated.json from tools/proto/tf_proto_def_messages.proto,
// so the browser-side decoder can load message definitions through protobufjs/light
// (which has no .proto parser, only Root.fromJSON) without shipping a parser.
//
//   node tools/generate/protodef-schema.mjs
//
// The .proto file stays the source of truth; this JSON is a checked-in generated
// artifact (same idea as tools/extract/map-lighting.mjs -> mapLighting.generated.ts).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';
import { stripProtoOptions } from '../lib/proto.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const PROTO_PATH = path.join(ROOT, 'tools', 'proto', 'tf_proto_def_messages.proto');
const OUT_PATH = path.join(ROOT, 'src', 'protodefs', 'schema.generated.json');

const raw = fs.readFileSync(PROTO_PATH, 'utf8');
const stripped = stripProtoOptions(raw);
const { root } = protobuf.parse(stripped, { keepCase: true });

const json = JSON.stringify(root.toJSON());
fs.writeFileSync(OUT_PATH, json);

const { size } = fs.statSync(OUT_PATH);
console.log(`[gen-protodefs] wrote ${path.relative(ROOT, OUT_PATH)} (${(size / 1024).toFixed(1)} KiB)`);
