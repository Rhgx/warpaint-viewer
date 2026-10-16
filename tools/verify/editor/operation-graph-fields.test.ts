import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  operationGraphVarFieldScalarKey,
  operationToGraph,
  setOperationGraphParameter,
} from '../../../src/editor/graph';
import {
  filterGraphOptions,
  parseNumberList,
  varFieldLiteralText,
  varFieldSupportsRange,
  type GraphComboboxOption,
} from '../../../src/ui/editor/operationGraphFieldValues';

test('reads the scalar slot and literal text a field actually occupies', () => {
  assert.equal(operationGraphVarFieldScalarKey(undefined), undefined);
  assert.equal(operationGraphVarFieldScalarKey({ string: '0 360' }), 'string');
  assert.equal(operationGraphVarFieldScalarKey({ bool: false }), 'bool');
  // A binding does not replace the literal the field still carries.
  assert.equal(operationGraphVarFieldScalarKey({ variable: 'Rotation', string: '0 90' }), 'string');

  assert.equal(varFieldLiteralText(undefined), '');
  assert.equal(varFieldLiteralText({ bool: true }), '1');
  assert.equal(varFieldLiteralText({ uint32: 12 }), '12');
});

test('offers a varying range only where the field can hold two numbers', () => {
  assert.equal(varFieldSupportsRange(undefined), true);
  assert.equal(varFieldSupportsRange({ string: '0 360' }), true);
  assert.equal(varFieldSupportsRange({ float: 1 }), false);
  // Bindings write the variable declaration, which is always text.
  assert.equal(varFieldSupportsRange({ variable: 'Rotation', float: 1 }), true);
});

test('a numeric field rejects range text, which is why the control hides Varies', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: [{ stage: { texture_lookup: { texture: { string: 'base' }, rotation: { float: 0 } } } }],
  });
  const node = graph.nodes.find((candidate) => candidate.kind === 'texture_lookup');
  assert.ok(node);
  const setRotation = (value: string | number) => setOperationGraphParameter(graph, { nodeId: node.id, address: { field: 'rotation' }, value: { mode: 'literal', value } });
  assert.throws(() => setRotation('0 360'));
  assert.equal(setRotation(90).ok, true);
});

test('splits authored ranges and rejects anything that is not one or two numbers', () => {
  assert.deepEqual(parseNumberList('0 360'), [0, 360]);
  assert.equal(parseNumberList(''), null);
  assert.equal(parseNumberList('0 1 2'), null);
  assert.equal(parseNumberList('patterns/paint_dirt'), null);
});

test('combobox filtering: suggestions first, catalogue on query, ranked by filename then prefix', () => {
  const options: readonly GraphComboboxOption[] = [
    { value: 'invisible/camo', label: 'invisible/camo', group: 'From pack.zip' },
    { value: 'models/weapons/c_pistol/p_pistol_camo', label: 'models/weapons/c_pistol/p_pistol_camo', group: 'Shipped', secondary: true },
    { value: 'patterns/camo/australia', label: 'patterns/camo/australia', group: 'Shipped', secondary: true },
    { value: 'camo/base', label: 'camo/base', group: 'Shipped', secondary: true },
  ];
  assert.deepEqual(filterGraphOptions(options, '').map((option) => option.value), ['invisible/camo']);
  // Searching reaches the whole library, with the paint's own files ranked first.
  assert.deepEqual(filterGraphOptions(options, 'camo').map((option) => option.value), [
    'invisible/camo', 'camo/base', 'models/weapons/c_pistol/p_pistol_camo', 'patterns/camo/australia',
  ]);
  assert.deepEqual(filterGraphOptions(options, 'nothing'), []);
  // With nothing else suggested, an empty query falls back to the catalogue.
  assert.deepEqual(filterGraphOptions(options.slice(1), '   '), options.slice(1));
});
