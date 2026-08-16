import assert from 'node:assert/strict';
import { test } from 'vitest';
import { discoverGroupTextureTarget } from '../../../src/editor/groupTargets';
import { setGroupTextureReference } from '../../../src/editor/mutations';
import type { ProtoDefKitMessages, ProtoDefValueTrace } from '../../../src/protodefs/types';

const messages: ProtoDefKitMessages = {
  definition: {
    header: {
      defindex: 10,
      variables: { name: 'weapon_groups', value: 'models/shared_groups', inherit: true },
    },
    rocketlauncher: {
      item_definition_template: { defindex: 20 },
      data: { variable: { variable: 'weapon_groups', string: 'models/rocket_groups_04' } },
    },
    scattergun: {
      item_definition_template: { defindex: 21 },
      data: { variable: { variable: 'weapon_groups', string: 'models/scatter_groups' } },
    },
    operation_template: { defindex: 11 },
  },
  operation: { header: { defindex: 11 } },
};

const provenance: ProtoDefValueTrace[] = [{
  fieldPath: ['operation', 'operation_node', 'stage', 'select', 'groups'],
  provenance: {
    variableName: 'weapon_groups',
    effectiveValue: 'models/rocket_groups_04',
    sourcePath: ['definition', 'rocketlauncher', 'data', 'variable'],
    editableSourcePath: ['definition', 'rocketlauncher', 'data', 'variable'],
    scope: 'weapon',
    canOverride: true,
  },
}];

test('discovers and edits a weapon-local group texture', () => {
  const target = discoverGroupTextureTarget(
    provenance,
    'textures/models/rocket_groups_04.webp',
    ['definition', 'rocketlauncher', 'data', 'variable'],
  );
  assert.ok(target);
  const edited = setGroupTextureReference(messages, target, ' models/rocket_groups_02 ');
  assert.equal(
    (edited.definition.rocketlauncher as { data: { variable: { string: string } } }).data.variable.string,
    'models/rocket_groups_02',
  );
  assert.equal(
    (edited.definition.scattergun as { data: { variable: { string: string } } }).data.variable.string,
    'models/scatter_groups',
  );
  assert.equal(
    ((messages.definition.rocketlauncher as { data: { variable: { string: string } } }).data.variable.string),
    'models/rocket_groups_04',
    'the source snapshot remains immutable',
  );
});

test('creates a missing weapon override and rejects unsafe discovery', () => {
  const target = discoverGroupTextureTarget(
    provenance,
    'models/rocket_groups_04',
    ['definition', 'rocketlauncher', 'data', 'variable'],
  );
  assert.ok(target);
  const withoutOverride = structuredClone(messages);
  (withoutOverride.definition.rocketlauncher as { data: Record<string, unknown> }).data.variable = undefined;
  const edited = setGroupTextureReference(withoutOverride, target, 'models/rocket_groups_05');
  assert.deepEqual(
    (edited.definition.rocketlauncher as { data: { variable: unknown } }).data.variable,
    { variable: 'weapon_groups', string: 'models/rocket_groups_05' },
  );
  assert.equal(discoverGroupTextureTarget(provenance, 'models/other_groups', target.overridePath), null);
  assert.equal(discoverGroupTextureTarget(provenance, 'models/rocket_groups_04', undefined), null);
  const external = structuredClone(provenance);
  external[0].provenance.scope = 'wear';
  delete external[0].provenance.editableSourcePath;
  assert.equal(
    discoverGroupTextureTarget(external, 'models/rocket_groups_04', target.overridePath),
    null,
    'a later non-editable wear source must not produce an ineffective weapon override',
  );
});
