import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RecipeNode } from '../../../src/compositor/types';
import { operationToGraph, type OperationGraph } from '../../../src/editor/graph';
import { mapOperationGraphNodeToRecipe } from '../../../src/editor/graph/previews';
import { addNode as add, selectNode, textureNode as texture } from '../fixtures';

const recipeTexture = (name: string): RecipeNode => ({ type: 'texture_lookup', texture: name });
const idOf = (graph: OperationGraph, kind: string, nth = 0) => {
  const id = graph.nodes.filter((node) => node.kind === kind)[nth]?.id;
  assert.ok(id, `graph should have ${kind} #${nth}`);
  return id;
};
const mapsTo = (graph: OperationGraph, nodeId: string, recipeRoots: RecipeNode | RecipeNode[]) => {
  const mapping = mapOperationGraphNodeToRecipe(graph, nodeId, { recipeRoots });
  assert.ok(mapping.ok, `node ${nodeId} should map`);
  return mapping.recipe;
};
const unavailable = (graph: OperationGraph, nodeId: string, recipeRoots: RecipeNode) => {
  const mapping = mapOperationGraphNodeToRecipe(graph, nodeId, { recipeRoots });
  assert.ok(!mapping.ok);
  return mapping.reason;
};

test('authored nodes map to the resolved subtree in authored order, with sibling templates as wildcards', () => {
  const graph = operationToGraph({ header: { defindex: 1 }, operation_node: add([texture('background'), texture('foreground')]) });
  const recipe: RecipeNode = { type: 'combine_add', nodes: [recipeTexture('resolved-background'), recipeTexture('resolved-foreground')] };
  assert.equal(mapsTo(graph, graph.roots[0], recipe), recipe);
  assert.deepEqual(mapsTo(graph, idOf(graph, 'texture_lookup', 0), recipe), recipeTexture('resolved-background'));
  assert.deepEqual(mapsTo(graph, idOf(graph, 'texture_lookup', 1), recipe), recipeTexture('resolved-foreground'));

  const roots = operationToGraph({ header: { defindex: 1 }, operation_node: [texture('first'), selectNode(8)] });
  const select: RecipeNode = { type: 'select', groups: 'resolved-groups', select: [8] };
  assert.equal(mapsTo(roots, idOf(roots, 'select'), [recipeTexture('first-resolved'), select]), select);

  const templated = operationToGraph({
    header: { defindex: 1 },
    operation_node: add([{ operation_template: { defindex: 77 } }, texture('authored-sibling')]),
  });
  const expanded: RecipeNode = { type: 'combine_add', nodes: [recipeTexture('expanded-template'), recipeTexture('resolved-sibling')] };
  assert.equal(mapsTo(templated, templated.roots[0], expanded), expanded);
  assert.deepEqual(mapsTo(templated, idOf(templated, 'texture_lookup'), expanded), recipeTexture('resolved-sibling'));
  assert.equal(unavailable(templated, idOf(templated, 'operation_template'), expanded), 'opaque-operation-template');
});

test('templates, structural mismatches and the output node have no preview', () => {
  const template = operationToGraph({ header: { defindex: 1 }, operation_node: { operation_template: { defindex: 77 } } });
  assert.equal(unavailable(template, template.roots[0], recipeTexture('expanded')), 'opaque-operation-template');

  const graph = operationToGraph({ header: { defindex: 1 }, operation_node: add([texture('a'), texture('b')]) });
  assert.equal(unavailable(graph, graph.roots[0], { type: 'combine_add', nodes: [recipeTexture('only-one')] }), 'child-count-mismatch');
  assert.equal(unavailable(graph, graph.outputId, { type: 'combine_add', nodes: [recipeTexture('a'), recipeTexture('b')] }), 'output-node');
});
