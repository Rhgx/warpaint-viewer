import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { OperationNodeMsg } from '../../../src/protodefs/messages';
import {
  connectOperationGraph,
  createOperationGraphNode,
  deleteOperationGraphSubtree,
  duplicateOperationGraphSubtree,
  operationToGraph,
  reorderOperationGraphInputs,
  setOperationGraphParameter,
  type OperationGraph,
} from '../../../src/editor/graph';
import { graphToOperation } from '../../../src/editor/graph/operationGraph';

function texture(name: string): OperationNodeMsg {
  return { stage: { texture_lookup: { texture: { string: name } } } };
}

function add(children: OperationNodeMsg[]): OperationNodeMsg {
  return { stage: { combine_add: { operation_node: children } } };
}

function graphWithRoots(roots: OperationNodeMsg[]): OperationGraph {
  return operationToGraph({ header: { defindex: 1 }, operation_node: roots });
}

function nodeId(graph: OperationGraph, kind: string): string {
  const node = graph.nodes.find((candidate) => candidate.kind === kind);
  assert.ok(node);
  return node.id;
}

test('creates authored nodes immutably with safe minimal stages', () => {
  const graph = graphWithRoots([texture('base')]);
  const result = createOperationGraphNode(graph, 'apply_sticker');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(graph.nodes.length, 2);
  assert.equal(result.graph.nodes.length, 3);
  const created = result.graph.nodes.find((node) => node.id === result.value.nodeId);
  assert.equal(created?.kind, 'apply_sticker');
  assert.deepEqual(created?.raw, { stage: { apply_sticker: { operation_node: [] } } });
  assert.equal(created?.locked, false);
});

test('connects advisory texture/mask roles while guarding topology failures', () => {
  const graph = graphWithRoots([]);
  const textureResult = createOperationGraphNode(graph, 'texture_lookup', { nodeId: 'texture' });
  assert.equal(textureResult.ok, true);
  if (!textureResult.ok) return;
  const selectResult = createOperationGraphNode(textureResult.graph, 'select', { nodeId: 'mask' });
  assert.equal(selectResult.ok, true);
  if (!selectResult.ok) return;
  const lerpResult = createOperationGraphNode(selectResult.graph, 'combine_lerp', { nodeId: 'lerp' });
  assert.equal(lerpResult.ok, true);
  if (!lerpResult.ok) return;

  const badType = connectOperationGraph(lerpResult.graph, 'texture', 'lerp', 2);
  assert.equal(badType.ok, true);
  assert.equal(badType.diagnostics[0]?.code, 'invalid-port-type');
  assert.equal(badType.diagnostics[0]?.severity, 'warning');

  const maskEdge = connectOperationGraph(lerpResult.graph, 'mask', 'lerp', 1);
  assert.equal(maskEdge.ok, true);
  if (!maskEdge.ok) return;
  const duplicateParent = connectOperationGraph(maskEdge.graph, 'mask', 'lerp', 0);
  assert.equal(duplicateParent.ok, false);
  assert.equal(duplicateParent.diagnostics[0]?.code, 'multiple-parents');

  const occupied = connectOperationGraph(maskEdge.graph, 'texture', 'lerp', 1);
  assert.equal(occupied.ok, false);
  assert.equal(occupied.diagnostics[0]?.code, 'occupied-input');

  const badIndex = connectOperationGraph(maskEdge.graph, 'texture', 'lerp', 3);
  assert.equal(badIndex.ok, false);
  assert.equal(badIndex.diagnostics[0]?.code, 'invalid-input-index');

  const cycle = connectOperationGraph(maskEdge.graph, 'lerp', 'lerp', 0);
  assert.equal(cycle.ok, false);
  assert.equal(cycle.diagnostics[0]?.code, 'cycle');
});

test('reorders variadic inputs without changing authored raw fields', () => {
  const graph = graphWithRoots([add([texture('a'), texture('b'), texture('c')])]);
  const addId = nodeId(graph, 'combine_add');
  const children = graph.edges
    .filter((edge) => edge.target === addId)
    .sort((left, right) => left.inputIndex - right.inputIndex)
    .map((edge) => edge.source);
  const result = reorderOperationGraphInputs(graph, addId, [children[2] ?? '', children[0] ?? '', children[1] ?? '']);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const rawRoot = result.graph.nodes.find((node) => node.id === addId)?.raw;
  const ordered = rawRoot?.stage?.combine_add?.operation_node;
  assert.deepEqual(
    (Array.isArray(ordered) ? ordered : []).map((node) => node.stage?.texture_lookup?.texture?.string),
    ['a', 'b', 'c'],
  );
  const serialized = graphToOperation(result.graph);
  const serializedChildren = serialized.operation_node as OperationNodeMsg[];
  const serializedInputs = serializedChildren[0]?.stage?.combine_add?.operation_node;
  assert.deepEqual(
    (Array.isArray(serializedInputs) ? serializedInputs : []).map((node) => node.stage?.texture_lookup?.texture?.string),
    ['c', 'a', 'b'],
  );
});

test('duplicates a complete subtree with fresh IDs and leaves the original serialization untouched', () => {
  const graph = graphWithRoots([add([texture('a'), texture('b')])]);
  const addId = nodeId(graph, 'combine_add');
  const original = graphToOperation(graph);
  const result = duplicateOperationGraphSubtree(graph, addId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.nodeIds.length, 3);
  assert.equal(new Set(result.value.nodeIds).size, 3);
  assert.equal(result.graph.nodes.length, graph.nodes.length + 3);
  assert.deepEqual(graphToOperation(result.graph), original);
  assert.notEqual(result.value.rootId, addId);
});

test('deletes a subtree while compacting variadic inputs when two remain', () => {
  const graph = graphWithRoots([add([texture('a'), texture('b'), texture('c')])]);
  const addId = nodeId(graph, 'combine_add');
  const childEdges = graph.edges
    .filter((edge) => edge.target === addId)
    .sort((left, right) => left.inputIndex - right.inputIndex);
  const result = deleteOperationGraphSubtree(graph, childEdges[1]?.source ?? 'missing');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const remainingEdges = result.graph.edges
    .filter((edge) => edge.target === addId)
    .sort((left, right) => left.inputIndex - right.inputIndex);
  assert.deepEqual(remainingEdges.map((edge) => edge.inputIndex), [0, 1]);
  const serializedRoot = (graphToOperation(result.graph).operation_node as OperationNodeMsg[])[0];
  const inputs = serializedRoot.stage?.combine_add?.operation_node;
  assert.deepEqual(
    (Array.isArray(inputs) ? inputs : []).map((node) => node.stage?.texture_lookup?.texture?.string),
    ['a', 'c'],
  );
});

test('updates a texture source variable declaration without replacing its reference or unknown fields', () => {
  const original = {
    header: {
      defindex: 2,
      variables: [{ name: 'surface_texture', value: 'materials/old', inherit: true }],
    },
    operation_node: {
      stage: {
        texture_lookup: {
          texture: { variable: 'surface_texture' },
          future_texture_field: { string: 'keep' },
        } as unknown as NonNullable<NonNullable<OperationNodeMsg['stage']>['texture_lookup']>,
      },
      future_node_field: { enabled: true },
    } as unknown as OperationNodeMsg,
  };
  const graph = operationToGraph(original);
  const textureId = nodeId(graph, 'texture_lookup');
  const result = setOperationGraphParameter(graph, {
    nodeId: textureId,
    address: { field: 'texture' },
    value: { mode: 'literal', value: 'materials/new' },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edited = graphToOperation(result.graph);
  const editedNode = edited.operation_node as OperationNodeMsg;
  assert.deepEqual(editedNode.stage?.texture_lookup?.texture, { variable: 'surface_texture' });
  assert.deepEqual((editedNode as unknown as { future_node_field: unknown }).future_node_field, { enabled: true });
  const editedTextureStage = editedNode.stage?.texture_lookup;
  assert.ok(editedTextureStage);
  assert.deepEqual(
    (editedTextureStage as unknown as { future_texture_field: unknown }).future_texture_field,
    { string: 'keep' },
  );
  const variables = edited.header.variables;
  assert.equal(Array.isArray(variables), true);
  assert.equal((variables as { name: string; value?: string }[])[0]?.value, 'materials/new');
  assert.equal((variables as { name: string; inherit?: boolean }[])[0]?.inherit, true);
});

test('supports explicit literal detachment and variable reassignment while retaining field shape', () => {
  const original = {
    header: { defindex: 3, variables: [{ name: 'old_texture', value: 'materials/old' }] },
    operation_node: {
      stage: {
        texture_lookup: {
          texture: {
            variable: 'old_texture',
            string: 'fallback',
            future_texture_field: { string: 'keep' },
          },
        } as unknown as NonNullable<NonNullable<OperationNodeMsg['stage']>['texture_lookup']>,
      },
    } as unknown as OperationNodeMsg,
  };
  const graph = operationToGraph(original);
  const textureId = nodeId(graph, 'texture_lookup');
  const detached = setOperationGraphParameter(graph, {
    nodeId: textureId,
    address: { field: 'texture' },
    value: { mode: 'literal', value: 'materials/detached', preserveVariable: false },
  });
  assert.equal(detached.ok, true);
  if (!detached.ok) return;
  const detachedNode = graphToOperation(detached.graph).operation_node as OperationNodeMsg;
  const detachedField = detachedNode.stage?.texture_lookup?.texture as unknown as Record<string, unknown>;
  assert.equal(detachedField.variable, undefined);
  assert.equal(detachedField.string, 'materials/detached');
  assert.deepEqual(detachedField.future_texture_field, { string: 'keep' });

  const reassigned = setOperationGraphParameter(graph, {
    nodeId: textureId,
    address: { field: 'texture' },
    value: { mode: 'variable', name: 'new_texture' },
  });
  assert.equal(reassigned.ok, true);
  if (!reassigned.ok) return;
  const reassignedNode = graphToOperation(reassigned.graph).operation_node as OperationNodeMsg;
  const reassignedField = reassignedNode.stage?.texture_lookup?.texture as unknown as Record<string, unknown>;
  assert.equal(reassignedField.variable, 'new_texture');
  assert.equal(reassignedField.string, 'fallback');
  assert.deepEqual(reassignedField.future_texture_field, { string: 'keep' });
});

test('writes indexed select values while retaining the authored Many shape', () => {
  const graph = operationToGraph({
    header: { defindex: 4, variables: [{ name: 'group_value', value: '1' }] },
    operation_node: { stage: { select: { select: [{ variable: 'group_value' }, { uint32: 2 }] } } },
  });
  const selectId = nodeId(graph, 'select');
  const result = setOperationGraphParameter(graph, {
    nodeId: selectId,
    address: { field: 'select', index: 0 },
    value: { mode: 'literal', value: '3' },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edited = graphToOperation(result.graph);
  const node = edited.operation_node as OperationNodeMsg;
  const values = node.stage?.select?.select;
  assert.equal(Array.isArray(values), true);
  assert.deepEqual(values, [{ variable: 'group_value' }, { uint32: 2 }]);
  assert.equal((edited.header.variables as { value?: string }[])[0]?.value, '3');
});

test('variadic stages accept one input past their authored ports', () => {
  const base = graphWithRoots([add([texture('a'), texture('b')])]);
  const created = createOperationGraphNode(base, 'texture_lookup', { nodeId: 'spare' });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const graph = created.graph;
  const combine = graph.nodes.find((node) => node.kind === 'combine_add');
  assert.ok(combine);
  // The canvas draws exactly one trailing slot for these kinds, so the index
  // immediately past the authored ports has to be connectable.
  const grown = connectOperationGraph(graph, 'spare', combine.id, combine.inputPorts.length);
  assert.equal(grown.ok, true);
  if (!grown.ok) return;
  const grownCombine = grown.graph.nodes.find((node) => node.kind === 'combine_add');
  assert.equal(grownCombine?.children.length, 3);
  // A fixed-arity stage has no such slot, so the same index is refused there.
  const lerp = createOperationGraphNode(graph, 'combine_lerp', { nodeId: 'lerp' });
  assert.equal(lerp.ok, true);
  if (!lerp.ok) return;
  const lerpNode = lerp.graph.nodes.find((node) => node.id === 'lerp');
  assert.ok(lerpNode);
  const refused = connectOperationGraph(lerp.graph, 'spare', 'lerp', lerpNode.inputPorts.length);
  assert.equal(refused.ok, false);
});
