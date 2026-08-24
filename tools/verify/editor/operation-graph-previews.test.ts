import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';
import { test } from 'vitest';
import type { OperationMsg, OperationNodeMsg } from '../../../src/protodefs/messages';
import type { RecipeNode } from '../../../src/compositor/types';
import {
  createOperationGraphObjectUrl,
  mapOperationGraphNodeToRecipe,
  exportOperationGraphVtf,
  type OperationGraphRenderLease,
} from '../../../src/editor/graph/previews';
import { operationToGraph } from '../../../src/editor/graph/operationGraph';
import { encodeVtf } from '../../../src/export/vtfEncode';
import { decodeProtoDefsFromJson, extractKitMessages, resolveKitRecipe } from '../../../src/protodefs/decoder';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function fixtureFragments(filePath: string): Promise<Array<{ name: string; text: string }>> {
  const reader = new ZipReader(new BlobReader(new Blob([fs.readFileSync(filePath)])));
  try {
    const entries = await reader.getEntries();
    return Promise.all(entries
      .filter((entry) => !entry.directory && 'getData' in entry && entry.filename.toLowerCase().endsWith('.json'))
      .map(async (entry) => {
        if (!('getData' in entry)) throw new Error(`Fixture entry ${entry.filename} cannot be read.`);
        return { name: entry.filename, text: await entry.getData(new TextWriter()) };
      }));
  } finally {
    await reader.close();
  }
}

function fixturePaintkitIds(value: unknown): number[] {
  if (!value || typeof value !== 'object' || !('paintkits' in value) || !Array.isArray(value.paintkits)) return [];
  return value.paintkits.flatMap((kit) => (
    kit && typeof kit === 'object' && 'id' in kit && typeof kit.id === 'number' ? [kit.id] : []
  ));
}

function texture(name: string): OperationNodeMsg {
  return { stage: { texture_lookup: { texture: { string: name } } } };
}

function select(): OperationNodeMsg {
  return { stage: { select: { groups: { string: 'groups' }, select: [{ uint32: 8 }] } } };
}

function add(children: OperationNodeMsg[]): OperationNodeMsg {
  return { stage: { combine_add: { operation_node: children } } };
}

function recipeTexture(name: string): RecipeNode {
  return { type: 'texture_lookup', texture: name };
}

test('maps ordered authored inputs to the matching resolved recipe subtree', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: add([texture('background'), texture('foreground')]),
  });
  const rootId = graph.roots[0];
  assert.ok(rootId);
  const children = graph.nodes.filter((node) => node.kind === 'texture_lookup');
  assert.equal(children.length, 2);

  const recipe: RecipeNode = {
    type: 'combine_add',
    nodes: [recipeTexture('resolved-background'), recipeTexture('resolved-foreground')],
  };
  const rootMapping = mapOperationGraphNodeToRecipe(graph, rootId, { recipeRoots: recipe });
  assert.equal(rootMapping.ok, true);
  if (!rootMapping.ok) return;
  assert.equal(rootMapping.recipe, recipe);
  assert.equal(rootMapping.nodeIds.length, 3);

  const firstMapping = mapOperationGraphNodeToRecipe(graph, children[0]!.id, { recipeRoots: recipe });
  assert.equal(firstMapping.ok, true);
  if (!firstMapping.ok) return;
  assert.equal(firstMapping.recipe.type, 'texture_lookup');
  assert.equal(firstMapping.recipe.texture, 'resolved-background');

  const secondMapping = mapOperationGraphNodeToRecipe(graph, children[1]!.id, { recipeRoots: recipe });
  assert.equal(secondMapping.ok, true);
  if (!secondMapping.ok) return;
  assert.equal(secondMapping.recipe.type, 'texture_lookup');
  assert.equal(secondMapping.recipe.texture, 'resolved-foreground');
});

test('maps select leaves and multiple operation roots in authored order', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: [texture('first'), select()],
  });
  const selectId = graph.nodes.find((node) => node.kind === 'select')?.id;
  assert.ok(selectId);
  const mapping = mapOperationGraphNodeToRecipe(graph, selectId, {
    recipeRoots: [recipeTexture('first-resolved'), { type: 'select', groups: 'resolved-groups', select: [8] }],
  });
  assert.equal(mapping.ok, true);
  if (!mapping.ok) return;
  assert.equal(mapping.recipe.type, 'select');
  assert.equal(mapping.recipe.groups, 'resolved-groups');
});

test('returns unavailable for opaque templates and structural mismatches', () => {
  const templateGraph = operationToGraph({
    header: { defindex: 1 },
    operation_node: { operation_template: { defindex: 77 } },
  });
  const templateId = templateGraph.roots[0];
  assert.ok(templateId);
  const templateResult = mapOperationGraphNodeToRecipe(templateGraph, templateId, { recipeRoots: recipeTexture('expanded') });
  assert.equal(templateResult.ok, false);
  if (templateResult.ok) return;
  assert.equal(templateResult.reason, 'opaque-operation-template');

  const graph = operationToGraph({ header: { defindex: 1 }, operation_node: add([texture('a'), texture('b')]) });
  const rootId = graph.roots[0];
  assert.ok(rootId);
  const mismatch = mapOperationGraphNodeToRecipe(graph, rootId, {
    recipeRoots: { type: 'combine_add', nodes: [recipeTexture('only-one')] },
  });
  assert.equal(mismatch.ok, false);
  if (mismatch.ok) return;
  assert.equal(mismatch.reason, 'child-count-mismatch');

  const outputResult = mapOperationGraphNodeToRecipe(graph, graph.outputId, {
    recipeRoots: { type: 'combine_add', nodes: [recipeTexture('a'), recipeTexture('b')] },
  });
  assert.equal(outputResult.ok, false);
  if (outputResult.ok) return;
  assert.equal(outputResult.reason, 'output-node');
});

test('treats non-target opaque templates as resolved wildcards', () => {
  const graph = operationToGraph({
    header: { defindex: 1 },
    operation_node: add([
      { operation_template: { defindex: 77 } },
      texture('authored-sibling'),
    ]),
  });
  const rootId = graph.roots[0];
  const templateId = graph.nodes.find((node) => node.kind === 'operation_template')?.id;
  const siblingId = graph.nodes.find((node) => node.kind === 'texture_lookup')?.id;
  assert.ok(rootId);
  assert.ok(templateId);
  assert.ok(siblingId);
  const recipe: RecipeNode = {
    type: 'combine_add',
    nodes: [recipeTexture('expanded-template'), recipeTexture('resolved-sibling')],
  };

  const rootMapping = mapOperationGraphNodeToRecipe(graph, rootId, { recipeRoots: recipe });
  assert.equal(rootMapping.ok, true);
  const siblingMapping = mapOperationGraphNodeToRecipe(graph, siblingId, { recipeRoots: recipe });
  assert.equal(siblingMapping.ok, true);
  if (siblingMapping.ok && siblingMapping.recipe.type === 'texture_lookup') {
    assert.equal(siblingMapping.recipe.texture, 'resolved-sibling');
  }
  const templateMapping = mapOperationGraphNodeToRecipe(graph, templateId, { recipeRoots: recipe });
  assert.equal(templateMapping.ok, false);
  if (!templateMapping.ok) assert.equal(templateMapping.reason, 'opaque-operation-template');
});

test('creates explicitly disposable object URLs', async () => {
  if (typeof URL.createObjectURL !== 'function') return;
  const lease = createOperationGraphObjectUrl(new Blob(['graph-preview'], { type: 'text/plain' }));
  assert.match(lease.url, /^blob:/);
  assert.equal(lease.isDisposed(), false);
  lease.dispose();
  lease.dispose();
  assert.equal(lease.isDisposed(), true);
});

test('VTF encoding accepts compositor-sized RGBA readback', () => {
  const pixels = new Uint8Array([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]);
  const vtf = encodeVtf({ width: 2, height: 2, pixels, format: 'bgra8888' });
  assert.deepEqual([...vtf.subarray(0, 4)], [0x56, 0x54, 0x46, 0x00]);
  assert.ok(vtf.length > pixels.length);
});

test('VTF helper uses the render lease readback and owns no extra target', () => {
  const pixels = new Uint8Array([
    255, 0, 0, 255,
    0, 255, 0, 255,
    0, 0, 255, 255,
    255, 255, 255, 255,
  ]);
  const render = {
    nodeId: 'test',
    recipe: recipeTexture('test'),
    target: { width: 2, height: 2 },
    texture: {},
    width: 2,
    height: 2,
    previewDataUrl: () => 'data:image/png;base64,',
    previewBlob: async () => new Blob(),
    readbackRgba: () => pixels,
    dispose: () => undefined,
    isDisposed: () => false,
  } as unknown as OperationGraphRenderLease;
  const vtf = exportOperationGraphVtf(render, { format: 'bgra8888' });
  assert.deepEqual([...vtf.subarray(0, 4)], [0x56, 0x54, 0x46, 0x00]);
});

test('Invisible_V2 authored nodes correlate with their resolved recipe', async () => {
  const archivePath = path.join(ROOT, '.tmp', 'example-warpaints', 'Invisible_V2.zip');
  const basePath = path.join(ROOT, 'public', 'data', 'protodefs-base.bin');
  const itemDefsPath = path.join(ROOT, 'public', 'data', 'item-defs.json');
  const manifestPath = path.join(ROOT, 'public', 'data', 'manifest.json');
  if (![archivePath, basePath, itemDefsPath, manifestPath].every((filePath) => fs.existsSync(filePath))) return;

  const decoded = decodeProtoDefsFromJson(
    new Uint8Array(fs.readFileSync(basePath)),
    await fixtureFragments(archivePath),
    {
      weaponsByItemDef: JSON.parse(fs.readFileSync(itemDefsPath, 'utf8')),
      builtInIds: fixturePaintkitIds(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))),
    },
  );
  const kit = decoded.index.kits[0];
  assert.ok(kit, 'Invisible_V2 should expose a paintkit.');
  const slot = decoded.kitsByDefindex.get(kit.defindex)?.slots[0];
  assert.ok(slot, 'Invisible_V2 should expose a supported weapon.');
  const messages = extractKitMessages(decoded, kit.defindex);
  const resolved = resolveKitRecipe(decoded, kit.defindex, slot.weaponKey, 'red', 0);
  assert.ok(messages && resolved, 'Invisible_V2 should expose both authored and resolved operations.');
  const graph = operationToGraph(messages.operation as unknown as OperationMsg);
  const outcomes = graph.nodes
    .filter((node) => node.kind !== 'output')
    .map((node) => mapOperationGraphNodeToRecipe(graph, node.id, { recipeRoots: resolved.tree }));
  const mapped = outcomes.filter((outcome) => outcome.ok).length;
  const unavailableReasons = new Map<string, number>();
  for (const outcome of outcomes) {
    if (!outcome.ok) unavailableReasons.set(outcome.reason, (unavailableReasons.get(outcome.reason) ?? 0) + 1);
  }
  console.log(`[verify] Invisible_V2 graph correlation: ${mapped}/${outcomes.length} mapped; unavailable=${JSON.stringify(Object.fromEntries(unavailableReasons))}`);
  const opaqueCount = graph.nodes.filter((node) => node.kind === 'operation_template').length;
  assert.equal(mapped, outcomes.length - opaqueCount, 'Only opaque operation-templates should remain unavailable.');
  assert.deepEqual(Object.fromEntries(unavailableReasons), { 'opaque-operation-template': opaqueCount });
});
