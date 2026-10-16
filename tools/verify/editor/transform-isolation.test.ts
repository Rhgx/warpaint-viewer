import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { ResolvedNode, ResolvedSelect, ResolvedTexture } from '../../../src/compositor/resolve';
import {
  collectResolvedLayerIsolationNodes,
  preferredLayerOccurrenceIndex,
} from '../../../src/editor/transform/transformIsolation';

const identity = { black: 0, white: 1, gamma: 1, rotationDeg: 0, translateU: 0, translateV: 0, scale: 1, flipU: false, flipV: false };
const texture = (name: string, rotationDeg: number): ResolvedTexture => (
  { ...identity, type: 'texture_lookup', texture: name, rotationDeg, translateU: 0.25, translateV: 0.5, scale: 1.5, flipU: true }
);

test('transform isolation keeps the resolved texture or combined layer inside its selected groups', () => {
  const combined: ResolvedNode = {
    ...identity, type: 'combine_multiply', rotationDeg: 30, scale: 2, nodes: [texture('patterns/first', 0), texture('patterns/second', 0)],
  };
  for (const layer of [texture('patterns/active', 137), combined]) {
    const select: ResolvedSelect = { type: 'select', groups: 'patterns/groups', select: [32, 80] };
    const [isolated] = collectResolvedLayerIsolationNodes({ ...identity, type: 'combine_lerp', nodes: [texture('patterns/base', 24), layer, select] });
    assert.ok(isolated?.type === 'combine_lerp');
    assert.equal(isolated.nodes[1], layer);
    assert.equal(isolated.nodes[2], select);
    const base = isolated.nodes[0];
    assert.equal(base?.type === 'texture_lookup' ? base.rotationDeg : null, 0, 'the base under the layer is untransformed');
  }
});

test('transform isolation preserves layer alignment for an unpaired select', () => {
  assert.deepEqual(collectResolvedLayerIsolationNodes({ type: 'select', groups: 'patterns/groups', select: [16] }), [undefined]);
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
