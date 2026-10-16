import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { decodeProtoDefsFromJson } from '../../../src/protodefs/decoder';
import { partitionResolvableKits } from '../../../src/protodefs/validation';
import type { ProtoDefKit } from '../../../src/protodefs/types';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const baseBytes = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public', 'data', 'protodefs-base.bin')));
const itemDefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'item-defs.json'), 'utf8'));

const OPERATION_DEFINDEX = 999_435;

// Decodes a definition whose operation is pasted alongside it, so each test controls the texture lookup.
function decodeDefinition(hasTeamTextures: boolean, stage: Record<string, unknown>) {
  const operation = {
    header: { defindex: OPERATION_DEFINDEX, name: 'team-texture-test-operation' },
    operation_node: [{ stage: { texture_lookup: stage } }],
  };
  const definition = {
    header: { defindex: 999_433, name: 'team-texture-test' },
    operation_template: { defindex: OPERATION_DEFINDEX, type: 'DEF_TYPE_PAINTKIT_OPERATION' },
    has_team_textures: hasTeamTextures,
    flamethrower: {
      item_definition_template: { defindex: 165, type: 'DEF_TYPE_PAINTKIT_ITEM_DEFINITION' },
      data: { material_override: 'Models/Paintkits/Custom/C_Flamethrower' },
    },
  };
  return decodeProtoDefsFromJson(baseBytes, [
    { name: 'operation.json', text: JSON.stringify(operation) },
    { name: 'definition.json', text: JSON.stringify(definition) },
  ], { weaponsByItemDef: itemDefs, builtInIds: [] }).index.kits[0];
}

test('differing team textures count as team textures even with the flag off', () => {
  const kit = decodeDefinition(false, {
    texture: { string: 'patterns/shared' },
    texture_red: { string: 'patterns/red' },
    texture_blue: { string: 'patterns/blu' },
  });
  assert.equal(kit?.hasTeamTextures, true);
  assert.equal(kit?.teamButtonsHidden, true);
});

test('identical team textures stay single-team with the flag off', () => {
  const kit = decodeDefinition(false, { texture: { string: 'patterns/shared' } });
  assert.equal(kit?.hasTeamTextures, false);
  assert.equal(kit?.teamButtonsHidden, false);
});

test('the team flag alone enables team textures without hiding the team buttons', () => {
  const kit = decodeDefinition(true, { texture: { string: 'patterns/shared' } });
  assert.equal(kit?.hasTeamTextures, true);
  assert.equal(kit?.teamButtonsHidden, false);
});

test('imported definitions retain per-weapon material overrides', () => {
  const kit = decodeDefinition(false, { texture: { string: 'patterns/shared' } });
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
    teamButtonsHidden: false,
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
