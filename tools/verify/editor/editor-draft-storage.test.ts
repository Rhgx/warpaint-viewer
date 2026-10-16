import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseCustomSourceFileRecord,
  parseEditorDraftRecord,
} from '../../../src/editor/draftStorage';

test('editor draft records validate their key and bundle shape', () => {
  const record = {
    version: 2,
    key: 'stock:250',
    kitId: 250,
    paintName: 'Rune War Paint',
    savedAt: 1_788_000_000_000,
    bundle: {
      definition: { header: { defindex: 250 } },
      operations: [{ header: { defindex: 249 }, operation_node: {} }],
      itemDefinitions: [],
      scopes: [],
    },
  };

  assert.deepEqual(parseEditorDraftRecord(record, record.key), record);
  assert.equal(parseEditorDraftRecord(record, 'stock:251'), null, 'a draft must not open for another paint');
  assert.equal(parseEditorDraftRecord({ ...record, version: 3 }, record.key), null, 'unknown schemas must be ignored');
  assert.equal(parseEditorDraftRecord({ ...record, bundle: { ...record.bundle, definition: null } }, record.key), null);
  assert.equal(
    parseEditorDraftRecord({ ...record, bundle: { ...record.bundle, operations: [] } }, record.key),
    null,
    'a bundle needs at least one operation',
  );
  assert.equal(
    parseEditorDraftRecord({
      ...record,
      bundle: { ...record.bundle, scopes: [{ weaponKey: 'c_flamethrower', wear: 0, operationIndex: 1 }] },
    }, record.key),
    null,
    'a scope must point at an operation the bundle holds',
  );
});

test('a version 1 draft opens as a single-operation bundle', () => {
  const definition = { header: { defindex: 250 } };
  const operation = { header: { defindex: 249 }, operation_node: {} };
  const legacy = {
    version: 1,
    key: 'stock:250',
    kitId: 250,
    paintName: 'Rune War Paint',
    savedAt: 1_788_000_000_000,
    messages: { definition, operation },
  };

  assert.deepEqual(parseEditorDraftRecord(legacy, legacy.key), {
    version: 2,
    key: 'stock:250',
    kitId: 250,
    paintName: 'Rune War Paint',
    savedAt: 1_788_000_000_000,
    bundle: { definition, operations: [operation], itemDefinitions: [], scopes: [] },
  });
  assert.equal(parseEditorDraftRecord({ ...legacy, messages: { definition } }, legacy.key), null, 'a legacy draft still needs its operation');
});

test('custom source records retain the imported files for the matching source', () => {
  const file = new File(['package bytes'], 'custom-warpaint.zip', { type: 'application/zip' });
  const record = {
    version: 1,
    key: 'package',
    savedAt: 1_788_000_000_000,
    files: [file],
  };

  assert.deepEqual(parseCustomSourceFileRecord(record, 'package'), record);
  assert.equal(parseCustomSourceFileRecord(record, 'definitions'), null);
  assert.equal(parseCustomSourceFileRecord({ ...record, files: [] }, 'package'), null);
  assert.equal(parseCustomSourceFileRecord({ ...record, files: ['not a file'] }, 'package'), null);
});
