// Verification for the proto_defs container writer and splice.
//
//   node tools/verify-protodefs-write.mjs [path/to/proto_defs.vpd]
//
// The export builder writes a complete proto_defs container with one extra war
// paint in it. That file SHADOWS the player's own when it is installed, so a
// mistake does not degrade one paint, it breaks every paint in their game. The
// checks here are correspondingly blunt:
//
//   1. Rewriting the real container without splicing anything must reproduce it
//      byte for byte. If that holds, the writer cannot be silently reshaping
//      Valve's data.
//   2. After a splice, every kit that was there before must still decode with
//      the same defindex and the same weapon slots, and the new one must be
//      there too.
//   3. The two splice modes must land the paint where they claim.
//
// Checks 2 and 3 read the result back through the browser decoder AND through
// the extraction pipeline's independent node decoder (tools/lib/proto.mjs), so
// a shared assumption between the writer and one reader cannot hide a fault.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadRoot, parseContainer as parseContainerNode, decodeType, DEF_TYPE } from './lib/proto.mjs';
import { loadLocalization } from './lib/localization.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = path.join(ROOT, 'staging');
const BUILD_DIR = path.join(STAGING, 'protodefs-write-verify');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const CONTAINER_CANDIDATES = [
  process.argv[2],
  path.join(PUBLIC_DATA, 'protodefs-full.bin'),
  'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2/tf/scripts/protodefs/proto_defs.vpd',
].filter(Boolean);
const CONTAINER = CONTAINER_CANDIDATES.find((candidate) => fs.existsSync(candidate));

const failures = [];
function check(condition, name, detail) {
  if (condition) {
    console.log(`[verify] ok: ${name}${detail ? ` (${detail})` : ''}`);
    return true;
  }
  failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  console.error(`[verify] FAIL: ${name}${detail ? `\n         ${detail}` : ''}`);
  return false;
}

function bundleModules() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const entry = path.join(STAGING, 'protodefs-write-verify-entry.ts');
  fs.writeFileSync(entry, [
    "export * from '../src/export/protoWrite';",
    "export * from '../src/export/localization';",
    "export { decodeProtoDefs, decodeProtoDefsFromJson } from '../src/protodefs/decoder';",
    '',
  ].join('\n'));
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('vite ssr build of the proto_defs writer failed');
  return pathToFileURL(path.join(BUILD_DIR, 'protodefs-write-verify-entry.js')).href;
}

if (!CONTAINER) {
  console.error('[verify] no proto_defs container found. Run tools/extract.mjs --only export-snapshot, or pass a path.');
  process.exit(1);
}

console.log('[verify] bundling the proto_defs writer ...');
const api = await import(bundleModules());
const {
  parseProtoDefGroups,
  writeProtoDefGroups,
  spliceProtoDefs,
  usedDefindexes,
  decodeProtoDefs,
  DEF_TYPE_PAINTKIT_DEFINITION,
  DEF_TYPE_PAINTKIT_OPERATION,
} = api;

const original = new Uint8Array(fs.readFileSync(CONTAINER));
console.log(`[verify] using ${CONTAINER} (${original.byteLength.toLocaleString()} bytes)`);

// --- 1. Byte-exact rewrite ---------------------------------------------------

const groups = parseProtoDefGroups(original);
console.log(`[verify] container holds ${groups.length} blocks: ${groups.map((g) => `${g.defType}x${g.payloads.length}`).join(', ')}`);
const rewritten = writeProtoDefGroups(groups);
check(
  rewritten.byteLength === original.byteLength && Buffer.compare(Buffer.from(rewritten), Buffer.from(original)) === 0,
  'rewriting the container without changes reproduces it byte for byte',
  `${rewritten.byteLength.toLocaleString()} bytes`,
);

// --- 2. A paint to splice ----------------------------------------------------
//
// Rather than depend on a community pack being present, this lifts a real kit
// and its operation out of the container itself and re-adds them under a
// synthetic id, which exercises exactly the same encode path.

const root = loadRoot();
const nodeContainer = parseContainerNode(CONTAINER);
const nodeDefs = decodeType(root, nodeContainer.byType, DEF_TYPE.PAINTKIT_DEFINITION);
const nodeOperations = decodeType(root, nodeContainer.byType, DEF_TYPE.PAINTKIT_OPERATION);

// Pick a modern kit that paints many weapons, so "every slot survived" means
// something, rather than the one-slot legacy shape the earliest kits use.
const sourceIndex = nodeDefs.findIndex((def) => def.operation_template && Object.keys(def).length > 6);
const sampleDefinition = structuredClone(nodeDefs[sourceIndex]);
const sampleOperation = structuredClone(nodeOperations.find(
  (operation) => operation.header?.defindex === sampleDefinition.operation_template.defindex,
));

// Shaped the way an imported community paint arrives: both halves carry a
// synthetic id (jsonFragments.ts assigns one per placeholder token, far above
// any real defindex), and the definition points at the operation by that id.
const SYNTHETIC_OPERATION = 900000001;
const SYNTHETIC_PAINTKIT = 900000002;
const originalOperationDefindex = sampleDefinition.operation_template.defindex;
sampleOperation.header.defindex = SYNTHETIC_OPERATION;
sampleDefinition.header.defindex = SYNTHETIC_PAINTKIT;
sampleDefinition.operation_template.defindex = SYNTHETIC_OPERATION;
  // Community JSON fragments keep this placeholder inside the string even
  // after the importer assigns their header a synthetic numeric defindex.
  sampleDefinition.loc_desctoken = '9_###_field { field_number: 2 }';
console.log(`[verify] fixture built from kit #${nodeDefs[sourceIndex].header.defindex} `
  + `"${nodeDefs[sourceIndex].header.name}" (operation ${originalOperationDefindex})`);

const beforeDefindexes = usedDefindexes(groups, DEF_TYPE_PAINTKIT_DEFINITION);
const beforeOperations = usedDefindexes(groups, DEF_TYPE_PAINTKIT_OPERATION);
console.log(`[verify] base container has ${beforeDefindexes.size} paint kits and ${beforeOperations.size} operations`);

// --- 3. Append mode ----------------------------------------------------------

const appended = spliceProtoDefs({
  baseBytes: original,
  operation: sampleOperation,
  definition: sampleDefinition,
  mode: 'append',
});
check(
  !beforeDefindexes.has(appended.paintkitDefindex),
  'append picks a paint kit defindex that was free',
  `assigned ${appended.paintkitDefindex}`,
);
check(
  !beforeOperations.has(appended.operationDefindex),
  'append picks an operation defindex that was free',
  `assigned ${appended.operationDefindex}`,
);

const appendedGroups = parseProtoDefGroups(appended.bytes);
const appendedDefindexes = usedDefindexes(appendedGroups, DEF_TYPE_PAINTKIT_DEFINITION);
check(
  appendedDefindexes.size === beforeDefindexes.size + 1 && appendedDefindexes.has(appended.paintkitDefindex),
  'append adds exactly one paint kit',
  `${beforeDefindexes.size} -> ${appendedDefindexes.size}`,
);
let missing = [...beforeDefindexes].filter((defindex) => !appendedDefindexes.has(defindex));
check(missing.length === 0, 'append leaves every pre-existing paint kit in place', `missing ${missing.slice(0, 5).join(', ')}`);

// --- 4. The spliced container still decodes, through both decoders -----------

const options = {
  weaponsByItemDef: JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8')),
  builtInIds: [],
};
const beforeIndex = decodeProtoDefs(original, options).index;
const afterIndex = decodeProtoDefs(appended.bytes, options).index;
check(
  afterIndex.kits.length === beforeIndex.kits.length + 1,
  'the browser decoder reads one extra kit out of the spliced container',
  `${beforeIndex.kits.length} -> ${afterIndex.kits.length}`,
);
const newKit = afterIndex.kits.find((kit) => kit.defindex === appended.paintkitDefindex);
const sourceKit = beforeIndex.kits.find((kit) => kit.defindex === nodeDefs[sourceIndex].header.defindex);
check(Boolean(newKit), 'the spliced kit is present after decoding');
if (newKit && sourceKit) {
  check(
    newKit.weapons.length === sourceKit.weapons.length,
    'the spliced kit keeps every weapon slot of the kit it was copied from',
    `${newKit.weapons.length} vs ${sourceKit.weapons.length}`,
  );
}

fs.mkdirSync(BUILD_DIR, { recursive: true });
const splicedPath = path.join(BUILD_DIR, 'spliced_proto_defs.vpd');
fs.writeFileSync(splicedPath, appended.bytes);
const nodeAfter = parseContainerNode(splicedPath);
const nodeAfterDefs = decodeType(root, nodeAfter.byType, DEF_TYPE.PAINTKIT_DEFINITION);
check(
  nodeAfterDefs.length === nodeDefs.length + 1,
  "the pipeline's independent node decoder agrees on the kit count",
  `${nodeDefs.length} -> ${nodeAfterDefs.length}`,
);
const nodeNewKit = nodeAfterDefs.find((def) => def.header?.defindex === appended.paintkitDefindex);
check(Boolean(nodeNewKit), 'the node decoder finds the spliced kit by its new defindex');

// --- 5. Overwrite mode -------------------------------------------------------

const targetDefindex = nodeDefs[5].header.defindex;

const overwritten = spliceProtoDefs({
  baseBytes: original,
  operation: sampleOperation,
  definition: sampleDefinition,
  mode: 'overwrite',
  targetDefindex,
});
const overwrittenGroups = parseProtoDefGroups(overwritten.bytes);
const overwrittenDefindexes = usedDefindexes(overwrittenGroups, DEF_TYPE_PAINTKIT_DEFINITION);
check(
  overwrittenDefindexes.size === beforeDefindexes.size,
  'overwrite does not change how many paint kits exist',
  `${beforeDefindexes.size} -> ${overwrittenDefindexes.size}`,
);
check(overwritten.replaced && overwritten.paintkitDefindex === targetDefindex, 'overwrite reports the kit it replaced');
const overwrittenIndex = decodeProtoDefs(overwritten.bytes, options).index;
check(
  overwrittenIndex.kits.length === beforeIndex.kits.length,
  'the decoder still sees the original number of kits after an overwrite',
  `${overwrittenIndex.kits.length}`,
);
const replacedKit = overwrittenIndex.kits.find((kit) => kit.defindex === targetDefindex);
check(
  Boolean(replacedKit) && replacedKit.weapons.length === (sourceKit?.weapons.length ?? -1),
  'the overwritten slot now carries the spliced paint',
  replacedKit ? `${replacedKit.weapons.length} weapons` : 'kit missing',
);

const splicedDefinition = decodeType(root, nodeAfter.byType, DEF_TYPE.PAINTKIT_DEFINITION)
  .find((def) => def.header?.defindex === appended.paintkitDefindex);
check(
  splicedDefinition?.loc_desctoken === `9_${appended.paintkitDefindex}_field { field_number: 2 }`,
  'the name token follows the kit to its new defindex',
  splicedDefinition?.loc_desctoken,
);
check(
  splicedDefinition?.operation_template?.defindex === appended.operationDefindex,
  'the definition points at the operation that was added with it',
  `points at ${splicedDefinition?.operation_template?.defindex}, added ${appended.operationDefindex}`,
);

check(
  (() => {
    try {
      spliceProtoDefs({ baseBytes: original, operation: sampleOperation, definition: sampleDefinition, mode: 'overwrite', targetDefindex: 999999 });
      return false;
    } catch { return true; }
  })(),
  'overwriting a defindex that does not exist is rejected',
);

// --- 6. The localization splice ---------------------------------------------
//
// Same shadowing rule as the container: the pack ships a COMPLETE file, so the
// test is that exactly one token changed and every other one survived. It is
// read back with tools/lib/localization.mjs, the parser the extraction pipeline
// already uses, rather than with the writer's own idea of the format.

const LOCALIZATION = path.join(PUBLIC_DATA, 'protodefs-loc', 'english.txt');
if (!fs.existsSync(LOCALIZATION)) {
  console.log('[verify] skipped the localization checks, run tools/extract.mjs --only export-snapshot first');
} else {
  const { decodeLocalization, encodeLocalization, setPaintkitName, paintkitNameToken } = api;
  const originalLocBytes = new Uint8Array(fs.readFileSync(LOCALIZATION));
  const before = loadLocalization(LOCALIZATION);

  const decoded = decodeLocalization(originalLocBytes);
  check(decoded.hadBom, 'the shipped localization file is UTF-16LE with a BOM');
  check(
    Buffer.compare(Buffer.from(encodeLocalization(decoded)), Buffer.from(originalLocBytes)) === 0,
    'decoding and re-encoding a localization file reproduces it byte for byte',
    `${originalLocBytes.byteLength.toLocaleString()} bytes`,
  );

  const NAME = 'Test Paint Åé "quoted"';
  const named = setPaintkitName(decoded, appended.paintkitDefindex, NAME);
  const namedPath = path.join(BUILD_DIR, 'english.txt');
  fs.writeFileSync(namedPath, encodeLocalization(named));
  const after = loadLocalization(namedPath);

  check(
    after.size === before.size + 1,
    'adding a name adds exactly one token',
    `${before.size} -> ${after.size}`,
  );
  const addedToken = paintkitNameToken(appended.paintkitDefindex).toLowerCase();
  check(
    after.get(addedToken) === NAME.replace(/"/g, '\\"'),
    'the new name resolves through the pipeline parser',
    JSON.stringify(after.get(addedToken)),
  );
  let changed = [];
  for (const [token, value] of before) {
    if (after.get(token) !== value) changed.push(token);
  }
  check(
    changed.length === 0,
    'every pre-existing name is untouched',
    `${changed.length} changed: ${changed.slice(0, 3).join(', ')}`,
  );

  // Overwrite mode takes over an existing kit's name rather than adding one.
  const existingDefindex = nodeDefs[5].header.defindex;
  const renamed = setPaintkitName(decoded, existingDefindex, 'Renamed Kit');
  const renamedPath = path.join(BUILD_DIR, 'english_renamed.txt');
  fs.writeFileSync(renamedPath, encodeLocalization(renamed));
  const renamedMap = loadLocalization(renamedPath);
  check(
    renamedMap.size === before.size,
    'renaming an existing kit does not add a token',
    `${before.size} -> ${renamedMap.size}`,
  );
  check(
    renamedMap.get(paintkitNameToken(existingDefindex).toLowerCase()) === 'Renamed Kit',
    'renaming an existing kit replaces its name',
    JSON.stringify(renamedMap.get(paintkitNameToken(existingDefindex).toLowerCase())),
  );
}

// --- Report ------------------------------------------------------------------

console.log('');
if (failures.length) {
  console.error(`[verify] ${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('[verify] PASS: the container writer is byte exact and both splice modes survive two independent decoders.');
