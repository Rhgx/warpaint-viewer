import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ProtoDefJsonFragment } from '../../../src/protodefs/types';
import {
  definitionSetName,
  generatedPaintDefindex,
  renameGeneratedPaint,
  withoutGeneratedPaint,
} from '../../../src/protodefs/templatePaint';

function definitionText(defindex: number, name: string): string {
  return JSON.stringify({ header: { defindex, name, variables: [] }, has_team_textures: false }, null, 2);
}

const fragments: ProtoDefJsonFragment[] = [
  { name: 'community_operation.json', text: '{"header":{"defindex":900,"name":"op"}}' },
  { name: 'community_definition.json', text: '{"header":{"defindex":901,"name":"Community"}}' },
  { name: 'new_paint_443_operation.json', text: '{"header":{"defindex":902,"name":"custom_uv"},"operation_node":[]}' },
  { name: 'new_paint_443_definition.json', text: definitionText(443, 'New war paint') },
  { name: 'new_paint_444_definition.json', text: definitionText(444, 'Second paint') },
];

test('generated paint files are recognized by their exact names', () => {
  assert.equal(generatedPaintDefindex('new_paint_443_operation.json'), 443);
  assert.equal(generatedPaintDefindex('new_paint_443_definition.json'), 443);
  assert.equal(generatedPaintDefindex('community_definition.json'), null);
  assert.equal(generatedPaintDefindex('new_paint_443_extra.json'), null);
  assert.equal(generatedPaintDefindex('new_paint_x_definition.json'), null);
});

test('deleting a generated paint removes both of its files; generated files never rename the set', () => {
  const remaining = withoutGeneratedPaint(fragments, 443);
  assert.deepEqual(
    remaining.map((fragment) => fragment.name),
    ['community_operation.json', 'community_definition.json', 'new_paint_444_definition.json'],
  );
  const communityName = definitionSetName(['community_operation.json', 'community_definition.json']);
  assert.equal(definitionSetName(remaining.map((fragment) => fragment.name)), communityName);
  assert.equal(definitionSetName(fragments.map((fragment) => fragment.name)), communityName);
  assert.equal(definitionSetName(['new_paint_443_operation.json', 'new_paint_443_definition.json']), 'New war paints');
});

test('renaming a generated paint rewrites only its definition header name', () => {
  const renamed = renameGeneratedPaint(fragments, 443, 'Yeti Glow');
  assert.equal(renamed.length, fragments.length);
  renamed.forEach((fragment, index) => {
    const original = fragments[index];
    assert.equal(fragment.name, original.name);
    if (fragment.name === 'new_paint_443_definition.json') {
      assert.equal(fragment.text, definitionText(443, 'Yeti Glow'));
    } else {
      assert.equal(fragment.text, original.text, `${fragment.name} should be untouched`);
    }
  });
});

test('renaming fails loudly when a generated definition has no header', () => {
  assert.throws(() => renameGeneratedPaint(
    [{ name: 'new_paint_5_definition.json', text: '{"header":1}' }],
    5,
    'Renamed',
  ));
});
