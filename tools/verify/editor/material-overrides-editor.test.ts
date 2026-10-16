import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  setWeaponMaterialOverrides,
  type WeaponMaterialUpdate,
} from '../../../src/editor/mutations';
import type { ProtoDefKitMessages } from '../../../src/protodefs/types';
import { dig } from '../fixtures';

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

test('material overrides update both weapons and ignore no-op writes', () => {
  const original = fixture();
  const noOp = setWeaponMaterialOverrides(original, [{
    target: { weaponKey: 'rocketlauncher', path: ['definition', 'rocketlauncher'] },
    overridePath: ' models/paintkits/macaw/c_rocketlauncher ',
  }]);
  assert.equal(noOp, original);

  const edited = setWeaponMaterialOverrides(original, updates);
  assert.notEqual(edited, original);
  assert.equal(dig(edited.definition, 'rocketlauncher', 'data', 'material_override'), undefined);
  assert.equal(dig(edited.definition, 'scattergun', 'data', 'material_override'), 'models/paintkits/macaw/c_scattergun');
});
