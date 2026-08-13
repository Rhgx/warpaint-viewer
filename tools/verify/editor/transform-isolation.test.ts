import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ResolvedNode, ResolvedSelect, ResolvedTexture } from '../../../src/compositor/resolve';
import { collectResolvedLayerIsolationNodes, preferredLayerOccurrenceIndex } from '../../../src/editor/transformIsolation';

function texture(texture: string, rotationDeg: number): ResolvedTexture {
  return {
    type: 'texture_lookup',
    texture,
    black: 0,
    white: 1,
    gamma: 1,
    rotationDeg,
    translateU: 0.25,
    translateV: 0.5,
    scale: 1.5,
    flipU: true,
    flipV: false,
  };
}

test('transform isolation keeps the resolved texture inside its selected groups', () => {
  const activeTexture = texture('patterns/active', 137);
  const select: ResolvedSelect = {
    type: 'select',
    groups: 'patterns/groups',
    select: [32, 80],
  };
  const recipe: ResolvedNode = {
    type: 'combine_lerp',
    black: 0,
    white: 1,
    gamma: 1,
    rotationDeg: 0,
    translateU: 0,
    translateV: 0,
    scale: 1,
    flipU: false,
    flipV: false,
    nodes: [texture('patterns/base', 24), activeTexture, select],
  };

  const [isolated] = collectResolvedLayerIsolationNodes(recipe);
  assert.ok(isolated?.type === 'combine_lerp');
  assert.equal(isolated.nodes[1], activeTexture);
  assert.equal(isolated.nodes[2], select);
  assert.equal(isolated.nodes[0]?.type, 'texture_lookup');
  assert.equal(isolated.nodes[0]?.type === 'texture_lookup' ? isolated.nodes[0].rotationDeg : null, 0);
});

test('transform isolation preserves layer alignment for an unpaired select', () => {
  const select: ResolvedSelect = {
    type: 'select',
    groups: 'patterns/groups',
    select: [16],
  };

  assert.deepEqual(collectResolvedLayerIsolationNodes(select), [undefined]);
});

test('transform isolation keeps a combined layer inside its selected groups', () => {
  const combined: ResolvedNode = {
    type: 'combine_multiply',
    black: 0,
    white: 1,
    gamma: 1,
    rotationDeg: 30,
    translateU: 0.2,
    translateV: 0.4,
    scale: 2,
    flipU: false,
    flipV: false,
    nodes: [texture('patterns/first', 0), texture('patterns/second', 0)],
  };
  const select: ResolvedSelect = { type: 'select', groups: 'patterns/groups', select: [16] };
  const recipe: ResolvedNode = {
    type: 'combine_lerp',
    black: 0,
    white: 1,
    gamma: 1,
    rotationDeg: 0,
    translateU: 0,
    translateV: 0,
    scale: 1,
    flipU: false,
    flipV: false,
    nodes: [texture('patterns/base', 0), combined, select],
  };

  const [isolated] = collectResolvedLayerIsolationNodes(recipe);
  assert.ok(isolated?.type === 'combine_lerp');
  assert.equal(isolated.nodes[1], combined);
  assert.equal(isolated.nodes[2], select);
});

test('transform isolation previews the final colour occurrence of a reused authored layer', () => {
  const targets = [
    { sourceKey: 'variables:texture_layer_3_select_1' },
    { sourceKey: 'variables:texture_layer_4_select_1' },
    { sourceKey: 'variables:texture_layer_3_select_1' },
  ];

  assert.equal(preferredLayerOccurrenceIndex(targets, targets[0]), 2);
  assert.equal(preferredLayerOccurrenceIndex(targets, null), -1);
});
