// Contract checks for curated, user-facing paintable-weapon group names.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import * as implementation from '../../../src/editor/groupNames';

test('curated group names', async () => {
  assert.equal(
    implementation.lookupGroupName('models/workshop/weapons/c_models/c_amputator/p_amputator_groups', 16),
    null,
  );
  await implementation.loadGroupNameReference();
  const amputator = 'models/workshop/weapons/c_models/c_amputator/p_amputator_groups';
  assert.equal(implementation.lookupGroupName(amputator, 16), 'Knuckle Guard');
  assert.equal(implementation.lookupGroupName(`materials\\${amputator}.vtf`, 255), 'Blade');
  assert.equal(implementation.lookupGroupNameForBucket(`textures/${amputator}.webp`, 1), 'Knuckle Guard');
  assert.equal(implementation.lookupGroupNameForBucket(amputator, 16), 'Blade');
  assert.equal(
    implementation.lookupGroupNameForBucket('textures/models/items/paintkit_tool/p_paintkit_tool_groups_three.webp', 2),
    'Center Display',
  );
  assert.equal(
    implementation.lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 32),
    'Left Paint Can Cap',
  );
  assert.equal(
    implementation.lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 96),
    'Right Paint Can Cap',
  );
  assert.equal(
    implementation.lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four', 48),
    'Top Display',
  );
  assert.equal(
    implementation.lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four', 16),
    'Bottom Display',
  );
  const paintkitLayouts = implementation.compatibleGroupTextures(
    'textures/models/items/paintkit_tool/p_paintkit_tool_groups_three.webp',
  );
  assert.equal(paintkitLayouts.length, 7);
  assert.deepEqual(paintkitLayouts.map((layout) => layout.label), [
    'Layout 1', 'Layout 2', 'Layout 3', 'Layout 4', 'Layout 5', 'Layout 6', 'Layout 7',
  ]);
  assert.deepEqual(
    implementation.preferredAlbedoGroupIds('models/items/paintkit_tool/p_paintkit_tool_groups_four'),
    [192, 255],
  );
  assert.deepEqual(
    implementation.preferredAlbedoGroupIds('models/items/paintkit_tool/p_paintkit_tool_groups_left'),
    [144, 160, 176, 192],
  );
  assert.deepEqual(implementation.preferredAlbedoGroupIds(amputator), []);
  assert.equal(
    implementation.lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_02', 192),
    'Canvas Back Cross Brace',
  );
  assert.equal(
    implementation.lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_three', 224),
    'Left Paint Can Cap',
  );
  assert.equal(
    implementation.lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 128),
    'Paint Can Bodies',
  );
  assert.equal(
    implementation.lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 160),
    'Center Paint Can Label',
  );
  assert.equal(
    implementation.lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 208),
    'Canvas Back Panel',
  );
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

  const rocketLayouts = implementation.compatibleGroupTextures(
    'textures/models/weapons/c_models/c_rocketlauncher/p_rocketlauncher_groups_04.webp',
  );
  assert.deepEqual(rocketLayouts.map((entry) => entry.label), [
    'Layout 1', 'Layout 2', 'Layout 3', 'Layout 4', 'Layout 5',
  ]);
  assert.equal(rocketLayouts[2]?.ref, 'models/weapons/c_models/c_rocketlauncher/p_rocketlauncher_groups03');
  assert.deepEqual(implementation.compatibleGroupTextures('models/not-in-reference/p_groups'), []);
});
