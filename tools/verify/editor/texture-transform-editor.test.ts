import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { resolveRecipe } from '../../../src/compositor/resolve';
import { advancePaintkitStream, createPaintkitRandomState, resolveRange } from '../../../src/compositor/rng';
import type { RecipeNode } from '../../../src/compositor/types';
import {
  pushTextureTransformRangeToAllWeapons,
  setTextureTransformRange,
  type TextureTransformTarget,
} from '../../../src/editor/mutations';
import { serializeProtoDefKitMessages } from '../../../src/editor/jsonExport';
import { normalizeProtoDefFragments } from '../../../src/protodefs/jsonFragments';
import { discoverBaseTextureTransformTarget, discoverTextureTransformTargets } from '../../../src/editor/transformTargets';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';
import {
  decodeProtoDefs,
  extractKitMessages,
  getKitWeaponSlots,
  resolveKitRecipeWithProvenance,
} from '../../../src/protodefs/decoder';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'public', 'data', 'manifest.json'), 'utf8')) as {
  paintkits: Array<{ id: number; name: string }>;
};
const decoded = decodeProtoDefs(
  new Uint8Array(fs.readFileSync(path.join(root, 'public', 'data', 'protodefs-full.bin'))),
  {
    weaponsByItemDef: JSON.parse(fs.readFileSync(path.join(root, 'public', 'data', 'item-defs.json'), 'utf8')),
    builtInIds: manifest.paintkits.map((paint) => paint.id),
  },
);

const stagePath = ['operation', 'operation_node', '0', 'stage', 'texture_lookup'] as const;

function fixture(): ProtoDefKitMessages {
  return {
    operation: {
      header: {
        defindex: 700,
        variables: [{ name: 'layer_rotation', value: '0 360', inherit: true }],
      },
      operation_node: [{ stage: { texture_lookup: {
        texture: { string: 'patterns/example' },
        rotation: { variable: 'layer_rotation' },
        translate_u: { string: '0' },
      } } }, { stage: { select: { groups: { string: 'patterns/groups' }, select: { uint32: 16 } } } }],
    },
    definition: {
      header: { defindex: 701 },
      operation_template: { defindex: 700, type: 7 },
      rocketlauncher: {
        item_definition_template: { defindex: 1, type: 8 },
        data: { variable: [{ variable: 'layer_rotation', string: '10 20' }] },
      },
      scattergun: {
        item_definition_template: { defindex: 2, type: 8 },
        data: { variable: [{ variable: 'layer_rotation', string: '30 40' }] },
      },
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function textureStage(messages: ProtoDefKitMessages): Record<string, unknown> {
  const node = (messages.operation.operation_node as unknown[])[0];
  return record(record(record(node).stage).texture_lookup);
}

function headerVariable(messages: ProtoDefKitMessages): Record<string, unknown> {
  return (record(messages.operation.header).variables as Record<string, unknown>[])[0];
}

function weaponVariables(messages: ProtoDefKitMessages, weapon: 'rocketlauncher' | 'scattergun'): Record<string, unknown>[] {
  const item = record(messages.definition[weapon]);
  return record(item.data).variable as Record<string, unknown>[];
}

test('discovers the unmasked base texture as its own transform layer', () => {
  const messages: ProtoDefKitMessages = {
    operation: {
      header: { variables: [
        { name: 'texture_layer_1', value: 'patterns/test/base' },
        { name: 'texture_layer_1_rotate', value: '0 360', inherit: true },
      ] },
      operation_node: [{ stage: { combine_lerp: { operation_node: [
        { stage: { texture_lookup: {
          texture: { variable: 'texture_layer_1' },
          rotation: { variable: 'texture_layer_1_rotate' },
        } } },
        { stage: { texture_lookup: { texture: { string: 'patterns/overlay' } } } },
      ] } } }],
    },
    definition: { header: {}, rocketlauncher: { data: { variable: [
      { variable: 'texture_layer_1_rotate', string: '85 95' },
    ] } } },
  };
  const fieldPath = [
    'operation', 'operation_node', '0', 'stage', 'combine_lerp', 'operation_node', '0',
    'stage', 'texture_lookup', 'texture',
  ];
  const discovered = discoverBaseTextureTransformTarget(messages, [{
    fieldPath,
    provenance: {
      variableName: 'texture_layer_1',
      effectiveValue: 'patterns/workshop/crate_pattern',
      sourcePath: ['operation', 'header', 'variables', '0'],
      editableSourcePath: ['operation', 'header', 'variables', '0'],
      scope: 'global',
      canOverride: false,
    },
  }]);
  assert.ok(discovered);
  assert.equal(discovered.label, 'Crate Pattern');
  assert.equal(discovered.textureRef, 'patterns/workshop/crate_pattern');
  assert.equal(discovered.transformLocked, false);
  assert.deepEqual(discovered.transform.target.stagePath, fieldPath.slice(0, -1));
});

test('Storage War exposes its crate pattern base in Transform', () => {
  const messages = extractKitMessages(decoded, 441);
  const slot = getKitWeaponSlots(decoded, 441).find((entry) => entry.weaponKey === 'c_rocketlauncher');
  assert.ok(messages && slot);
  const recipe = resolveKitRecipeWithProvenance(decoded, 441, slot.weaponKey, 'red', 0);
  assert.ok(recipe);
  const base = discoverBaseTextureTransformTarget(messages, recipe.provenance);
  assert.ok(base);
  assert.equal(base.label, 'Crate Pattern');
  assert.match(base.textureRef, /crate_pattern$/);
  assert.deepEqual([base.transform.rotation.min, base.transform.rotation.max], [85, 95]);
  assert.deepEqual([base.transform.scaleUv.min, base.transform.scaleUv.max], [2, 2.5]);
});

test('every shipped paint exposes its effective unmasked base layer', () => {
  const missing: string[] = [];
  let auditedRecipes = 0;
  for (const paint of manifest.paintkits) {
    const messages = extractKitMessages(decoded, paint.id);
    if (!messages) continue;
    for (const slot of getKitWeaponSlots(decoded, paint.id)) {
      for (const team of ['red', 'blu'] as const) {
        auditedRecipes += 1;
        const recipe = resolveKitRecipeWithProvenance(decoded, paint.id, slot.weaponKey, team, 0);
        if (!discoverBaseTextureTransformTarget(messages, recipe?.provenance)) {
          missing.push(`${paint.id}:${paint.name}/${slot.weaponKey}/${team}`);
        }
      }
    }
  }
  assert.ok(auditedRecipes >= 14_000, 'the audit should cover every team variant of the shipped editable recipes');
  assert.deepEqual(missing, []);
}, 15_000);

test('team-texture and weapon-albedo bases use the intended transform policy', () => {
  const baseFor = (kitId: number) => {
    const messages = extractKitMessages(decoded, kitId);
    const slot = getKitWeaponSlots(decoded, kitId)[0];
    assert.ok(messages && slot);
    const recipe = resolveKitRecipeWithProvenance(decoded, kitId, slot.weaponKey, 'red', 0);
    const base = discoverBaseTextureTransformTarget(messages, recipe?.provenance);
    assert.ok(base);
    return base;
  };
  assert.equal(baseFor(442).transformLocked, false, 'Die\'n Dasher layer 1 is editable');
  assert.equal(baseFor(423).transformLocked, true, 'Gobi Glazed weapon albedo stays locked');
  assert.equal(baseFor(390).transformLocked, false, 'Dragon Slayer custom paint base is editable');
});

test('texture transform scope, normalization and JSON round trip', () => {
  const original = fixture();

  const literal = setTextureTransformRange(original, { stagePath }, 'translate_u', {
    mode: 'fixed', min: 0.25, max: 0.25,
  });
  assert.deepEqual(textureStage(literal).translate_u, { string: '0.25' });

  const reversed = setTextureTransformRange(original, { stagePath }, 'rotation', {
    mode: 'varies', min: 90, max: -90,
  });
  assert.equal(headerVariable(reversed).value, '90 -90');

  const shared = setTextureTransformRange(original, { stagePath }, 'rotation', {
    mode: 'fixed', min: 15, max: 15,
  });
  assert.equal(headerVariable(shared).value, '15');
  assert.equal(headerVariable(shared).inherit, true);
  assert.equal(weaponVariables(shared, 'rocketlauncher')[0].string, '10 20');

  const weaponTarget: TextureTransformTarget = {
    stagePath,
    fieldSourcePaths: {
      rotation: ['definition', 'rocketlauncher', 'data', 'variable', '0'],
    },
    weaponOverridePath: ['definition', 'rocketlauncher', 'data', 'variable'],
  };
  const weaponOnly = setTextureTransformRange(original, weaponTarget, 'rotation', {
    mode: 'fixed', min: 45, max: 45,
  });
  assert.equal(headerVariable(weaponOnly).value, '0 360');
  assert.equal(headerVariable(weaponOnly).inherit, true);
  assert.equal(weaponVariables(weaponOnly, 'rocketlauncher')[0].string, '45');
  assert.equal(weaponVariables(weaponOnly, 'scattergun')[0].string, '30 40');

  const staleProvenance = [{
    fieldPath: [...stagePath, 'rotation'],
    provenance: {
      variableName: 'layer_rotation',
      effectiveValue: '10 20',
      sourcePath: ['definition', 'rocketlauncher', 'data', 'variable', '0'],
      editableSourcePath: ['definition', 'rocketlauncher', 'data', 'variable', '0'],
      scope: 'weapon' as const,
      canOverride: true,
    },
  }];
  const discoveredAfterEdit = discoverTextureTransformTargets(weaponOnly, staleProvenance).targets[0];
  assert.ok(discoveredAfterEdit);
  assert.deepEqual(
    [discoveredAfterEdit.rotation.min, discoveredAfterEdit.rotation.max],
    [45, 45],
    'the current draft override must win while asynchronous provenance still reports the prior value',
  );

  const promoted = pushTextureTransformRangeToAllWeapons(
    weaponOnly,
    weaponTarget,
    'rotation',
    { mode: 'fixed', min: 45, max: 45 },
    [
      ['definition', 'rocketlauncher', 'data', 'variable'],
      ['definition', 'scattergun', 'data', 'variable'],
    ],
  );
  assert.equal(headerVariable(promoted).value, '45');
  assert.deepEqual(weaponVariables(promoted, 'rocketlauncher'), []);
  assert.deepEqual(weaponVariables(promoted, 'scattergun'), []);

  const exported = serializeProtoDefKitMessages(literal);
  const imported = normalizeProtoDefFragments([...exported.fragments]);
  const importedOperation = imported.find((entry) => entry.kind === 'operation');
  assert.ok(importedOperation);
  const roundTrip = { definition: literal.definition, operation: importedOperation.value };
  assert.deepEqual(textureStage(roundTrip).translate_u, { string: '0.25' });
  assert.equal(headerVariable(roundTrip).value, '0 360');
});

test('combine stages can receive and resolve texture transforms', () => {
  const messages: ProtoDefKitMessages = {
    operation: {
      header: { defindex: 710 },
      operation_node: [
        { stage: { combine_multiply: { operation_node: [
          { stage: { texture_lookup: { texture: { string: 'patterns/first' } } } },
          { stage: { texture_lookup: { texture: { string: 'patterns/second' } } } },
        ] } } },
        { stage: { select: { groups: { string: 'patterns/groups' }, select: { uint32: 16 } } } },
      ],
    },
    definition: {
      header: { defindex: 711 },
      operation_template: { defindex: 710, type: 7 },
    },
  };

  const discovered = discoverTextureTransformTargets(messages).targets[0];
  assert.ok(discovered);
  assert.deepEqual(discovered.target.stagePath, [
    'operation', 'operation_node', '0', 'stage', 'combine_multiply',
  ]);
  assert.deepEqual([discovered.scaleUv.min, discovered.scaleUv.max], [1, 1]);
  assert.deepEqual(discovered.blockers, []);

  const edited = setTextureTransformRange(messages, discovered.target, 'scale_uv', {
    mode: 'varies', min: 2, max: 3,
  });
  const combine = record(record(record((edited.operation.operation_node as unknown[])[0]).stage).combine_multiply);
  assert.deepEqual(combine.scale_uv, { string: '2 3' });

  const recipe: RecipeNode = {
    type: 'combine_multiply',
    rotation: [45, 45],
    translateU: [0.25, 0.25],
    translateV: [0.5, 0.5],
    scaleUV: [2, 2],
    nodes: [
      { type: 'texture_lookup', texture: 'patterns/first' },
      { type: 'texture_lookup', texture: 'patterns/second' },
    ],
  };
  const resolved = resolveRecipe(recipe, '123');
  assert.equal(resolved.type, 'combine_multiply');
  assert.equal(resolved.rotationDeg, 45);
  assert.equal(resolved.translateU, 0.25);
  assert.equal(resolved.translateV, 0.5);
  assert.equal(resolved.scale, 2);
});

test('transformless combine stages preserve seeded child texture placement', () => {
  const seed = '3753779166464894300';
  const recipe: RecipeNode = {
    type: 'combine_multiply',
    nodes: [{
      type: 'texture_lookup',
      texture: 'patterns/alpha-control',
      rotation: [0, 360],
      translateU: [0, 1],
      translateV: [0, 1],
      scaleUV: [0.4, 0.5],
    }],
  };

  const state = createPaintkitRandomState(seed);
  resolveRange(state.streams[state.current], undefined, 0);
  resolveRange(state.streams[state.current], undefined, 1);
  resolveRange(state.streams[state.current], undefined, 1);
  advancePaintkitStream(state);
  const rng = state.streams[state.current];
  const expectedTranslateU = resolveRange(rng, [0, 1], 0);
  const expectedTranslateV = resolveRange(rng, [0, 1], 0);
  const expectedRotation = resolveRange(rng, [0, 360], 0);
  const expectedScale = resolveRange(rng, [0.4, 0.5], 1);

  const resolved = resolveRecipe(recipe, seed);
  assert.equal(resolved.type, 'combine_multiply');
  const child = resolved.nodes[0];
  assert.equal(child.type, 'texture_lookup');
  assert.equal(child.translateU, expectedTranslateU);
  assert.equal(child.translateV, expectedTranslateV);
  assert.equal(child.rotationDeg, expectedRotation);
  assert.equal(child.scale, expectedScale);
});
