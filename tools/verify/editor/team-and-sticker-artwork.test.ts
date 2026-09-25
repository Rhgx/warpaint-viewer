// Per-layer team colors and per-sticker artwork: both edits must touch only
// the chosen layer or sticker and leave the input snapshot untouched.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  readTextureLayerTeamColors,
  setStickerBaseReference,
  setTextureLayerTeamColors,
  setTextureLayerTeamTexture,
} from '../../../src/editor/mutations';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';

const layer = { stagePath: ['operation', 'operation_node', '0', 'stage', 'apply_sticker', 'operation_node', 'stage', 'texture_lookup'] };
const secondSticker = ['operation', 'operation_node', '1', 'stage', 'apply_sticker'];

function kit(): ProtoDefKitMessages {
  return {
    definition: { header: { defindex: 1, variables: [{ name: '$art', value: 'stickers/shared' }] } },
    operation: {
      header: { defindex: 2 },
      operation_node: [
        { stage: { apply_sticker: {
          sticker: { base: { variable: '$art' } },
          operation_node: { stage: { texture_lookup: { texture: { string: 'patterns/a' } } } },
        } } },
        { stage: { apply_sticker: { sticker: [{ base: { variable: '$art' }, weight: { float: 1 } }] } } },
      ],
    },
  };
}

test('a sticker can take new artwork without moving the stickers that shared it', () => {
  const before = kit();
  const snapshot = structuredClone(before);
  const next = setStickerBaseReference(before, { stagePaths: [secondSticker] }, 'stickers/shared_2');
  const nodes = next.operation.operation_node as { stage: { apply_sticker: { sticker: unknown } } }[];
  assert.deepEqual(nodes[1].stage.apply_sticker.sticker, [{ base: { string: 'stickers/shared_2' }, weight: { float: 1 } }]);
  assert.deepEqual(nodes[0].stage.apply_sticker.sticker, { base: { variable: '$art' } });
  assert.deepEqual(before, snapshot);
});

test('team colors start identical, split per team, and fold back to RED', () => {
  const before = kit();
  const snapshot = structuredClone(before);
  assert.deepEqual(readTextureLayerTeamColors(before, layer), { enabled: false, red: 'patterns/a', blu: 'patterns/a' });

  const on = setTextureLayerTeamColors(before, layer, true);
  assert.equal(on.definition.has_team_textures, true);
  assert.deepEqual(readTextureLayerTeamColors(on, layer), { enabled: true, red: 'patterns/a', blu: 'patterns/a' });
  assert.equal(setTextureLayerTeamColors(on, layer, true), on, 'enabling twice is a no-op');

  const split = setTextureLayerTeamTexture(on, layer, 'blu', 'patterns/a_blu');
  assert.deepEqual(readTextureLayerTeamColors(split, layer), { enabled: true, red: 'patterns/a', blu: 'patterns/a_blu' });

  const off = setTextureLayerTeamColors(split, layer, false);
  assert.deepEqual(readTextureLayerTeamColors(off, layer), { enabled: false, red: 'patterns/a', blu: 'patterns/a' });
  assert.equal(off.definition.has_team_textures, undefined);
  assert.throws(() => setTextureLayerTeamTexture(off, layer, 'red', 'x'), /team colors/);
  assert.deepEqual(before, snapshot);
});

test('a layer with template team sides but team textures off reads as off and can be turned on', () => {
  const before = kit();
  const nodes = before.operation.operation_node as { stage: { apply_sticker: { operation_node: { stage: { texture_lookup: Record<string, unknown> } } } } }[];
  nodes[0].stage.apply_sticker.operation_node.stage.texture_lookup = {
    texture_red: { variable: 'texture_layer_1' },
    texture_blue: { variable: 'texture_layer_1_blue' },
  };
  assert.equal(readTextureLayerTeamColors(before, layer)?.enabled, false);

  const on = setTextureLayerTeamColors(before, layer, true);
  assert.notEqual(on, before);
  assert.equal(on.definition.has_team_textures, true);
  assert.equal(readTextureLayerTeamColors(on, layer)?.enabled, true);
  const stage = (on.operation.operation_node as typeof nodes)[0].stage.apply_sticker.operation_node.stage.texture_lookup;
  assert.deepEqual(stage.texture_blue, { variable: 'texture_layer_1_blue' }, 'authored team sides are kept');
});
