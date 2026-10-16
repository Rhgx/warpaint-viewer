import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  pushTextureTransformRangeToAllWeapons,
  setTextureTransformRange,
  type TextureTransformTarget,
} from '../../../src/editor/mutations';
import { serializeProtoDefKitMessages } from '../../../src/editor/export/jsonExport';
import { normalizeProtoDefFragments } from '../../../src/protodefs/jsonFragments';
import { discoverBaseTextureTransformTarget, discoverTextureTransformTargets } from '../../../src/editor/transform/transformTargets';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';
import { extractKitMessages, getKitWeaponSlots, resolveKitRecipeWithProvenance } from '../../../src/protodefs/decoder';
import { dig, shippedProtoDefs } from '../fixtures';

// Read-only use of the shared decode: the mutations below run on synthetic fixtures.
const { full: decoded, manifest } = shippedProtoDefs();

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

const textureStage = (messages: ProtoDefKitMessages) => dig(messages.operation, 'operation_node', 0, 'stage', 'texture_lookup');
const headerVariable = (messages: ProtoDefKitMessages) => dig(messages.operation, 'header', 'variables', 0);
const weaponVariables = (messages: ProtoDefKitMessages, weapon: string) => dig(messages.definition, weapon, 'data', 'variable');

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
  assert.deepEqual(dig(textureStage(literal), 'translate_u'), { string: '0.25' });

  const reversed = setTextureTransformRange(original, { stagePath }, 'rotation', {
    mode: 'varies', min: 90, max: -90,
  });
  assert.equal(dig(headerVariable(reversed), 'value'), '90 -90');

  const shared = setTextureTransformRange(original, { stagePath }, 'rotation', {
    mode: 'fixed', min: 15, max: 15,
  });
  assert.equal(dig(headerVariable(shared), 'value'), '15');
  assert.equal(dig(headerVariable(shared), 'inherit'), true);
  assert.equal(dig(weaponVariables(shared, 'rocketlauncher'), 0, 'string'), '10 20');

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
  assert.equal(dig(headerVariable(weaponOnly), 'value'), '0 360');
  assert.equal(dig(headerVariable(weaponOnly), 'inherit'), true);
  assert.equal(dig(weaponVariables(weaponOnly, 'rocketlauncher'), 0, 'string'), '45');
  assert.equal(dig(weaponVariables(weaponOnly, 'scattergun'), 0, 'string'), '30 40');

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
  assert.equal(dig(headerVariable(promoted), 'value'), '45');
  assert.deepEqual(weaponVariables(promoted, 'rocketlauncher'), []);
  assert.deepEqual(weaponVariables(promoted, 'scattergun'), []);

  const exported = serializeProtoDefKitMessages(literal);
  const imported = normalizeProtoDefFragments([...exported.fragments]);
  const importedOperation = imported.find((entry) => entry.kind === 'operation');
  assert.ok(importedOperation);
  const roundTrip = { definition: literal.definition, operation: importedOperation.value };
  assert.deepEqual(dig(textureStage(roundTrip), 'translate_u'), { string: '0.25' });
  assert.equal(dig(headerVariable(roundTrip), 'value'), '0 360');
});

test('combine UV fields are not editable', () => {
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
    definition: { header: { defindex: 711 }, operation_template: { defindex: 710, type: 7 } },
  };
  const discovered = discoverTextureTransformTargets(messages).targets[0];
  assert.ok(discovered);
  assert.deepEqual(discovered.target.stagePath, []);
  assert.deepEqual(discovered.blockers, ['ambiguous-source-stage']);
});
