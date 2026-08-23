import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { OperationNodeMsg } from '../../../src/protodefs/messages';
import { operationNodesToGraph } from '../../../src/editor/graph/operationGraph';
import {
  layoutOperationGraph,
  type OperationGraphNodeDimensions,
} from '../../../src/editor/graph/layout';

function texture(name: string): OperationNodeMsg {
  return { stage: { texture_lookup: { texture: { string: name } } } };
}

function add(children: readonly OperationNodeMsg[]): OperationNodeMsg {
  return { stage: { combine_add: { operation_node: [...children] } } };
}

function assertNoOverlap(
  graph: ReturnType<typeof operationNodesToGraph>,
  layout: ReturnType<typeof layoutOperationGraph>,
  dimensions: Readonly<Record<string, OperationGraphNodeDimensions>>,
): void {
  const authored = graph.nodes.filter((node) => node.kind !== 'output');
  for (let leftIndex = 0; leftIndex < authored.length; leftIndex += 1) {
    const left = authored[leftIndex];
    const leftPosition = layout[left.id];
    const leftSize = dimensions[left.id];
    assert.ok(leftPosition);
    assert.ok(leftSize);
    for (let rightIndex = leftIndex + 1; rightIndex < authored.length; rightIndex += 1) {
      const right = authored[rightIndex];
      const rightPosition = layout[right.id];
      const rightSize = dimensions[right.id];
      assert.ok(rightPosition);
      assert.ok(rightSize);
      const separatedHorizontally = leftPosition.x + leftSize.width <= rightPosition.x
        || rightPosition.x + rightSize.width <= leftPosition.x;
      const separatedVertically = leftPosition.y + leftSize.height <= rightPosition.y
        || rightPosition.y + rightSize.height <= leftPosition.y;
      assert.equal(separatedHorizontally || separatedVertically, true, `${left.id} overlaps ${right.id}`);
    }
  }
}

test('measured layout keeps large preview nodes separated in every column', () => {
  const graph = operationNodesToGraph([add([texture('a'), texture('b'), texture('c')]), texture('d')]);
  const dimensions: Record<string, OperationGraphNodeDimensions> = {};
  for (const node of graph.nodes) {
    dimensions[node.id] = node.kind === 'output'
      ? { width: 220, height: 90 }
      : { width: node.kind === 'combine_add' ? 260 : 240, height: node.label.includes('Texture') ? 420 : 250 };
  }

  const layout = layoutOperationGraph(graph, {
    horizontalGap: 24,
    verticalGap: 16,
    outputGap: 32,
    nodeDimensions: dimensions,
  });

  assertNoOverlap(graph, layout, dimensions);
  assert.equal(layout[graph.outputId].x > layout[graph.roots[0]].x, true);
});

test('preview height changes move following nodes without changing authored order', () => {
  const graph = operationNodesToGraph([add([texture('a'), texture('b'), texture('c')])]);
  const dimensions: Record<string, OperationGraphNodeDimensions> = {};
  for (const node of graph.nodes) dimensions[node.id] = { width: 240, height: 120 };
  const first = layoutOperationGraph(graph, { verticalGap: 20, nodeDimensions: dimensions });
  const sourceIds = graph.edges
    .filter((edge) => edge.target === graph.roots[0])
    .sort((left, right) => left.inputIndex - right.inputIndex)
    .map((edge) => edge.source);
  dimensions[sourceIds[1]] = { width: 240, height: 620 };
  const second = layoutOperationGraph(graph, { verticalGap: 20, nodeDimensions: dimensions });

  assert.equal(second[sourceIds[0]].y, first[sourceIds[0]].y);
  assert.equal(second[sourceIds[1]].y, first[sourceIds[1]].y);
  assert.equal(second[sourceIds[2]].y > first[sourceIds[2]].y, true);
  assert.equal(second[sourceIds[2]].y >= second[sourceIds[1]].y + 640, true);
});

test('unmeasured layout remains deterministic and preserves fixed-gap x coordinates', () => {
  const graph = operationNodesToGraph([add([texture('a'), texture('b')])]);
  const options = { horizontalGap: 100, verticalGap: 30, outputGap: 20 };
  const first = layoutOperationGraph(graph, options);
  const second = layoutOperationGraph(graph, options);
  assert.deepEqual(first, second);
  assert.equal(first[graph.roots[0]].x, 100);
  assert.equal(first[graph.outputId].x, 220);
});
