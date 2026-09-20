import assert from 'node:assert/strict';
import { test } from 'vitest';
import { writeVpk } from '../../src/export/vpkWrite';
import { encodeVtf } from '../../src/export/vtfEncode';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decodeVTF } from '../lib/vtf.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGING = path.join(ROOT, 'staging');

function fillPattern(size) {
  // Deterministic non-repeating-enough content so a slipped offset or a
  // swapped entry shows up as a mismatch rather than accidentally matching.
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 2654435761) % 256;
  return bytes;
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

test('VPK and VTF survive Valve tooling', (context) => {
  // Build representative entries for Valve's reader and extractor.

  const files = [
    { path: 'readme.txt', data: new TextEncoder().encode('root file at the archive root') },
    { path: 'Materials/Patterns/MyPaint/Deep/Nested/Path/base.vtf', data: fillPattern(4096) },
    { path: 'materials/patterns/mypaint/base_normal.vtf', data: fillPattern(2048) },
    { path: 'materials/patterns/mypaint/base.vmt', data: new TextEncoder().encode('"vertexlitgeneric" { }') },
    { path: 'materials/patterns/mypaint/large.vtf', data: fillPattern(6 * 1024 * 1024) },
  ];

  const bytes = writeVpk(files);
  // Valve's own vpk.exe is the only reader that really matters here.
  //
  // Our reader agreeing with our writer proves nothing about the tools people
  // actually install mods with. This packs the same files through TF2's shipped
  // bin/vpk.exe, extracts ours with it, and compares the bytes. It is exactly the
  // check that would have caught the version-1 header: vpk.exe locates the data
  // section at a fixed 28 bytes plus the tree, so a v1 archive listed correctly
  // and then extracted shifted-by-16 garbage.

  const VPK_EXE = process.env.TF2_VPK_EXE ?? 'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2/bin/vpk.exe';

  if (!fs.existsSync(VPK_EXE)) {
    assert.ok(!process.env.TF2_VPK_EXE, `Missing vpk.exe: ${VPK_EXE}`);
    context.skip('Valve vpk.exe is unavailable');
    return;
  } else {
    fs.mkdirSync(STAGING, { recursive: true });
    const interopDir = fs.mkdtempSync(path.join(STAGING, 'vpk-interop-'));
    context.onTestFinished(() => fs.rmSync(interopDir, { recursive: true, force: true }));
    const archive = path.join(interopDir, 'ours.vpk');
    fs.writeFileSync(archive, bytes);

    const listed = spawnSync(VPK_EXE, ['l', archive], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const listedPaths = new Set(
      (listed.stdout ?? '').split(/\r?\n/).map((line) => line.trim().replace(/\\/g, '/').toLowerCase()).filter(Boolean),
    );
    assert.ok(listed.status === 0, `vpk.exe l exited ${listed.status}`);
    for (const file of files) {
      assert.ok(listedPaths.has(file.path.toLowerCase()), `vpk.exe did not list "${file.path}"`);
    }

    // vpk.exe writes relative to cwd and will not create parent directories.
    const extractDir = path.join(interopDir, 'extracted');
    for (const file of files) {
      fs.mkdirSync(path.join(extractDir, path.dirname(file.path)), { recursive: true });
    }
    const extracted = spawnSync(VPK_EXE, ['x', archive, ...files.map((file) => file.path)], {
      cwd: extractDir,
      encoding: 'utf8',
    });
    assert.ok(extracted.status === 0, `vpk.exe x exited ${extracted.status}`);
    for (const file of files) {
      const target = path.join(extractDir, file.path);
      assert.ok(fs.existsSync(target), `vpk.exe did not extract "${file.path}"`);
      const round = new Uint8Array(fs.readFileSync(target));
      assert.ok(bytesEqual(round, file.data), `vpk.exe extracted "${file.path}" with different bytes (${round.byteLength} vs ${file.data.byteLength})`);
    }
    console.log(`[verify] vpk.exe listed and extracted all ${files.length} entries with matching bytes`);
  }

  // --- 7. The real thing: a VTF packed, extracted by vpk.exe, then decoded ----
  //
  // The first case uses synthetic payloads. This one runs the combination that
  // actually ships: encodeVtf() output inside writeVpk(), pulled back out by
  // Valve's tool and decoded by the extraction pipeline's own VTF reader. If any
  // link mangles bytes, the decode fails or the dimensions come back wrong.

  if (fs.existsSync(VPK_EXE)) {
    const size = 64;
    const pixels = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const offset = (y * size + x) * 4;
        pixels[offset] = x * 4;
        pixels[offset + 1] = y * 4;
        pixels[offset + 2] = 128;
        pixels[offset + 3] = 255;
      }
    }
    const vtf = encodeVtf({ width: size, height: size, pixels });
    const packPath = 'materials/patterns/workshop/mypaint/base.vtf';
    const packDir = fs.mkdtempSync(path.join(STAGING, 'vpk-realistic-'));
    context.onTestFinished(() => fs.rmSync(packDir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(packDir, path.dirname(packPath)), { recursive: true });
    const packArchive = path.join(packDir, 'mypaint.vpk');
    fs.writeFileSync(packArchive, writeVpk([{ path: packPath, data: vtf }]));

    const pulled = spawnSync(VPK_EXE, ['x', packArchive, packPath], { cwd: packDir, encoding: 'utf8' });
    assert.ok(pulled.status === 0, `vpk.exe x exited ${pulled.status} on the realistic pack`);
    const extractedVtf = fs.readFileSync(path.join(packDir, packPath));
    assert.ok(bytesEqual(new Uint8Array(extractedVtf), vtf), 'vpk.exe extracted a different VTF than was packed');
    const decoded = decodeVTF(extractedVtf);
    assert.ok(decoded.width === size && decoded.height === size, `decoded ${decoded.width}x${decoded.height} from the extracted VTF, expected ${size}x${size}`);
    console.log(`[verify] a ${vtf.byteLength}-byte VTF survived writeVpk -> vpk.exe x -> decodeVTF intact`);
  }

}, 30000);
