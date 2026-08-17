import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { decodeProtoDefsFromJson } from '../../src/protodefs/decoder';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const baseBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public', 'data', 'protodefs-base.bin')));
const itemDefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'item-defs.json'), 'utf8'));

function decodeDefinition(tags: string[], hasTeamTextures: boolean) {
  const definition = {
    header: { defindex: 999_433, name: 'team-color-test', tags },
    operation_template: { defindex: 930, type: 'DEF_TYPE_PAINTKIT_OPERATION' },
    has_team_textures: hasTeamTextures,
    flamethrower: {
      item_definition_template: { defindex: 165, type: 'DEF_TYPE_PAINTKIT_ITEM_DEFINITION' },
    },
  };
  return decodeProtoDefsFromJson(baseBytes, [{ name: 'definition.json', text: JSON.stringify(definition) }], {
    weaponsByItemDef: itemDefs,
    builtInIds: [],
  }).index.kits[0];
}

test('team-color prefab tags warn without overriding a false team-texture flag', () => {
  const kit = decodeDefinition(['workshop', 'three_sticker_four_texture_inner_wear_team_color'], false);
  assert.equal(kit?.hasTeamTextures, false);
  assert.equal(kit?.teamTextureMismatch, true);
});

test('ordinary definitions with a false team-texture flag stay single-team', () => {
  const kit = decodeDefinition(['workshop', 'three_sticker_four_texture_inner_wear'], false);
  assert.equal(kit?.hasTeamTextures, false);
  assert.equal(kit?.teamTextureMismatch, false);
});
