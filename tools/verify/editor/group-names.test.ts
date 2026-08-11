// Contract checks for curated, user-facing paintable-weapon group names.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as implementation from '../../../src/editor/groupNames';

test('curated group names', () => {
  const amputator = 'models/workshop/weapons/c_models/c_amputator/p_amputator_groups';
  assert.equal(implementation.lookupGroupName(amputator, 16), 'Knuckle Guard');
  assert.equal(implementation.lookupGroupName(`materials\\${amputator}.vtf`, 255), 'Blade');
  assert.equal(implementation.lookupGroupNameForBucket(`textures/${amputator}.webp`, 1), 'Knuckle Guard');
  assert.equal(implementation.lookupGroupNameForBucket(amputator, 16), 'Blade');
  assert.equal(implementation.lookupGroupNameWeapon(amputator), 'Amputator');
  assert.equal(implementation.lookupGroupName(amputator, 0), null);
  assert.equal(implementation.lookupGroupName('models/not-in-reference/p_groups', 16), null);
  assert.equal(implementation.normalizeGroupTextureReference(`materials\\${amputator}.webp`), amputator);
  const flamethrower = 'models/weapons/c_models/c_flamethrower/p_flamethrower_groups';
  const fullFlamethrowerName = 'Pump Knuckle Guards + Wire Grommets + Hose Knobs near Tank + Pump Hose Gland + Hose Structure near Pump (sans Bolt Neck)';
  assert.equal(implementation.lookupGroupName(flamethrower, 96), fullFlamethrowerName);
  assert.equal(implementation.formatGroupNameForDisplay(fullFlamethrowerName), 'Pump Knuckle Guards + 4 more');
  assert.equal(implementation.formatGroupNameForDisplay('Pump Wires (though the wear texture always zeroes this out)'), 'Pump Wires');
  assert.equal(implementation.formatGroupNameForDisplay('Barrel Between Rearmost and Foremost Barrel Bracket'), 'Barrel Between Rearmost and Foremost…');
  assert.ok(implementation.formatGroupNameForDisplay(fullFlamethrowerName).length <= 42);
});
