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
  splitGraphOptionLabel,
  varFieldLiteralText,
  varFieldSupportsRange,
  type GraphComboboxOption,
} from '../../../src/ui/workbench/operationGraphFieldValues';

test('reads the scalar slot and literal text a field actually occupies', () => {
  assert.equal(operationGraphVarFieldScalarKey(undefined), undefined);
  assert.equal(operationGraphVarFieldScalarKey({}), undefined);
  assert.equal(operationGraphVarFieldScalarKey({ string: '0 360' }), 'string');
  assert.equal(operationGraphVarFieldScalarKey({ float: 1.5 }), 'float');
  assert.equal(operationGraphVarFieldScalarKey({ bool: false }), 'bool');
  // A binding does not replace the literal the field still carries.
  assert.equal(operationGraphVarFieldScalarKey({ variable: 'Rotation', string: '0 90' }), 'string');

  assert.equal(varFieldLiteralText(undefined), '');
  assert.equal(varFieldLiteralText({ string: 'patterns/paint_dirt' }), 'patterns/paint_dirt');
  assert.equal(varFieldLiteralText({ bool: true }), '1');
  assert.equal(varFieldLiteralText({ uint32: 12 }), '12');
});

test('offers a varying range only where the field can hold two numbers', () => {
  assert.equal(varFieldSupportsRange(undefined), true);
  assert.equal(varFieldSupportsRange({ string: '0 360' }), true);
  assert.equal(varFieldSupportsRange({ float: 1 }), false);
  assert.equal(varFieldSupportsRange({ bool: true }), false);
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
  assert.throws(() => setOperationGraphParameter(graph, {
    nodeId: node.id,
    address: { field: 'rotation' },
    value: { mode: 'literal', value: '0 360' },
  }));
  const fixed = setOperationGraphParameter(graph, {
    nodeId: node.id,
    address: { field: 'rotation' },
    value: { mode: 'literal', value: 90 },
  });
  assert.equal(fixed.ok, true);
});

test('splits authored ranges and rejects anything that is not one or two numbers', () => {
  assert.deepEqual(parseNumberList('0 360'), [0, 360]);
  assert.deepEqual(parseNumberList('  1.5  '), [1.5]);
  assert.equal(parseNumberList(''), null);
  assert.equal(parseNumberList('0 1 2'), null);
  assert.equal(parseNumberList('patterns/paint_dirt'), null);
});

test('offers only suggestions until a query opens the background catalogue', () => {
  const options: readonly GraphComboboxOption[] = [
    { value: 'invisible/base', label: 'invisible/base', group: 'In this paint' },
    { value: 'invisible/camo', label: 'invisible/camo', group: 'From pack.zip' },
    { value: 'patterns/camo/australia', label: 'patterns/camo/australia', group: 'Shipped', secondary: true },
    { value: 'patterns/paint_dirt', label: 'patterns/paint_dirt', group: 'Shipped', secondary: true },
  ];
  assert.deepEqual(
    filterGraphOptions(options, '').map((option) => option.value),
    ['invisible/base', 'invisible/camo'],
  );
  // Searching reaches the whole library, with the paint's own files ranked first.
  assert.deepEqual(
    filterGraphOptions(options, 'camo').map((option) => option.value),
    ['invisible/camo', 'patterns/camo/australia'],
  );
});

test('falls back to the background catalogue when nothing else is suggested', () => {
  const options: readonly GraphComboboxOption[] = [
    { value: 'patterns/paint_dirt', label: 'patterns/paint_dirt', secondary: true },
  ];
  assert.deepEqual(filterGraphOptions(options, ''), options);
});

test('ranks combobox matches by filename, then prefix, then anything containing the query', () => {
  const options: readonly GraphComboboxOption[] = [
    { value: 'models/weapons/c_pistol/p_pistol_camo', label: 'models/weapons/c_pistol/p_pistol_camo' },
    { value: 'patterns/camo/australia', label: 'patterns/camo/australia' },
    { value: 'camo/base', label: 'camo/base' },
  ];
  assert.deepEqual(
    filterGraphOptions(options, 'camo').map((option) => option.value),
    ['camo/base', 'models/weapons/c_pistol/p_pistol_camo', 'patterns/camo/australia'],
  );
  // An empty query keeps the caller's grouping order untouched.
  assert.deepEqual(filterGraphOptions(options, '   '), options);
  assert.deepEqual(filterGraphOptions(options, 'nothing'), []);
});

test('leads a path-shaped option with its filename and keeps the folder beside it', () => {
  assert.deepEqual(splitGraphOptionLabel('patterns/camo/australia'), {
    name: 'australia',
    directory: 'patterns/camo',
  });
  assert.deepEqual(splitGraphOptionLabel('weapon_albedo'), { name: 'weapon_albedo' });
});
