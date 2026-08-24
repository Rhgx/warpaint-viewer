import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { OperationNodeMsg } from '../../../src/protodefs/messages';
import { operationToGraph } from '../../../src/editor/graph/operationGraph';
import {
  summarizeOperationGraphDiagnostics,
  validateOperationGraph,
} from '../../../src/editor/graph/validation';

function texture(name: string): OperationNodeMsg {
  return { stage: { texture_lookup: { texture: { string: name } } } };
}

function select(): OperationNodeMsg {
  return { stage: { select: { groups: { string: 'groups' }, select: [{ uint32: 32 }] } } };
}

function lerp(children: OperationNodeMsg[]): OperationNodeMsg {
  return { stage: { combine_lerp: { operation_node: children } } };
}

test('validates a typed lerp graph', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: lerp([texture('background'), texture('foreground'), select()]),
  });
  const validation = validateOperationGraph(graph);
  assert.equal(validation.valid, true);
  assert.deepEqual(validation.diagnostics, []);
});

test('rejects cycles and shared outputs', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: { stage: { combine_add: { operation_node: [texture('a'), texture('b')] } } },
  });
  const root = graph.nodes.find((node) => node.kind === 'combine_add');
  const leaf = graph.nodes.find((node) => node.kind === 'texture_lookup');
  assert.ok(root);
  assert.ok(leaf);
  const edges = [...graph.edges, {
    id: 'cycle-edge',
    source: root.id,
    target: leaf.id,
    sourceHandle: 'output',
    targetHandle: 'input-0',
    inputIndex: 0,
    type: 'texture' as const,
  }];
  const validation = validateOperationGraph({ ...graph, edges });
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.code === 'cycle'));
  assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.code === 'shared-output'));
});

test('allows texture and mask role crossings with an advisory warning', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: lerp([texture('background'), texture('foreground'), texture('not-a-mask')]),
  });
  const validation = validateOperationGraph(graph);
  assert.equal(validation.valid, true);
  assert.ok(validation.diagnostics.some((diagnostic) => (
    diagnostic.code === 'invalid-port-type'
      && diagnostic.severity === 'warning'
      && diagnostic.message.includes('advisory')
  )));
});

test('allows a selector/mask stage to feed an apply-sticker surface', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: {
      stage: {
        apply_sticker: {
          sticker: [{ base: { string: 'sticker' } }],
          operation_node: select(),
        },
      },
    },
  });
  const validation = validateOperationGraph(graph);
  assert.equal(validation.valid, true);
  assert.ok(validation.diagnostics.some((diagnostic) => (
    diagnostic.severity === 'warning' && diagnostic.message.includes('RGBA data')
  )));
});

test('still rejects malformed connection indexes and arity', () => {
  const addGraph = operationToGraph({
    header: { defindex: 1 },
    operation_node: { stage: { combine_add: { operation_node: [texture('a'), texture('b')] } } },
  });
  const addRoot = addGraph.nodes.find((node) => node.kind === 'combine_add');
  assert.ok(addRoot);
  const malformed = {
    ...addGraph,
    edges: [...addGraph.edges, {
      id: 'bad-index-edge',
      source: addGraph.nodes.find((node) => node.kind === 'texture_lookup')?.id ?? 'missing',
      target: addRoot.id,
      sourceHandle: 'output',
      targetHandle: 'input-99',
      inputIndex: 99,
      type: 'texture' as const,
    }],
  };
  const malformedValidation = validateOperationGraph(malformed);
  assert.equal(malformedValidation.valid, false);
  assert.ok(malformedValidation.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-input-index'));

  const shortLerp = operationToGraph({
    header: { defindex: 1 },
    operation_node: lerp([texture('background'), texture('foreground')]),
  });
  const shortValidation = validateOperationGraph(shortLerp);
  assert.equal(shortValidation.valid, false);
  assert.ok(shortValidation.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-arity'));
});

test('rejects modified opaque operation-template references', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: { operation_template: { defindex: 77 } },
  });
  const template = graph.nodes.find((node) => node.kind === 'operation_template');
  assert.ok(template?.raw?.operation_template);
  template.raw.operation_template.defindex = 78;
  const validation = validateOperationGraph(graph);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.code === 'locked-reference-modified'));
});

test('reports missing roots and disconnected authored nodes', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: [texture('a'), texture('b')],
  });
  const withoutOutput = {
    ...graph,
    edges: graph.edges.filter((edge) => edge.target !== graph.outputId),
  };
  const validation = validateOperationGraph(withoutOutput);
  assert.equal(validation.valid, false);
  assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.code === 'missing-root'));
  assert.ok(validation.diagnostics.some((diagnostic) => diagnostic.code === 'orphan-node'));
});

test('summarizes a validation run as one line about the stages that are wrong', () => {
  const summary = summarizeOperationGraphDiagnostics([
    { severity: 'warning', message: 'Blend textures input 3 crosses the advisory mask/texture role.' },
    { severity: 'error', message: 'Texture lookup is not connected to a parent or Paint output.', nodeId: 'a' },
    { severity: 'error', message: 'Texture lookup is not on a path to Paint output.', nodeId: 'a' },
  ]);
  // Advisory warnings stay out of it, and one stage speaks once.
  assert.equal(summary, 'Texture lookup is not connected to a parent or Paint output.');

  assert.equal(summarizeOperationGraphDiagnostics([]), null);
  assert.equal(
    summarizeOperationGraphDiagnostics([{ severity: 'warning', message: 'Advisory only.' }]),
    null,
  );

  const many = summarizeOperationGraphDiagnostics([
    { severity: 'error', message: 'First is broken.', nodeId: 'a' },
    { severity: 'error', message: 'Second is broken.', nodeId: 'b' },
    { severity: 'error', message: 'Third is broken.', nodeId: 'c' },
    { severity: 'error', message: 'Fourth is broken.', nodeId: 'd' },
  ]);
  assert.equal(many, 'First is broken. Second is broken. (2 more)');
});
