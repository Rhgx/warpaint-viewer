// CPU group-map sampling parity check.
//
//   node tools/verify/editor/group-sampling.mjs
//
// Bundles the TypeScript source with Vite so this check exercises the same
// module the browser editor will import.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'group-sampling-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', 'src/editor/groupSampling.ts', '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('vite SSR build of group sampling failed');
  return pathToFileURL(path.join(BUILD_DIR, 'groupSampling.js')).href;
}

let failures = 0;
function check(label, condition, detail = '') {
  if (condition) console.log(`ok - ${label}`);
  else {
    failures++;
    console.error(`not ok - ${label}${detail ? ` (${detail})` : ''}`);
  }
}

try {
  const {
    groupTexelAtUv,
    groupByteToCompositorBucket,
    rawGroupIdForBucket,
    sampleGroupAtUv,
    sampleGroupRedAtUv,
  } = await import(bundleModule());
  // Deliberately asymmetric rows prove V is source-image-down, not flipped.
  const image = {
    width: 2,
    height: 2,
    data: new Uint8ClampedArray([
      16, 0, 0, 255, 31, 0, 0, 255,
      32, 0, 0, 255, 255, 0, 0, 255,
    ]),
  };

  check('top-left UV samples first source row', sampleGroupAtUv(image, 0, 0)?.red === 16);
  check('bottom-left UV samples second source row (V-down)', sampleGroupAtUv(image, 0, 0.75)?.red === 32);
  check('right/bottom edges clamp to the last texel', JSON.stringify(groupTexelAtUv(image, 1, 1)) === JSON.stringify({ x: 1, y: 1 }));
  check('outside and non-finite UVs reject', groupTexelAtUv(image, -0.001, 0) === null && groupTexelAtUv(image, 0, Number.NaN) === null);
  check('red-channel sampling ignores green/blue/alpha', sampleGroupRedAtUv(image, 0.75, 0) === 31);
  check('bucketing rounds at the fxc 1/16 boundary', groupByteToCompositorBucket(23) === 1 && groupByteToCompositorBucket(24) === 2);
  check('bucket 16 supports raw byte 255', sampleGroupAtUv(image, 1, 1)?.bucket === 16);
  check(
    'visible buckets convert back to authored selector IDs',
    rawGroupIdForBucket(1) === 16
      && rawGroupIdForBucket(15) === 240
      && rawGroupIdForBucket(16) === 255
      && rawGroupIdForBucket(0) === null,
  );
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

if (failures > 0) process.exitCode = 1;
else console.log('[verify] group sampling passed');
