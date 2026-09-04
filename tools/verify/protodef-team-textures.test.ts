import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { decodeProtoDefsFromJson } from '../../src/protodefs/decoder';
import { partitionResolvableKits } from '../../src/protodefs/validation';
import type { ProtoDefKit } from '../../src/protodefs/types';

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
      data: { material_override: 'Models/Paintkits/Custom/C_Flamethrower' },
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

test('imported definitions retain per-weapon material overrides', () => {
  const kit = decodeDefinition(['workshop'], false);
  assert.deepEqual(kit?.materialOverrides, {
    c_flamethrower: 'models/paintkits/custom/c_flamethrower',
  });
});

test('definitions for unknown item templates remain visible as unsupported', () => {
  const definition = {
    header: { defindex: 999_434, name: 'unknown-weapon-test' },
    operation_template: { defindex: 930, type: 'DEF_TYPE_PAINTKIT_OPERATION' },
    item: {
      item_definition_template: { defindex: 999_999, type: 'DEF_TYPE_PAINTKIT_ITEM_DEFINITION' },
    },
  };
  const decoded = decodeProtoDefsFromJson(
    baseBytes,
    [{ name: 'definition.json', text: JSON.stringify(definition) }],
    { weaponsByItemDef: itemDefs, builtInIds: [] },
  );
  assert.equal(decoded.index.kits.length, 1);
  assert.equal(decoded.index.kits[0]?.name, 'unknown-weapon-test');
  assert.deepEqual(decoded.index.kits[0]?.weapons, []);
});

test('definitions that cannot resolve an initial recipe are quarantined', async () => {
  const kits = ['working', 'missing', 'broken'].map((name, index): ProtoDefKit => ({
    defindex: index + 1,
    name,
    weapons: ['c_flamethrower'],
    hasTeamTextures: false,
    teamTextureMismatch: false,
    perWear: false,
    isNew: true,
    unsupportedItemDefs: [],
  }));
  const source = {
    resolveRecipe: async (defindex: number) => {
      if (defindex === 3) throw new Error('bad definition');
      return defindex === 1
        ? { tree: { type: 'texture_lookup' as const, texture: 'patterns/test' }, textureRefs: [] }
        : null;
    },
  };

  const result = await partitionResolvableKits(source, kits);

  assert.deepEqual(result.loadable.map((kit) => kit.name), ['working']);
  assert.deepEqual(result.quarantined.map((kit) => kit.name), ['missing', 'broken']);
});
