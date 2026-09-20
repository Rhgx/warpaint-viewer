import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseProtoDefGroups,
  writeProtoDefGroups,
  spliceProtoDefs,
  usedDefindexes,
  DEF_TYPE_PAINTKIT_DEFINITION,
  DEF_TYPE_PAINTKIT_OPERATION,
} from '../../src/export/protoWrite';
import { decodeProtoDefs } from '../../src/protodefs/decoder';
import { decodeLocalization, encodeLocalization, setPaintkitName, paintkitNameToken } from '../../src/export/localization';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoot, parseContainer as parseContainerNode, decodeType, DEF_TYPE } from '../lib/proto.mjs';
import { loadLocalization } from '../lib/localization.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGING = path.join(ROOT, 'staging');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');

const CONTAINER_CANDIDATES = [
  process.env.TF2_PROTODEFS,
  path.join(PUBLIC_DATA, 'protodefs-full.bin'),
  'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2/tf/scripts/protodefs/proto_defs.vpd',
].filter(Boolean);
const CONTAINER = process.env.TF2_PROTODEFS ?? CONTAINER_CANDIDATES.find((candidate) => fs.existsSync(candidate));

test('container and localization survive independent readers', (context) => {
  if (!CONTAINER) { context.skip('No proto_defs fixture'); return; }

  const original = new Uint8Array(fs.readFileSync(CONTAINER));
  console.log(`[verify] using ${CONTAINER} (${original.byteLength.toLocaleString()} bytes)`);

  // --- 1. Byte-exact rewrite ---------------------------------------------------

  const groups = parseProtoDefGroups(original);
  console.log(`[verify] container holds ${groups.length} blocks: ${groups.map((g) => `${g.defType}x${g.payloads.length}`).join(', ')}`);
  const rewritten = writeProtoDefGroups(groups);
  assert.ok(
    rewritten.byteLength === original.byteLength && Buffer.compare(Buffer.from(rewritten), Buffer.from(original)) === 0,
    `rewriting the container without changes reproduces it byte for byte: ${rewritten.byteLength.toLocaleString()} bytes`,
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
  assert.ok(
    !beforeDefindexes.has(appended.paintkitDefindex),
    `append picks a paint kit defindex that was free: assigned ${appended.paintkitDefindex}`,
  );
  assert.ok(
    !beforeOperations.has(appended.operationDefindex),
    `append picks an operation defindex that was free: assigned ${appended.operationDefindex}`,
  );

  const appendedGroups = parseProtoDefGroups(appended.bytes);
  const appendedDefindexes = usedDefindexes(appendedGroups, DEF_TYPE_PAINTKIT_DEFINITION);
  assert.ok(
    appendedDefindexes.size === beforeDefindexes.size + 1 && appendedDefindexes.has(appended.paintkitDefindex),
    `append adds exactly one paint kit: ${beforeDefindexes.size} -> ${appendedDefindexes.size}`,
  );
  let missing = [...beforeDefindexes].filter((defindex) => !appendedDefindexes.has(defindex));
  assert.ok(
    missing.length === 0,
    `append leaves every pre-existing paint kit in place: missing ${missing.slice(0, 5).join(', ')}`,
  );

  // --- 4. The spliced container still decodes, through both decoders -----------

  const options = {
    weaponsByItemDef: JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8')),
    builtInIds: [],
  };
  const beforeIndex = decodeProtoDefs(original, options).index;
  const afterIndex = decodeProtoDefs(appended.bytes, options).index;
  assert.ok(
    afterIndex.kits.length === beforeIndex.kits.length + 1,
    `the browser decoder reads one extra kit out of the spliced container: ${beforeIndex.kits.length} -> ${afterIndex.kits.length}`,
  );
  const newKit = afterIndex.kits.find((kit) => kit.defindex === appended.paintkitDefindex);
  const sourceKit = beforeIndex.kits.find((kit) => kit.defindex === nodeDefs[sourceIndex].header.defindex);
  assert.ok(Boolean(newKit), 'the spliced kit is present after decoding');
  if (newKit && sourceKit) {
    assert.ok(
      newKit.weapons.length === sourceKit.weapons.length,
      `the spliced kit keeps every weapon slot of the kit it was copied from: ${newKit.weapons.length} vs ${sourceKit.weapons.length}`,
    );
  }

  fs.mkdirSync(STAGING, { recursive: true });
  const outputDir = fs.mkdtempSync(path.join(STAGING, 'protodefs-write-'));
  context.onTestFinished(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const splicedPath = path.join(outputDir, 'spliced_proto_defs.vpd');
  fs.writeFileSync(splicedPath, appended.bytes);
  const nodeAfter = parseContainerNode(splicedPath);
  const nodeAfterDefs = decodeType(root, nodeAfter.byType, DEF_TYPE.PAINTKIT_DEFINITION);
  assert.ok(
    nodeAfterDefs.length === nodeDefs.length + 1,
    `the pipeline's independent node decoder agrees on the kit count: ${nodeDefs.length} -> ${nodeAfterDefs.length}`,
  );
  const nodeNewKit = nodeAfterDefs.find((def) => def.header?.defindex === appended.paintkitDefindex);
  assert.ok(Boolean(nodeNewKit), 'the node decoder finds the spliced kit by its new defindex');

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
  assert.ok(
    overwrittenDefindexes.size === beforeDefindexes.size,
    `overwrite does not change how many paint kits exist: ${beforeDefindexes.size} -> ${overwrittenDefindexes.size}`,
  );
  assert.ok(
    overwritten.replaced && overwritten.paintkitDefindex === targetDefindex,
    'overwrite reports the kit it replaced',
  );
  const overwrittenIndex = decodeProtoDefs(overwritten.bytes, options).index;
  assert.ok(
    overwrittenIndex.kits.length === beforeIndex.kits.length,
    `the decoder still sees the original number of kits after an overwrite: ${overwrittenIndex.kits.length}`,
  );
  const replacedKit = overwrittenIndex.kits.find((kit) => kit.defindex === targetDefindex);
  assert.ok(
    Boolean(replacedKit) && replacedKit.weapons.length === (sourceKit?.weapons.length ?? -1),
    'the overwritten slot now carries the spliced paint' + ": " + (replacedKit ? `${replacedKit.weapons.length} weapons` : 'kit missing'),
  );

  const splicedDefinition = decodeType(root, nodeAfter.byType, DEF_TYPE.PAINTKIT_DEFINITION)
    .find((def) => def.header?.defindex === appended.paintkitDefindex);
  assert.ok(
    splicedDefinition?.loc_desctoken === `9_${appended.paintkitDefindex}_field { field_number: 2 }`,
    'the name token follows the kit to its new defindex' + ": " + (splicedDefinition?.loc_desctoken),
  );
  assert.ok(
    splicedDefinition?.operation_template?.defindex === appended.operationDefindex,
    `the definition points at the operation that was added with it: points at ${splicedDefinition?.operation_template?.defindex}, added ${appended.operationDefindex}`,
  );

  assert.ok(
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
    console.log('[verify] skipped the localization checks, run tools/extract/warpaints.mjs --only export-snapshot first');
  } else {
  
    const originalLocBytes = new Uint8Array(fs.readFileSync(LOCALIZATION));
    const before = loadLocalization(LOCALIZATION);

    const decoded = decodeLocalization(originalLocBytes);
    assert.ok(decoded.hadBom, 'the shipped localization file is UTF-16LE with a BOM');
    assert.ok(
      Buffer.compare(Buffer.from(encodeLocalization(decoded)), Buffer.from(originalLocBytes)) === 0,
      `decoding and re-encoding a localization file reproduces it byte for byte: ${originalLocBytes.byteLength.toLocaleString()} bytes`,
    );

    const NAME = 'Test Paint Åé "quoted"';
    const named = setPaintkitName(decoded, appended.paintkitDefindex, NAME);
    const namedPath = path.join(outputDir, 'english.txt');
    fs.writeFileSync(namedPath, encodeLocalization(named));
    const after = loadLocalization(namedPath);

    assert.ok(after.size === before.size + 1, `adding a name adds exactly one token: ${before.size} -> ${after.size}`);
    const addedToken = paintkitNameToken(appended.paintkitDefindex).toLowerCase();
    assert.ok(
      after.get(addedToken) === NAME.replace(/"/g, '\\"'),
      'the new name resolves through the pipeline parser' + ": " + (JSON.stringify(after.get(addedToken))),
    );
    let changed = [];
    for (const [token, value] of before) {
      if (after.get(token) !== value) changed.push(token);
    }
    assert.ok(
      changed.length === 0,
      `every pre-existing name is untouched: ${changed.length} changed: ${changed.slice(0, 3).join(', ')}`,
    );

    // Overwrite mode takes over an existing kit's name rather than adding one.
    const existingDefindex = nodeDefs[5].header.defindex;
    const renamed = setPaintkitName(decoded, existingDefindex, 'Renamed Kit');
    const renamedPath = path.join(outputDir, 'english_renamed.txt');
    fs.writeFileSync(renamedPath, encodeLocalization(renamed));
    const renamedMap = loadLocalization(renamedPath);
    assert.ok(
      renamedMap.size === before.size,
      `renaming an existing kit does not add a token: ${before.size} -> ${renamedMap.size}`,
    );
    assert.ok(
      renamedMap.get(paintkitNameToken(existingDefindex).toLowerCase()) === 'Renamed Kit',
      'renaming an existing kit replaces its name' + ": " + (JSON.stringify(renamedMap.get(paintkitNameToken(existingDefindex).toLowerCase()))),
    );
  }

}, 120000);
