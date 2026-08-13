import assert from 'node:assert/strict';
import { test } from 'vitest';
import { SnapshotHistory } from '../../../src/editor/history';
import {
  setWeaponMaterialOverrides,
  type WeaponMaterialUpdate,
} from '../../../src/editor/mutations';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';

function fixture(): ProtoDefKitMessages {
  return {
    operation: { header: { defindex: 900 } },
    definition: {
      header: { defindex: 901 },
      rocketlauncher: {
        item_definition_template: { defindex: 1, type: 8 },
        data: { material_override: 'models/paintkits/macaw/c_rocketlauncher' },
      },
      scattergun: {
        item_definition_template: { defindex: 2, type: 8 },
        data: {},
      },
    },
  };
}

const updates: readonly WeaponMaterialUpdate[] = [
  {
    target: { weaponKey: 'rocketlauncher', path: ['definition', 'rocketlauncher'] },
    overridePath: null,
  },
  {
    target: { weaponKey: 'scattergun', path: ['definition', 'scattergun'] },
    overridePath: 'models/paintkits/macaw/c_scattergun',
  },
];

function materialOverride(messages: ProtoDefKitMessages, weapon: string): unknown {
  const item = messages.definition[weapon];
  assert.ok(item && typeof item === 'object' && !Array.isArray(item));
  const data = (item as Record<string, unknown>).data;
  assert.ok(data && typeof data === 'object' && !Array.isArray(data));
  return (data as Record<string, unknown>).material_override;
}

test('material overrides batch into one snapshot and ignore no-op writes', () => {
  const original = fixture();
  const noOp = setWeaponMaterialOverrides(original, [{
    target: { weaponKey: 'rocketlauncher', path: ['definition', 'rocketlauncher'] },
    overridePath: ' models/paintkits/macaw/c_rocketlauncher ',
  }]);
  assert.equal(noOp, original);

  const edited = setWeaponMaterialOverrides(original, updates);
  assert.notEqual(edited, original);
  assert.equal(materialOverride(edited, 'rocketlauncher'), undefined);
  assert.equal(
    materialOverride(edited, 'scattergun'),
    'models/paintkits/macaw/c_scattergun',
  );

  const history = new SnapshotHistory<ProtoDefKitMessages>();
  history.record(original);
  assert.equal(history.undo(edited), original);
  assert.equal(history.redo(original), edited);
});
