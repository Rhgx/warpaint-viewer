// Contract checks for curated, user-facing paintable-weapon group names.

import assert from 'node:assert/strict';
import {
  test,
} from 'vitest';
import {
  lookupGroupName,
  loadGroupNameReference,
  lookupGroupNameForBucket,
  compatibleGroupTextures,
  preferredAlbedoGroupIds,
  lookupGroupNameWeapon,
  normalizeGroupTextureReference,
  formatGroupNameForDisplay,
} from '../../../src/editor/groupNames';

test('curated group names', async () => {
  assert.equal(
    lookupGroupName('models/workshop/weapons/c_models/c_amputator/p_amputator_groups', 16),
    null,
  );
  await loadGroupNameReference();
  const amputator = 'models/workshop/weapons/c_models/c_amputator/p_amputator_groups';
  assert.equal(lookupGroupName(amputator, 16), 'Knuckle Guard');
  assert.equal(lookupGroupName(`materials\\${amputator}.vtf`, 255), 'Blade');
  assert.equal(lookupGroupNameForBucket(`textures/${amputator}.webp`, 1), 'Knuckle Guard');
  assert.equal(lookupGroupNameForBucket(amputator, 16), 'Blade');
  assert.equal(
    lookupGroupNameForBucket('textures/models/items/paintkit_tool/p_paintkit_tool_groups_three.webp', 2),
    'Center Display',
  );
  assert.equal(
    lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 32),
    'Left Paint Can Cap',
  );
  assert.equal(
    lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 96),
    'Right Paint Can Cap',
  );
  assert.equal(
    lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four', 48),
    'Top Display',
  );
  assert.equal(
    lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four', 16),
    'Bottom Display',
  );
  const paintkitLayouts = compatibleGroupTextures(
    'textures/models/items/paintkit_tool/p_paintkit_tool_groups_three.webp',
  );
  assert.equal(paintkitLayouts.length, 7);
  assert.deepEqual(paintkitLayouts.map((layout) => layout.label), [
    'Layout 1', 'Layout 2', 'Layout 3', 'Layout 4', 'Layout 5', 'Layout 6', 'Layout 7',
  ]);
  assert.deepEqual(
    preferredAlbedoGroupIds('models/items/paintkit_tool/p_paintkit_tool_groups_four'),
    [192, 255],
  );
  assert.deepEqual(
    preferredAlbedoGroupIds('models/items/paintkit_tool/p_paintkit_tool_groups_left'),
    [144, 160, 176, 192],
  );
  assert.deepEqual(preferredAlbedoGroupIds(amputator), []);
  assert.equal(
    lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_02', 192),
    'Canvas Back Cross Brace',
  );
  assert.equal(
    lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_three', 224),
    'Left Paint Can Cap',
  );
  assert.equal(
    lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 128),
    'Paint Can Bodies',
  );
  assert.equal(
    lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 160),
    'Center Paint Can Label',
  );
  assert.equal(
    lookupGroupName('models/items/paintkit_tool/p_paintkit_tool_groups_four_equal', 208),
    'Canvas Back Panel',
  );
  assert.equal(lookupGroupNameWeapon(amputator), 'Amputator');
  assert.equal(lookupGroupName(amputator, 0), null);
  assert.equal(lookupGroupName('models/not-in-reference/p_groups', 16), null);
  assert.equal(normalizeGroupTextureReference(`materials\\${amputator}.webp`), amputator);
  const flamethrower = 'models/weapons/c_models/c_flamethrower/p_flamethrower_groups';
  const fullFlamethrowerName = 'Pump Knuckle Guards + Wire Grommets + Hose Knobs near Tank + Pump Hose Gland + Hose Structure near Pump (sans Bolt Neck)';
  assert.equal(lookupGroupName(flamethrower, 96), fullFlamethrowerName);
  assert.equal(formatGroupNameForDisplay(fullFlamethrowerName), 'Pump Knuckle Guards + 4 more');
  assert.equal(formatGroupNameForDisplay('Pump Wires (though the wear texture always zeroes this out)'), 'Pump Wires');
  assert.equal(formatGroupNameForDisplay('Barrel Between Rearmost and Foremost Barrel Bracket'), 'Barrel Between Rearmost and Foremost…');
  assert.ok(formatGroupNameForDisplay(fullFlamethrowerName).length <= 42);

  const rocketLayouts = compatibleGroupTextures(
    'textures/models/weapons/c_models/c_rocketlauncher/p_rocketlauncher_groups_04.webp',
  );
  assert.deepEqual(rocketLayouts.map((entry) => entry.label), [
    'Layout 1', 'Layout 2', 'Layout 3', 'Layout 4', 'Layout 5',
  ]);
  assert.equal(rocketLayouts[2]?.ref, 'models/weapons/c_models/c_rocketlauncher/p_rocketlauncher_groups03');
  assert.equal(
    lookupGroupName('models/weapons/c_models/c_knife/p_knife_groups02', 16),
    'Grip Fore Left',
  );
  assert.equal(
    lookupGroupName('models/weapons/c_models/c_smg/p_smg_groups_03', 32),
    'Trigger',
  );
  assert.deepEqual(compatibleGroupTextures('models/not-in-reference/p_groups'), []);
});
