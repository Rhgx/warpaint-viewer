import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { OperationTemplateData, PaintkitEntry } from '../../../src/data/types';
import { customKitId } from '../../../src/protodefs/types';
import { operationFilterKits } from '../../../src/ui/catalog/operationFilter';

function kit(id: number, name: string): PaintkitEntry {
  return { id, name, collection: null, hasTeamTextures: false, weapons: [] };
}

const paintkits = [
  kit(400, 'Alpha'),
  kit(401, 'Beta'),
  kit(402, 'Gamma'),
  kit(403, 'Delta'),
  kit(customKitId(402), 'Imported Gamma'),
];

const data: OperationTemplateData = {
  templates: [],
  names: { '10': 'AO', '11': 'AO Glow', '12': 'Blend' },
  // The imported kit's id is offset, so it can only match by its own id.
  usage: { '10': [400, 401], '11': [402, customKitId(402)], '12': [403] },
};

test('op filter matches an exact operation name before substrings', () => {
  assert.deepEqual(operationFilterKits(paintkits, data, 'ao').map((k) => k.id), [400, 401]);
});

test('op filter matches substrings when no operation is named exactly', () => {
  assert.deepEqual(operationFilterKits(paintkits, data, 'glo').map((k) => k.id), [402]);
});

test('op filter is case-insensitive and trims the query', () => {
  assert.deepEqual(operationFilterKits(paintkits, data, '  Ao  ').map((k) => k.id), [400, 401]);
  assert.deepEqual(operationFilterKits(paintkits, data, 'BLEND').map((k) => k.id), [403]);
});

test('op filter never returns imported kits', () => {
  const ids = operationFilterKits(paintkits, data, 'glow').map((k) => k.id);
  assert.deepEqual(ids, [402]);
});

test('op filter returns nothing for an empty or unmatched query', () => {
  assert.deepEqual(operationFilterKits(paintkits, data, ''), []);
  assert.deepEqual(operationFilterKits(paintkits, data, '   '), []);
  assert.deepEqual(operationFilterKits(paintkits, data, 'missing'), []);
});
