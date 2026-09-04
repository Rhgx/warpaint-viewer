import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { Many, OperationMsg, OperationNodeMsg } from '../../../src/protodefs/messages';
import {
  graphToOperation,
  graphToOperationNodes,
  operationNodesToGraph,
  operationToGraph,
  operationGraphChildren,
} from '../../../src/editor/graph/operationGraph';
import { validateOperationGraph } from '../../../src/editor/graph/validation';

function texture(variable: string): OperationNodeMsg {
  return {
    stage: {
      texture_lookup: {
        texture: { variable },
        future_texture_field: { string: 'preserve-me' },
      } as unknown as NonNullable<NonNullable<OperationNodeMsg['stage']>['texture_lookup']>,
    },
    future_node_field: { value: 42 },
  } as unknown as OperationNodeMsg;
}

function select(): OperationNodeMsg {
  return {
    stage: {
      select: {
        groups: { variable: 'groups_texture' },
        select: [{ variable: 'group_1' }, { uint32: 0 }],
      },
    },
  };
}

function lerp(children: Many<OperationNodeMsg>): OperationNodeMsg {
  return {
    stage: {
      combine_lerp: {
        operation_node: children,
        future_combine_field: { string: 'preserve-me-too' },
      } as unknown as NonNullable<NonNullable<OperationNodeMsg['stage']>['combine_lerp']>,
    },
  } as unknown as OperationNodeMsg;
}

function operation(rootNodes: Many<OperationNodeMsg>): OperationMsg {
  return {
    header: { defindex: 123, name: 'graph-test' },
    operation_node: rootNodes,
    future_operation_field: { enabled: true },
  } as unknown as OperationMsg;
}

test('operation graph round trips raw messages, variable references, unknown fields, and order', () => {
  const original = operation({
    stage: {
      combine_lerp: {
        operation_node: [
          texture('background_texture'),
          texture('foreground_texture'),
          select(),
        ],
        future_combine_field: { string: 'keep' },
      } as unknown as NonNullable<NonNullable<OperationNodeMsg['stage']>['combine_lerp']>,
    },
    future_root_field: ['untouched'],
  } as unknown as OperationNodeMsg);

  const graph = operationToGraph(original, { pathPrefix: ['operation'] });
  assert.equal(graph.nodes.filter((node) => node.kind === 'combine_lerp').length, 1);
  assert.deepEqual(operationGraphChildren(graph, graph.roots[0]), [
    'operation-node:operation/operation_node/#0/stage/combine_lerp/operation_node/#0',
    'operation-node:operation/operation_node/#0/stage/combine_lerp/operation_node/#1',
    'operation-node:operation/operation_node/#0/stage/combine_lerp/operation_node/#2',
  ]);

  const roundTrip = graphToOperation(graph);
  assert.deepEqual(roundTrip, original);
  assert.deepEqual((roundTrip as unknown as { future_operation_field: unknown }).future_operation_field, { enabled: true });
  const root = roundTrip.operation_node as OperationNodeMsg;
  const rawStage = root.stage?.combine_lerp as unknown as { future_combine_field: unknown };
  assert.deepEqual(rawStage.future_combine_field, { string: 'keep' });
  const rawTexture = (rawStage as unknown as { operation_node: OperationNodeMsg[] }).operation_node[0];
  assert.equal(rawTexture.stage?.texture_lookup?.texture?.variable, 'background_texture');
  assert.deepEqual((rawTexture as unknown as { future_node_field: unknown }).future_node_field, { value: 42 });
});

test('graph preserves singleton and undefined Many shapes', () => {
  const singletonChild = texture('only_child');
  const singletonRoot = lerp({
    stage: {
      combine_lerp: {
        operation_node: {
          stage: {
            combine_add: {
              operation_node: [texture('a'), texture('b')],
            },
          },
        },
      },
    },
  } as unknown as OperationNodeMsg);
  const singletonOperation = operation(singletonRoot);
  const singletonGraph = operationToGraph(singletonOperation);
  const singletonRoundTrip = graphToOperation(singletonGraph);
  assert.equal(Array.isArray(singletonRoundTrip.operation_node), false);
  const singletonLerp = singletonRoundTrip.operation_node as OperationNodeMsg;
  assert.equal(Array.isArray(singletonLerp.stage?.combine_lerp?.operation_node), false);

  const undefinedGraph = operationNodesToGraph(undefined);
  assert.equal(undefinedGraph.rootShape, 'undefined');
  assert.equal(graphToOperationNodes(undefinedGraph), undefined);
  // Keep a reference in this test to ensure a valid leaf helper remains used
  // when the fixture is changed to an explicit singleton in the future.
  assert.equal(singletonChild.stage?.texture_lookup?.texture?.variable, 'only_child');
});

test('operation-template nodes remain opaque and locked', () => {
  const template: OperationNodeMsg = {
    operation_template: { defindex: 777, type: 7 },
    future_template_field: { owner: 'base-game' },
  } as unknown as OperationNodeMsg;
  const graph = operationToGraph(operation(template));
  const templateNode = graph.nodes.find((node) => node.kind === 'operation_template');
  assert.ok(templateNode);
  assert.equal(templateNode.locked, true);
  assert.equal(templateNode.outputType, 'unknown');
  assert.deepEqual(graphToOperation(graph), operation(template));
});

test('multiple roots connect to one synthetic output in authored order', () => {
  const graph = operationToGraph(operation([texture('first'), texture('second')]));
  assert.equal(graph.roots.length, 2);
  const outputEdges = graph.edges
    .filter((edge) => edge.target === graph.outputId)
    .sort((a, b) => a.inputIndex - b.inputIndex);
  assert.deepEqual(outputEdges.map((edge) => edge.source), graph.roots);
  assert.equal(validateOperationGraph(graph).valid, true);
});
