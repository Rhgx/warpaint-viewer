import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { writeVpk } from '../../../src/export/vpkWrite';
import { encodeVtf } from '../../../src/export/vtfEncode';
import { decodeVTF } from '../../lib/vtf.mjs';
import { ROOT } from '../fixtures';

const STAGING = path.join(ROOT, 'staging');
const VPK_EXE = process.env.TF2_VPK_EXE ?? 'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2/bin/vpk.exe';

// Deterministic content, so a slipped offset or a swapped entry shows up as a mismatch.
function fillPattern(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 2654435761) % 256;
  return bytes;
}

function bytesEqual(a, b) {
  return a.byteLength === b.byteLength && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// Our reader agreeing with our writer proves nothing about the tools people install mods with,
// so TF2's own vpk.exe lists and extracts our archives. vpk.exe locates the data section at a
// fixed offset after the tree, which is how a bad version-1 header extracted shifted garbage.
test('VPK and VTF survive Valve tooling', (context) => {
  if (!fs.existsSync(VPK_EXE)) {
    assert.ok(!process.env.TF2_VPK_EXE, `Missing vpk.exe: ${VPK_EXE}`);
    context.skip('Valve vpk.exe is unavailable');
    return;
  }

  const files = [
    { path: 'readme.txt', data: new TextEncoder().encode('root file at the archive root') },
    { path: 'Materials/Patterns/MyPaint/Deep/Nested/Path/base.vtf', data: fillPattern(4096) },
    { path: 'materials/patterns/mypaint/base_normal.vtf', data: fillPattern(2048) },
    { path: 'materials/patterns/mypaint/base.vmt', data: new TextEncoder().encode('"vertexlitgeneric" { }') },
    { path: 'materials/patterns/mypaint/large.vtf', data: fillPattern(6 * 1024 * 1024) },
  ];
  fs.mkdirSync(STAGING, { recursive: true });
  const interopDir = fs.mkdtempSync(path.join(STAGING, 'vpk-interop-'));
  context.onTestFinished(() => fs.rmSync(interopDir, { recursive: true, force: true }));
  const archive = path.join(interopDir, 'ours.vpk');
  fs.writeFileSync(archive, writeVpk(files));

  const listed = spawnSync(VPK_EXE, ['l', archive], { encoding: 'utf8', maxBuffer: 1 << 28 });
  assert.equal(listed.status, 0, 'vpk.exe l failed');
  const listedPaths = new Set(
    (listed.stdout ?? '').split(/\r?\n/).map((line) => line.trim().replace(/\\/g, '/').toLowerCase()).filter(Boolean),
  );
  for (const file of files) assert.ok(listedPaths.has(file.path.toLowerCase()), `vpk.exe did not list "${file.path}"`);

  // vpk.exe writes relative to cwd and will not create parent directories.
  const extractDir = path.join(interopDir, 'extracted');
  for (const file of files) fs.mkdirSync(path.join(extractDir, path.dirname(file.path)), { recursive: true });
  const extracted = spawnSync(VPK_EXE, ['x', archive, ...files.map((file) => file.path)], { cwd: extractDir, encoding: 'utf8' });
  assert.equal(extracted.status, 0, 'vpk.exe x failed');
  for (const file of files) {
    const target = path.join(extractDir, file.path);
    assert.ok(fs.existsSync(target), `vpk.exe did not extract "${file.path}"`);
    assert.ok(bytesEqual(new Uint8Array(fs.readFileSync(target)), file.data), `vpk.exe extracted "${file.path}" with different bytes`);
  }

  // The shipping combination: encodeVtf output inside writeVpk, pulled out by vpk.exe and
  // decoded by the extraction pipeline's own VTF reader.
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) pixels.set([x * 4, y * 4, 128, 255], (y * size + x) * 4);
  }
  const vtf = encodeVtf({ width: size, height: size, pixels });
  const packPath = 'materials/patterns/workshop/mypaint/base.vtf';
  const packDir = path.join(interopDir, 'realistic');
  fs.mkdirSync(path.join(packDir, path.dirname(packPath)), { recursive: true });
  const packArchive = path.join(packDir, 'mypaint.vpk');
  fs.writeFileSync(packArchive, writeVpk([{ path: packPath, data: vtf }]));
  const pulled = spawnSync(VPK_EXE, ['x', packArchive, packPath], { cwd: packDir, encoding: 'utf8' });
  assert.equal(pulled.status, 0, 'vpk.exe x failed on the realistic pack');
  const extractedVtf = fs.readFileSync(path.join(packDir, packPath));
  assert.ok(bytesEqual(new Uint8Array(extractedVtf), vtf), 'vpk.exe extracted a different VTF than was packed');
  const decoded = decodeVTF(extractedVtf);
  assert.deepEqual([decoded.width, decoded.height], [size, size]);
}, 30000);
