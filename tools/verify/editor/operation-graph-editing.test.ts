import assert from 'node:assert/strict';
import { test } from 'vitest';
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
import type { OperationNodeMsg } from '../../../src/protodefs/messages';
import { addNode as add, dig, textureNode as texture } from '../fixtures';

function graphWithRoots(roots: OperationNodeMsg[]): OperationGraph {
  return operationToGraph({ header: { defindex: 1 }, operation_node: roots });
}

function nodeId(graph: OperationGraph, kind: string): string {
  const node = graph.nodes.find((candidate) => candidate.kind === kind);
  assert.ok(node);
  return node.id;
}

test('connects advisory texture/mask roles while guarding topology failures', () => {
  const graph = graphWithRoots([]);
  const textureResult = createOperationGraphNode(graph, 'texture_lookup', { nodeId: 'texture' });
  assert.ok(textureResult.ok);
  const selectResult = createOperationGraphNode(textureResult.graph, 'select', { nodeId: 'mask' });
  assert.ok(selectResult.ok);
  const lerpResult = createOperationGraphNode(selectResult.graph, 'combine_lerp', { nodeId: 'lerp' });
  assert.ok(lerpResult.ok);

  const badType = connectOperationGraph(lerpResult.graph, 'texture', 'lerp', 2);
  assert.equal(badType.ok, true);
  assert.equal(badType.diagnostics[0]?.code, 'invalid-port-type');
  assert.equal(badType.diagnostics[0]?.severity, 'warning');

  const maskEdge = connectOperationGraph(lerpResult.graph, 'mask', 'lerp', 1);
  assert.ok(maskEdge.ok);
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
  assert.ok(result.ok);
  assert.deepEqual(result.graph.nodes.find((node) => node.id === addId)?.raw, add([texture('a'), texture('b'), texture('c')]));
  assert.deepEqual(graphToOperation(result.graph).operation_node, [add([texture('c'), texture('a'), texture('b')])]);
});

test('duplicates a complete subtree with fresh IDs and leaves the original serialization untouched', () => {
  const graph = graphWithRoots([add([texture('a'), texture('b')])]);
  const addId = nodeId(graph, 'combine_add');
  const original = graphToOperation(graph);
  const result = duplicateOperationGraphSubtree(graph, addId);
  assert.ok(result.ok);
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
  assert.ok(result.ok);
  const remainingEdges = result.graph.edges.filter((edge) => edge.target === addId);
  assert.deepEqual(remainingEdges.map((edge) => edge.inputIndex).sort(), [0, 1]);
  assert.deepEqual(graphToOperation(result.graph).operation_node, [add([texture('a'), texture('c')])]);
});

test('a texture parameter edit updates its declaration, detaches, or reassigns while keeping unknown fields', () => {
  // Not passed inline, so the unknown future_field members are not excess-property errors.
  const original = {
    header: { defindex: 2, variables: [{ name: 'surface_texture', value: 'materials/old', inherit: true }] },
    operation_node: {
      stage: { texture_lookup: { texture: { variable: 'surface_texture', string: 'fallback', future_field: 'keep' }, future_field: 'keep' } },
      future_field: 'keep',
    },
  };
  const graph = operationToGraph(original);
  const textureId = nodeId(graph, 'texture_lookup');
  const edit = (value: Parameters<typeof setOperationGraphParameter>[1]['value']) => {
    const result = setOperationGraphParameter(graph, { nodeId: textureId, address: { field: 'texture' }, value });
    assert.ok(result.ok);
    return graphToOperation(result.graph);
  };
  const textureOf = (operation: unknown) => dig(operation, 'operation_node', 'stage', 'texture_lookup', 'texture');

  const declared = edit({ mode: 'literal', value: 'materials/new' });
  assert.deepEqual(declared.header.variables, [{ name: 'surface_texture', value: 'materials/new', inherit: true }]);
  assert.deepEqual(textureOf(declared), { variable: 'surface_texture', string: 'fallback', future_field: 'keep' });
  assert.equal(dig(declared, 'operation_node', 'future_field'), 'keep');
  assert.equal(dig(declared, 'operation_node', 'stage', 'texture_lookup', 'future_field'), 'keep');

  assert.deepEqual(textureOf(edit({ mode: 'literal', value: 'materials/detached', preserveVariable: false })), {
    string: 'materials/detached', future_field: 'keep',
  });
  assert.deepEqual(textureOf(edit({ mode: 'variable', name: 'new_texture' })), {
    variable: 'new_texture', string: 'fallback', future_field: 'keep',
  });
});

test('writes indexed select values while retaining the authored Many shape', () => {
  const graph = operationToGraph({
    header: { defindex: 4, variables: [{ name: 'group_value', value: '1' }] },
    operation_node: { stage: { select: { select: [{ variable: 'group_value' }, { uint32: 2 }] } } },
  });
  const result = setOperationGraphParameter(graph, {
    nodeId: nodeId(graph, 'select'),
    address: { field: 'select', index: 0 },
    value: { mode: 'literal', value: '3' },
  });
  assert.ok(result.ok);
  const edited = graphToOperation(result.graph);
  assert.deepEqual(edited.operation_node, { stage: { select: { select: [{ variable: 'group_value' }, { uint32: 2 }] } } });
  assert.deepEqual(edited.header.variables, [{ name: 'group_value', value: '3' }]);
});

test('variadic stages accept one input past their authored ports', () => {
  const base = graphWithRoots([add([texture('a'), texture('b')])]);
  const created = createOperationGraphNode(base, 'texture_lookup', { nodeId: 'spare' });
  assert.ok(created.ok);
  const graph = created.graph;
  const combine = graph.nodes.find((node) => node.kind === 'combine_add');
  assert.ok(combine);
  // The canvas draws exactly one trailing slot for these kinds, so the index
  // immediately past the authored ports has to be connectable.
  const grown = connectOperationGraph(graph, 'spare', combine.id, combine.inputPorts.length);
  assert.ok(grown.ok);
  const grownCombine = grown.graph.nodes.find((node) => node.kind === 'combine_add');
  assert.equal(grownCombine?.children.length, 3);
  // A fixed-arity stage has no such slot, so the same index is refused there.
  const lerp = createOperationGraphNode(graph, 'combine_lerp', { nodeId: 'lerp' });
  assert.ok(lerp.ok);
  const lerpNode = lerp.graph.nodes.find((node) => node.id === 'lerp');
  assert.ok(lerpNode);
  const refused = connectOperationGraph(lerp.graph, 'spare', 'lerp', lerpNode.inputPorts.length);
  assert.equal(refused.ok, false);
});
