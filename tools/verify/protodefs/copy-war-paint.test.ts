import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import type { Manifest } from '../../../src/data/types';
import {
  decodeProtoDefs,
  decodeProtoDefsFromJson,
  extractKitMessages,
  resolveKitRecipe,
} from '../../../src/protodefs/decoder';
import { buildCopiedWarPaint, generatedPaintDefindex, nextWarPaintIds } from '../../../src/protodefs/templatePaint';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
// 300 Yeti Coated is a top-level paint: one operation shared by every weapon and wear.
const SOURCE_DEFINDEX = 300;

test('a copy of a stock paint decodes as a new paint with the original recipe', () => {
  const weaponsByItemDef: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
  const baseBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-base.bin')));
  const options = { weaponsByItemDef, builtInIds: manifest.paintkits.map((kit) => kit.id) };
  const full = decodeProtoDefs(new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-full.bin'))), options);

  const original = full.index.kits.find((kit) => kit.defindex === SOURCE_DEFINDEX);
  assert.ok(original, `kit ${SOURCE_DEFINDEX} is missing from the full container`);
  const messages = extractKitMessages(full, SOURCE_DEFINDEX);
  assert.ok(messages, 'the stock paint should export a top-level operation');
  const exported = structuredClone(messages);

  const ids = nextWarPaintIds({
    paintDefindexes: options.builtInIds,
    operationDefindexes: [...full.ctx.opByIdx.keys()],
  });
  const fragments = buildCopiedWarPaint({
    messages,
    defindex: ids.defindex,
    operationDefindex: ids.operationDefindex,
    name: 'Yeti Coated copy',
  });

  assert.deepEqual(messages, exported, 'the exported messages must not be mutated');
  assert.deepEqual(
    fragments.map((fragment) => generatedPaintDefindex(fragment.name)),
    [ids.defindex, ids.defindex],
    'both copied files should be recognized as the same generated paint',
  );

  // Recipes alone would also match a copy that still points at the stock operation, so check the ids directly.
  const operationFile: { header: { defindex: number } } = JSON.parse(fragments[0].text);
  const definitionFile: { header: { defindex: number }; operation_template: { defindex: number } } = JSON.parse(fragments[1].text);
  assert.equal(operationFile.header.defindex, ids.operationDefindex);
  assert.equal(definitionFile.header.defindex, ids.defindex);
  assert.equal(definitionFile.operation_template?.defindex, ids.operationDefindex);

  const decoded = decodeProtoDefsFromJson(baseBytes, fragments, options);
  const kit = decoded.index.kits.find((entry) => entry.defindex === ids.defindex);
  assert.ok(kit, 'the copy is not in the decoded index');
  assert.equal(kit.isNew, true, 'the copy should be treated as new');
  assert.equal(kit.name, 'Yeti Coated copy');
  assert.deepEqual(kit.weapons, original.weapons, 'the copy should paint the same weapons');

  const weaponKey = original.weapons[0];
  const copied = resolveKitRecipe(decoded, ids.defindex, weaponKey, 'red', 0);
  assert.ok(copied, `the copy does not resolve for ${weaponKey}`);
  assert.deepEqual(copied, resolveKitRecipe(full, SOURCE_DEFINDEX, weaponKey, 'red', 0));
});
