import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SnapshotHistory } from '../../../src/editor/history';
import {
  pushTextureTransformRangeToAllWeapons,
  setTextureTransformRange,
  type TextureTransformTarget,
} from '../../../src/editor/mutations';
import { serializeProtoDefKitMessages } from '../../../src/editor/jsonExport';
import { normalizeProtoDefFragments } from '../../../src/protodefs/jsonFragments';
import { discoverTextureTransformTargets } from '../../../src/editor/transformTargets';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';

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

test('texture transform scope, normalization, history and JSON round trip', () => {
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

  const history = new SnapshotHistory<ProtoDefKitMessages>();
  history.record(original);
  assert.deepEqual(history.undo(weaponOnly), original);
  assert.deepEqual(history.redo(original), weaponOnly);

  const exported = serializeProtoDefKitMessages(literal);
  const imported = normalizeProtoDefFragments([...exported.fragments]);
  const importedOperation = imported.find((entry) => entry.kind === 'operation');
  assert.ok(importedOperation);
  const roundTrip = { definition: literal.definition, operation: importedOperation.value };
  assert.deepEqual(textureStage(roundTrip).translate_u, { string: '0.25' });
  assert.equal(headerVariable(roundTrip).value, '0 360');
});
