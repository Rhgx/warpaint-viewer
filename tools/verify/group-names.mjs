// Contract checks for curated, user-facing paintable-weapon group names.
//
//   node tools/verify/group-names.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'group-names-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const entry = path.join(ROOT, 'staging', 'group-names-verify-entry.ts');
  fs.writeFileSync(entry,
    "export { formatGroupNameForDisplay, lookupGroupName, lookupGroupNameForBucket, lookupGroupNameWeapon, normalizeGroupTextureReference } from '../src/editor/groupNames';\n",
  );
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(process.execPath, [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) throw new Error('vite SSR build of group names failed');
  return pathToFileURL(path.join(BUILD_DIR, 'group-names-verify-entry.js')).href;
}

try {
  const implementation = await import(bundleModule());
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
  console.log('[verify] group names passed');
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}
