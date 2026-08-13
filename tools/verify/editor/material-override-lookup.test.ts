import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { SourcePackage } from '../../../src/source/contracts';
import { indexPackageMaterialPaths, packageHasMaterialOverride } from '../../../src/source/vmt';

function fixturePackage(paths: readonly string[]): SourcePackage {
  const entries = new Map(paths.map((path) => [path, { path, size: 1 }]));
  return {
    id: 'materials',
    name: 'materials.zip',
    format: 'zip',
    entries,
    rootIsMaterials: false,
    has: (path) => entries.has(path),
    read: async () => new Uint8Array([0]),
    dispose() {},
  };
}

test('material override archive lookup accepts exact and uniquely relocated VMTs', () => {
  const exact = indexPackageMaterialPaths(fixturePackage([
    'materials/models/paintkits/macaw/c_blackbox.vmt',
  ]));
  assert.equal(packageHasMaterialOverride(exact, 'models/paintkits/macaw/c_blackbox'), true);
  assert.equal(packageHasMaterialOverride(exact, 'materials/models/paintkits/macaw/c_blackbox.vmt'), true);

  const relocated = indexPackageMaterialPaths(fixturePackage([
    'materials/custom/vmts/c_blackbox.vmt',
  ]));
  assert.equal(packageHasMaterialOverride(relocated, 'models/paintkits/macaw/c_blackbox'), true);
});

test('material override archive lookup rejects ambiguous and absent VMTs', () => {
  const ambiguous = indexPackageMaterialPaths(fixturePackage([
    'materials/first/c_blackbox.vmt',
    'materials/second/c_blackbox.vmt',
  ]));
  assert.equal(packageHasMaterialOverride(ambiguous, 'models/paintkits/macaw/c_blackbox'), false);
  assert.equal(packageHasMaterialOverride(ambiguous, 'models/paintkits/macaw/c_scattergun'), false);
});
