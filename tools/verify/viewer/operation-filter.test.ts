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

test('op filter: exact name before substrings, trimmed and case-insensitive, no imported kits', () => {
  const ids = (query: string) => operationFilterKits(paintkits, data, query).map((k) => k.id);
  assert.deepEqual(ids('ao'), [400, 401]);
  assert.deepEqual(ids('  Ao  '), [400, 401]);
  assert.deepEqual(ids('glo'), [402]);
  assert.deepEqual(ids('   '), []);
});
