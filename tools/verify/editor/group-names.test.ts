// Contract checks for curated, user-facing paintable-weapon group names.

import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  formatGroupNameForDisplay,
  groupTextureLoadRef,
  loadGroupNameReference,
  lookupGroupName,
  lookupGroupNameForBucket,
  normalizeGroupTextureReference,
} from '../../../src/editor/layers/groupNames';

const amputator = 'models/workshop/weapons/c_models/c_amputator/p_amputator_groups';

test('group names resolve from any spelling of the texture path, by raw id or by bucket', async () => {
  assert.equal(lookupGroupName(amputator, 16), null, 'nothing resolves before the reference loads');
  await loadGroupNameReference();
  assert.equal(normalizeGroupTextureReference(`materials\\${amputator}.webp`), amputator);
  assert.equal(lookupGroupName(`materials\\${amputator}.vtf`, 255), 'Blade');
  assert.equal(lookupGroupNameForBucket(`textures/${amputator}.webp`, 1), 'Knuckle Guard');
  assert.equal(lookupGroupNameForBucket(amputator, 16), 'Blade');
  assert.equal(lookupGroupName(amputator, 0), null);
  assert.equal(lookupGroupName('models/not-in-reference/p_groups', 16), null);
});

test('long group names are shortened for display', () => {
  const full = 'Pump Knuckle Guards + Wire Grommets + Hose Knobs near Tank + Pump Hose Gland + Hose Structure near Pump (sans Bolt Neck)';
  assert.equal(formatGroupNameForDisplay(full), 'Pump Knuckle Guards + 4 more');
  assert.equal(formatGroupNameForDisplay('Pump Wires (though the wear texture always zeroes this out)'), 'Pump Wires');
  assert.equal(formatGroupNameForDisplay('Barrel Between Rearmost and Foremost Barrel Bracket'), 'Barrel Between Rearmost and Foremost…');
});

test('a group texture picked from the layout list loads by its public texture path', () => {
  // The list values are normalized material paths, which name no file.
  assert.equal(
    groupTextureLoadRef('models/weapons/c_models/c_rocketlauncher/p_rocketlauncher_groups_02'),
    'textures/models/weapons/c_models/c_rocketlauncher/p_rocketlauncher_groups_02.webp',
  );
});
