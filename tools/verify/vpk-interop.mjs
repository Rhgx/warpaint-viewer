// Optional interoperability check for writeVpk() against Valve's vpk.exe.
//
//   node tools/verify/vpk-write.mjs
//
// src/export/vpkWrite.ts and src/source/vpk.ts are TypeScript; as in
// tools/verify/protodefs.mjs, they are
// bundled with vite's SSR build into staging/ so this plain node script can
// import them directly. Node 22 provides a global File, so the written bytes
// can be handed straight to openVpkPackage() without a browser.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeVTF } from '../lib/vtf.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STAGING = path.join(ROOT, 'staging');
const BUILD_DIR = path.join(STAGING, 'vpk-write-verify');

function bundleModules() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const entry = path.join(STAGING, 'vpk-write-verify-entry.ts');
  fs.writeFileSync(entry, [
    "export { writeVpk } from '../src/export/vpkWrite';",
    "export { encodeVtf } from '../src/export/vtfEncode';",
    '',
  ].join('\n'));
  // Spawn vite's bin through node rather than npx: npx resolves differently on
  // Windows and this script also runs from git worktrees, where node_modules is
  // found by walking up rather than sitting alongside.
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(
    process.execPath,
    [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'],
    { cwd: ROOT, stdio: 'inherit', shell: false },
  );
  if (result.status !== 0) throw new Error('vite ssr build of the VPK/VTF writers failed');
  return pathToFileURL(path.join(BUILD_DIR, 'vpk-write-verify-entry.js')).href;
}

console.log('[verify] bundling the VPK and VTF writers ...');
const { writeVpk, encodeVtf } = await import(bundleModules());

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
  return condition;
}

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

const VPK_EXE = 'C:/Program Files (x86)/Steam/steamapps/common/Team Fortress 2/bin/vpk.exe';

if (!fs.existsSync(VPK_EXE)) {
  console.log('[verify] skipped the vpk.exe cross-check, TF2 is not installed at the expected path');
} else {
  const interopDir = path.join(STAGING, 'vpk-interop');
  fs.rmSync(interopDir, { recursive: true, force: true });
  fs.mkdirSync(interopDir, { recursive: true });
  const archive = path.join(interopDir, 'ours.vpk');
  fs.writeFileSync(archive, bytes);

  const listed = spawnSync(VPK_EXE, ['l', archive], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const listedPaths = new Set(
    (listed.stdout ?? '').split(/\r?\n/).map((line) => line.trim().replace(/\\/g, '/').toLowerCase()).filter(Boolean),
  );
  check(listed.status === 0, `vpk.exe l exited ${listed.status}`);
  for (const file of files) {
    check(listedPaths.has(file.path.toLowerCase()), `vpk.exe did not list "${file.path}"`);
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
  check(extracted.status === 0, `vpk.exe x exited ${extracted.status}`);
  for (const file of files) {
    const target = path.join(extractDir, file.path);
    if (!check(fs.existsSync(target), `vpk.exe did not extract "${file.path}"`)) continue;
    const round = new Uint8Array(fs.readFileSync(target));
    check(
      bytesEqual(round, file.data),
      `vpk.exe extracted "${file.path}" with different bytes (${round.byteLength} vs ${file.data.byteLength})`,
    );
  }
  console.log(`[verify] vpk.exe listed and extracted all ${files.length} entries with matching bytes`);
}

// --- 7. The real thing: a VTF packed, extracted by vpk.exe, then decoded ----
//
// Sections 1 to 6 use synthetic payloads. This one runs the combination that
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
  const packDir = path.join(STAGING, 'vpk-interop', 'realistic');
  fs.rmSync(packDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(packDir, path.dirname(packPath)), { recursive: true });
  const packArchive = path.join(packDir, 'mypaint.vpk');
  fs.writeFileSync(packArchive, writeVpk([{ path: packPath, data: vtf }]));

  const pulled = spawnSync(VPK_EXE, ['x', packArchive, packPath], { cwd: packDir, encoding: 'utf8' });
  check(pulled.status === 0, `vpk.exe x exited ${pulled.status} on the realistic pack`);
  const extractedVtf = fs.readFileSync(path.join(packDir, packPath));
  check(bytesEqual(new Uint8Array(extractedVtf), vtf), 'vpk.exe extracted a different VTF than was packed');
  const decoded = decodeVTF(extractedVtf);
  check(
    decoded.width === size && decoded.height === size,
    `decoded ${decoded.width}x${decoded.height} from the extracted VTF, expected ${size}x${size}`,
  );
  console.log(`[verify] a ${vtf.byteLength}-byte VTF survived writeVpk -> vpk.exe x -> decodeVTF intact`);
}

// --- Report -------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\n[verify] FAIL: ${failures.length} check(s) failed:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\n[verify] PASS: writeVpk() interoperates with Valve\'s tooling when available.');
