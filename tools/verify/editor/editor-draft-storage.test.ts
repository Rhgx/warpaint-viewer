import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  parseCustomSourceFileRecord,
  parseEditorDraftRecord,
  selectWorkspaceDraftKeys,
} from '../../../src/editor/draftStorage';

test('editor draft records validate their key and message shape', () => {
  const record = {
    version: 1,
    key: 'stock:250',
    kitId: 250,
    paintName: 'Rune War Paint',
    savedAt: 1_788_000_000_000,
    messages: {
      definition: { header: { defindex: 250 } },
      operation: { header: { defindex: 249 }, operation_node: {} },
    },
  };

  assert.deepEqual(parseEditorDraftRecord(record, record.key), record);
  assert.equal(parseEditorDraftRecord(record, 'stock:251'), null, 'a draft must not open for another paint');
  assert.equal(parseEditorDraftRecord({ ...record, version: 2 }, record.key), null, 'unknown schemas must be ignored');
  assert.equal(parseEditorDraftRecord({ ...record, messages: { definition: null } }, record.key), null);
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

test('a workspace clear keeps stock drafts and removes only imported ones', () => {
  const keys = [
    'custom:9601:ghastly_guns.ZIP',
    'stock:250',
    'custom:9602:ghastly_guns.ZIP',
    'stock:311',
  ];

  assert.deepEqual(selectWorkspaceDraftKeys(keys), [
    'custom:9601:ghastly_guns.ZIP',
    'custom:9602:ghastly_guns.ZIP',
  ]);
  assert.deepEqual(selectWorkspaceDraftKeys(['stock:250']), [], 'a stock draft is never workspace state');
  assert.deepEqual(selectWorkspaceDraftKeys([7, 'custom:1:a']), ['custom:1:a'], 'non-string keys are not workspace state');
});
