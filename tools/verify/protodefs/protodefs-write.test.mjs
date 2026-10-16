import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import {
  parseProtoDefGroups,
  writeProtoDefGroups,
  spliceProtoDefs,
  usedDefindexes,
  DEF_TYPE_PAINTKIT_DEFINITION,
  DEF_TYPE_PAINTKIT_OPERATION,
} from '../../../src/export/protoWrite';
import { decodeLocalization, encodeLocalization, setPaintkitName, paintkitNameToken } from '../../../src/export/localization';
import { loadRoot, parseContainer as parseContainerNode, decodeType, DEF_TYPE } from '../../lib/proto.mjs';
import { loadLocalization } from '../../lib/localization.mjs';
import { PUBLIC_DATA, ROOT } from '../fixtures';

const STAGING = path.join(ROOT, 'staging');
const CONTAINER = process.env.TF2_PROTODEFS ?? [
  path.join(PUBLIC_DATA, 'protodefs-full.bin'),
  'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2/tf/scripts/protodefs/proto_defs.vpd',
].find((candidate) => fs.existsSync(candidate));

test('container and localization survive independent readers', (context) => {
  if (!CONTAINER) { context.skip('No proto_defs fixture'); return; }

  const original = new Uint8Array(fs.readFileSync(CONTAINER));
  const groups = parseProtoDefGroups(original);
  assert.equal(Buffer.compare(Buffer.from(writeProtoDefGroups(groups)), Buffer.from(original)), 0, 'an unchanged rewrite is byte-exact');

  // Lift a real multi-weapon kit and its operation out of the container and re-add them
  // under synthetic ids, shaped the way an imported community paint arrives.
  const root = loadRoot();
  const nodeContainer = parseContainerNode(CONTAINER);
  const nodeDefs = decodeType(root, nodeContainer.byType, DEF_TYPE.PAINTKIT_DEFINITION);
  const nodeOperations = decodeType(root, nodeContainer.byType, DEF_TYPE.PAINTKIT_OPERATION);
  const sampleDefinition = structuredClone(nodeDefs.find((def) => def.operation_template && Object.keys(def).length > 6));
  const sampleOperation = structuredClone(nodeOperations.find(
    (operation) => operation.header?.defindex === sampleDefinition.operation_template.defindex,
  ));
  sampleOperation.header.defindex = 900000001;
  sampleDefinition.header.defindex = 900000002;
  sampleDefinition.operation_template.defindex = 900000001;
  // Community fragments keep this placeholder inside the string after the header gets a numeric id.
  sampleDefinition.loc_desctoken = '9_###_field { field_number: 2 }';

  const beforeDefindexes = usedDefindexes(groups, DEF_TYPE_PAINTKIT_DEFINITION);
  const beforeOperations = usedDefindexes(groups, DEF_TYPE_PAINTKIT_OPERATION);
  const appended = spliceProtoDefs({ baseBytes: original, operation: sampleOperation, definition: sampleDefinition, mode: 'append' });
  assert.ok(!beforeDefindexes.has(appended.paintkitDefindex), `paint kit defindex ${appended.paintkitDefindex} was taken`);
  assert.ok(!beforeOperations.has(appended.operationDefindex), `operation defindex ${appended.operationDefindex} was taken`);

  fs.mkdirSync(STAGING, { recursive: true });
  const outputDir = fs.mkdtempSync(path.join(STAGING, 'protodefs-write-'));
  context.onTestFinished(() => fs.rmSync(outputDir, { recursive: true, force: true }));
  const splicedPath = path.join(outputDir, 'spliced_proto_defs.vpd');
  fs.writeFileSync(splicedPath, appended.bytes);
  const nodeAfterDefs = decodeType(root, parseContainerNode(splicedPath).byType, DEF_TYPE.PAINTKIT_DEFINITION);
  assert.equal(nodeAfterDefs.length, nodeDefs.length + 1, 'the independent Node reader sees one extra kit');
  const spliced = nodeAfterDefs.find((def) => def.header?.defindex === appended.paintkitDefindex);
  assert.ok(spliced, 'the Node reader finds the spliced kit by its new defindex');
  assert.equal(spliced.loc_desctoken, `9_${appended.paintkitDefindex}_field { field_number: 2 }`);
  assert.equal(spliced.operation_template?.defindex, appended.operationDefindex);

  // The pack ships a complete localization file, read back with the extraction pipeline's parser.
  const LOCALIZATION = path.join(PUBLIC_DATA, 'protodefs-loc', 'english.txt');
  if (!fs.existsSync(LOCALIZATION)) return;
  const originalLocBytes = new Uint8Array(fs.readFileSync(LOCALIZATION));
  const before = loadLocalization(LOCALIZATION);
  const decoded = decodeLocalization(originalLocBytes);
  assert.ok(decoded.hadBom, 'the shipped localization file is UTF-16LE with a BOM');
  assert.equal(Buffer.compare(Buffer.from(encodeLocalization(decoded)), Buffer.from(originalLocBytes)), 0, 'localization round trip is byte-exact');

  const readBack = (localization, fileName) => {
    const filePath = path.join(outputDir, fileName);
    fs.writeFileSync(filePath, encodeLocalization(localization));
    return loadLocalization(filePath);
  };
  const NAME = 'Test Paint Åé "quoted"';
  const added = readBack(setPaintkitName(decoded, appended.paintkitDefindex, NAME), 'english.txt');
  assert.equal(added.size, before.size + 1, 'adding a name adds exactly one token');
  assert.equal(added.get(paintkitNameToken(appended.paintkitDefindex).toLowerCase()), NAME.replace(/"/g, '\\"'));
  assert.deepEqual([...before].filter(([token, value]) => added.get(token) !== value), [], 'every pre-existing name is untouched');

  const existingDefindex = nodeDefs[5].header.defindex;
  const renamed = readBack(setPaintkitName(decoded, existingDefindex, 'Renamed Kit'), 'english_renamed.txt');
  assert.equal(renamed.size, before.size, 'renaming an existing kit does not add a token');
  assert.equal(renamed.get(paintkitNameToken(existingDefindex).toLowerCase()), 'Renamed Kit');
}, 120000);
