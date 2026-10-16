import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { decodeProtoDefsFromJson } from '../../../src/protodefs/decoder';
import { partitionResolvableKits } from '../../../src/protodefs/validation';
import type { ProtoDefKit } from '../../../src/protodefs/types';
import { PUBLIC_DATA } from '../fixtures';

const baseBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-base.bin')));
const itemDefs: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));

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

test('team textures come from the flag or from differing team stages, and only the latter hides the team buttons', () => {
  const shared = { texture: { string: 'patterns/shared' } };
  const split = { ...shared, texture_red: { string: 'patterns/red' }, texture_blue: { string: 'patterns/blu' } };
  for (const [flag, stage, hasTeamTextures, teamButtonsHidden] of [
    [false, split, true, true],
    [false, shared, false, false],
    [true, shared, true, false],
  ] as const) {
    const kit = decodeDefinition(flag, stage);
    assert.deepEqual([kit?.hasTeamTextures, kit?.teamButtonsHidden], [hasTeamTextures, teamButtonsHidden], `flag ${flag}`);
  }
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
