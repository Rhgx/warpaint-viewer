// Contract verification for src/editor/jsonExport.ts.
//
// This intentionally uses the current JSON-fragment normalizer, rather than a
// second parser, so it catches export/import contract drift at the boundary the
// editor will expose to users.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { serializeProtoDefKitMessages } from '../../../src/editor/jsonExport';
import { normalizeProtoDefFragments } from '../../../src/protodefs/jsonFragments';

test('editor JSON export round-trip', () => {

// Both singleton and repeated protobuf shapes are intentional. Unknown fields
// model a newer game schema and must remain byte-for-byte JSON values through
// this editor boundary even before the viewer learns what they mean.
const kit = {
  operation: {
    header: {
      defindex: 812345,
      name: 'editor operation',
      variables: { name: '$singleton', value: 'one' },
      unknown_header: { string_value: 'preserved', numeric_value: 3.5 },
    },
    operation_node: {
      stage: {
        texture_lookup: {
          texture: { string: 'patterns/editor/main' },
          unknown_texture_field: ['keep', 7],
        },
      },
    },
    unknown_operation_field: { array: [{ string: 'one' }, { uint32: 2 }] },
  },
  definition: {
    header: { defindex: 812346, name: 'editor definition', variables: [{ name: '$array', value: 'many' }] },
    loc_desctoken: '9_812346_field { field_number: 2 }',
    operation_template: { defindex: 812345, type: 7 },
    has_team_textures: false,
    item: {
      item_definition_template: { defindex: 13, type: 8 },
      data: { can_apply_paintkit: true, unknown_data_field: 'still here' },
    },
    weapon_rocketlauncher: {
      item_definition_template: { defindex: 18, type: 8 },
      definition: [{ operation_template: { defindex: 812345, type: 7 } }],
      unknown_slot_field: { value: 42 },
    },
    unknown_definition_field: ['string', 19, { nested_unknown: true }],
  },
};
const original = structuredClone(kit);
const exported = serializeProtoDefKitMessages(kit, { name: 'My Paint' });

assert.deepStrictEqual(kit, original, 'serialization must not mutate the source kit');
assert.deepStrictEqual(
  [exported.operation.name, exported.definition.name],
  ['my_paint__operation.json', 'my_paint__definition.json'],
  'result names must be predictable and operation-first',
);
const hostileNamed = serializeProtoDefKitMessages(kit, { name: '../My:Paint\\Draft' });
assert.deepStrictEqual(
  [hostileNamed.operation.name, hostileNamed.definition.name],
  ['my_paint_draft__operation.json', 'my_paint_draft__definition.json'],
  'download names must not contain path separators or platform-invalid punctuation',
);
assert.equal(exported.fragments[0], exported.operation, 'paired result must expose the same operation fragment');
assert.equal(exported.fragments[1], exported.definition, 'paired result must expose the same definition fragment');
assert.ok(!exported.operation.text.includes('###') && !exported.definition.text.includes('###'), 'export must not emit placeholders');

const imported = normalizeProtoDefFragments([...exported.fragments]);
assert.equal(imported[0].kind, 'operation');
assert.equal(imported[1].kind, 'definition');
assert.deepStrictEqual(imported[0].value, kit.operation, 'operation must round-trip through current importer');
assert.deepStrictEqual(imported[1].value, kit.definition, 'definition must round-trip through current importer');
assert.ok(!Array.isArray(imported[0].value.header.variables), 'singleton objects must stay singleton objects');
assert.ok(Array.isArray(imported[1].value.header.variables), 'arrays must stay arrays');
assert.deepStrictEqual(imported[1].value.unknown_definition_field, kit.definition.unknown_definition_field, 'unknown fields must survive');

assert.throws(
  () => serializeProtoDefKitMessages({ ...kit, definition: { ...kit.definition, operation_template: { defindex: 1 } } }),
  /must match operation\.header\.defindex/,
  'mismatched operation ids must be rejected instead of exported inconsistently',
);

});
