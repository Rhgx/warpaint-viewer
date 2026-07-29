// Round-trip check for the browser-side VTF writer.
//
//   node tools/verify-vtf-export.mjs
//
// src/export/vtfEncode.ts is the inverse of tools/lib/vtf-core.mjs. Everything
// it writes is fed straight back through that decoder (the same one the app and
// the extraction pipeline use), so a layout mistake shows up as a decode failure
// or a pixel difference rather than as a texture the game silently refuses.
//
// The interesting cases are the ones where "obviously correct" code is wrong:
// mips are stored smallest first on disk, the 7.3+ resource directory sits at
// byte 80 rather than 72 because of struct padding, and RGB underneath alpha 0
// has to survive both the encoder and every mip level.
//
// The browser source is TypeScript, so it is bundled with vite's SSR build
// (already a dev dependency) into staging/ before running, matching how
// tools/verify-protodefs.mjs runs the decoder.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeVTF, parseVTFHeader } from './lib/vtf.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const STAGING = path.join(ROOT, 'staging');
const BUILD_DIR = path.join(STAGING, 'vtf-export-verify');

// A real Valve texture to re-encode, for header parity against a file the game
// itself ships. staging/ is gitignored, so a worktree does not have one: take a
// path on the command line, otherwise look in this checkout and then in the main
// one, and skip the case rather than fail when none of them is there.
const REAL_VTF_CANDIDATES = [
  process.argv[2],
  path.join(STAGING, 'materials', 'patterns', 'solid_red.vtf'),
  path.join(ROOT, '..', '..', '..', 'staging', 'materials', 'patterns', 'solid_red.vtf'),
].filter(Boolean);
const REAL_VTF = REAL_VTF_CANDIDATES.find((candidate) => fs.existsSync(candidate));

const FORMAT_BGRA8888 = 12;
const FORMAT_DXT1 = 13;
const FORMAT_DXT5 = 15;

let failures = 0;

function check(name, condition, detail) {
  if (condition) {
    console.log(`[verify] ok: ${name}${detail ? ` (${detail})` : ''}`);
    return true;
  }
  failures += 1;
  console.error(`[verify] FAIL: ${name}${detail ? `\n         ${detail}` : ''}`);
  return false;
}

function bundleEncoder() {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  const entry = path.join(STAGING, 'vtf-export-verify-entry.ts');
  fs.writeFileSync(entry, "export { encodeVtf } from '../src/export/vtfEncode';\n");
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
  if (result.status !== 0) throw new Error('vite ssr build of the encoder failed');
  return pathToFileURL(path.join(BUILD_DIR, 'vtf-export-verify-entry.js')).href;
}

// ---------------------------------------------------------------------------
// Test images
// ---------------------------------------------------------------------------

function noiseImage(width, height, seed = 1) {
  const pixels = new Uint8Array(width * height * 4);
  let state = seed;
  for (let i = 0; i < pixels.length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    pixels[i] = state >>> 24;
  }
  return { width, height, pixels };
}

function gradientImage(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      pixels[offset] = Math.round((x / Math.max(1, width - 1)) * 255);
      pixels[offset + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
      pixels[offset + 2] = 128;
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

/** Fully transparent everywhere, but with real colour underneath. */
function hiddenColorImage(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = 200;
    pixels[i + 1] = 60;
    pixels[i + 2] = 30;
    pixels[i + 3] = 0;
  }
  return { width, height, pixels };
}

/** Flat 32x32 regions holding the group ids a real weapon mask uses. */
function maskImage() {
  const size = 128;
  const ids = [48, 64, 80, 96, 128, 160, 176, 192];
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const id = ids[((y >> 5) * 4 + (x >> 5)) % ids.length];
      const offset = (y * size + x) * 4;
      pixels[offset] = id;
      pixels[offset + 1] = id;
      pixels[offset + 2] = id;
      pixels[offset + 3] = 255;
    }
  }
  return { width: size, height: size, pixels, ids };
}

/** Smooth gradients with hard-edged shapes over them, i.e. what a paint looks like. */
function artworkImage(width, height) {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const cx = x - width / 2;
      const cy = y - height / 2;
      const radius = Math.sqrt(cx * cx + cy * cy);
      const stripe = Math.sin(x * 0.12) * 0.5 + 0.5;
      const inside = radius < width * 0.3;
      pixels[offset] = Math.round(inside ? 200 : stripe * 120 + 20);
      pixels[offset + 1] = Math.round((y / height) * 180 + (inside ? 40 : 0));
      pixels[offset + 2] = Math.round(inside ? 60 : 140 - stripe * 90);
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

function psnr(a, b) {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      const diff = a[i + channel] - b[i + channel];
      sum += diff * diff;
      count += 1;
    }
  }
  const mse = sum / count;
  return mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
}

function maxAbsDiff(a, b) {
  let worst = 0;
  for (let i = 0; i < a.length; i += 1) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
}

/** Byte size of one mip level, mirroring the decoder's own sizing. */
function mipByteSize(format, width, height) {
  if (format === FORMAT_DXT1) return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * 8;
  if (format === FORMAT_DXT5) return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * 16;
  return width * height * 4;
}

async function main() {
  const { encodeVtf } = await import(bundleEncoder());

  // 1. Uncompressed round-trips byte for byte -------------------------------
  for (const [name, image] of [
    ['noise', noiseImage(64, 64)],
    ['gradient', gradientImage(64, 32)],
    ['transparent with colour underneath', hiddenColorImage(32, 32)],
  ]) {
    const file = encodeVtf({ ...image, format: 'bgra8888' });
    const decoded = decodeVTF(file);
    check(
      `BGRA8888 round-trips exactly (${name})`,
      decoded.width === image.width && decoded.height === image.height && Buffer.compare(Buffer.from(decoded.rgba), Buffer.from(image.pixels)) === 0,
      `worst channel difference ${maxAbsDiff(decoded.rgba, image.pixels)}`,
    );
  }

  // 2. The header the decoder reads back ------------------------------------
  {
    const image = gradientImage(64, 64);
    const file = encodeVtf(image);
    const header = parseVTFHeader(file);
    check('header: version 7.4', header.verMajor === 7 && header.verMinor === 4, `got ${header.verMajor}.${header.verMinor}`);
    check('header: dimensions', header.width === 64 && header.height === 64);
    check('header: opaque input picks DXT1', header.highResFormat === FORMAT_DXT1, `got format ${header.highResFormat}`);
    check('header: full mip chain', header.mipCount === 7, `got ${header.mipCount}`);
    check('header: single frame and face', header.frames === 1 && header.faces === 1 && header.depth === 1);
    check('header: size is 0x50 plus one resource entry', header.headerSize === 88, `got ${header.headerSize}`);
    check('header: image data follows the header', header.imageDataOffset === 88, `got ${header.imageDataOffset}`);
    check('header: no low-resolution thumbnail', header.lowResImageDataSize === 0);
    check('header: alpha flag stays clear on an opaque texture', (header.flags & 0x2000) === 0, `flags 0x${header.flags.toString(16)}`);

    const withAlpha = encodeVtf(hiddenColorImage(32, 32));
    const alphaHeader = parseVTFHeader(withAlpha);
    check('header: alpha input picks DXT5', alphaHeader.highResFormat === FORMAT_DXT5, `got format ${alphaHeader.highResFormat}`);
    check('header: EIGHTBITALPHA set when alpha is present', (alphaHeader.flags & 0x2000) !== 0, `flags 0x${alphaHeader.flags.toString(16)}`);

    const flagged = encodeVtf({ ...image, flags: { clampS: true, clampT: true, pointSample: true } });
    const flaggedHeader = parseVTFHeader(flagged);
    check(
      'header: sampling flags survive',
      flaggedHeader.sampling.clampS && flaggedHeader.sampling.clampT && flaggedHeader.sampling.pointSample && !flaggedHeader.sampling.noMip,
      `flags 0x${flaggedHeader.flags.toString(16)}`,
    );

    const noMip = parseVTFHeader(encodeVtf({ ...image, flags: { noMip: true } }));
    check('header: noMip emits a single level', noMip.mipCount === 1, `got ${noMip.mipCount}`);
  }

  // 3. Mip order on disk is smallest first ----------------------------------
  {
    // Four distinct rows of flat colour so each mip level has a known value,
    // uncompressed so the bytes can be read straight out of the file.
    const size = 4;
    const pixels = new Uint8Array(size * size * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 40; pixels[i + 1] = 80; pixels[i + 2] = 120; pixels[i + 3] = 255;
    }
    const file = encodeVtf({ width: size, height: size, pixels, format: 'bgra8888' });
    const header = parseVTFHeader(file);
    check('mip chain: 4x4 produces three levels', header.mipCount === 3, `got ${header.mipCount}`);
    // Smallest first means the 1x1 level (4 bytes) sits at the image offset and
    // the full 4x4 level (64 bytes) is last.
    const first = file.subarray(header.imageDataOffset, header.imageDataOffset + 4);
    check(
      'mip chain: the 1x1 level is written first',
      first[0] === 120 && first[1] === 80 && first[2] === 40 && first[3] === 255,
      `first four bytes were ${[...first].join(', ')}`,
    );
    const expected = mipByteSize(FORMAT_BGRA8888, 1, 1) + mipByteSize(FORMAT_BGRA8888, 2, 2) + mipByteSize(FORMAT_BGRA8888, 4, 4);
    check(
      'mip chain: file is exactly header plus every level',
      file.length === header.imageDataOffset + expected,
      `file ${file.length}, expected ${header.imageDataOffset + expected}`,
    );
  }

  // 4. RGB under alpha 0 survives every mip level ---------------------------
  {
    const image = hiddenColorImage(64, 64);
    const file = encodeVtf({ ...image, format: 'bgra8888' });
    const header = parseVTFHeader(file);
    let offset = header.imageDataOffset;
    let intact = true;
    let detail = '';
    for (let level = header.mipCount - 1; level >= 0; level -= 1) {
      const width = Math.max(1, header.width >> level);
      const height = Math.max(1, header.height >> level);
      const size = mipByteSize(FORMAT_BGRA8888, width, height);
      for (let i = offset; i < offset + size; i += 4) {
        // Stored BGRA, so blue is first and red is third.
        if (file[i] !== 30 || file[i + 1] !== 60 || file[i + 2] !== 200 || file[i + 3] !== 0) {
          intact = false;
          detail = `level ${level} (${width}x${height}) had ${[file[i], file[i + 1], file[i + 2], file[i + 3]].join(', ')}`;
          break;
        }
      }
      offset += size;
      if (!intact) break;
    }
    check('mip filtering keeps RGB underneath alpha 0', intact, detail);
  }

  // 5. DXT behaviour on the data that actually matters ----------------------
  {
    const mask = maskImage();
    const decoded = decodeVTF(encodeVtf({ width: mask.width, height: mask.height, pixels: mask.pixels }));
    const seen = new Set();
    let worst = 0;
    for (let i = 0; i < decoded.rgba.length; i += 4) {
      seen.add(decoded.rgba[i]);
      const original = mask.pixels[i];
      worst = Math.max(worst, Math.abs(decoded.rgba[i] - original));
    }
    check(
      'DXT1 keeps flat mask regions distinct',
      seen.size === new Set(mask.ids).size,
      `expected ${new Set(mask.ids).size} distinct values, decoded ${seen.size}`,
    );
    check(
      'DXT1 drift on flat regions stays within RGB565 quantisation',
      worst <= 4,
      `worst channel drift ${worst}`,
    );
  }

  {
    // Plausible artwork rather than noise. Uniform random pixels are the
    // pathological worst case for any block compressor (sixteen uncorrelated
    // colours fitted to four points on a line) and say nothing useful about
    // quality, so the smooth-with-edges case is the one held to a real bar.
    // 29 dB is a regression guard, not a quality target: this synthetic image
    // (a hard-edged saturated circle over stripes) measures 29.47 dB and is far
    // harsher than real artwork, because a block straddling that edge holds two
    // colour clusters and DXT1 can only fit one line through them. The real
    // Valve texture below is the actual quality bar, and it lands near 44 dB.
    const image = artworkImage(128, 128);
    const opaque = decodeVTF(encodeVtf(image));
    const quality = psnr(opaque.rgba, image.pixels);
    check('DXT1 on artwork holds its measured quality', quality > 29, `psnr ${quality.toFixed(2)} dB`);

    const translucent = artworkImage(128, 128);
    for (let i = 3; i < translucent.pixels.length; i += 4) {
      translucent.pixels[i] = (i >> 2) % 256;
    }
    const decodedAlpha = decodeVTF(encodeVtf(translucent));
    let worstAlpha = 0;
    for (let i = 3; i < translucent.pixels.length; i += 4) {
      worstAlpha = Math.max(worstAlpha, Math.abs(decodedAlpha.rgba[i] - translucent.pixels[i]));
    }
    check('DXT5 alpha ramp stays within one interpolation step', worstAlpha <= 18, `worst alpha drift ${worstAlpha}`);
  }

  // 6. A real Valve texture, re-encoded -------------------------------------
  if (!REAL_VTF) {
    console.log('[verify] skipped the real-file comparison, no solid_red.vtf found (pass a path as the first argument)');
  } else {
    const original = fs.readFileSync(REAL_VTF);
    const originalHeader = parseVTFHeader(original);
    const originalPixels = decodeVTF(original);
    const reencoded = encodeVtf({
      width: originalPixels.width,
      height: originalPixels.height,
      pixels: originalPixels.rgba,
      flags: originalHeader.sampling,
    });
    const header = parseVTFHeader(reencoded);
    check(
      `real file: matches ${path.basename(REAL_VTF)}'s dimensions, format and mip count`,
      header.width === originalHeader.width
        && header.height === originalHeader.height
        && header.highResFormat === originalHeader.highResFormat
        && header.mipCount === originalHeader.mipCount,
      `ours ${header.width}x${header.height} fmt ${header.highResFormat} mips ${header.mipCount}, `
        + `theirs ${originalHeader.width}x${originalHeader.height} fmt ${originalHeader.highResFormat} mips ${originalHeader.mipCount}`,
    );
    check(
      'real file: flags match',
      header.flags === originalHeader.flags,
      `ours 0x${header.flags.toString(16)}, theirs 0x${originalHeader.flags.toString(16)}`,
    );
    const quality = psnr(decodeVTF(reencoded).rgba, originalPixels.rgba);
    check('real file: re-encode stays above 35 dB', quality > 35, `psnr ${quality.toFixed(2)} dB`);
    check(
      'real file: image data section is the same size as the original',
      reencoded.length - header.imageDataOffset === original.length - originalHeader.imageDataOffset,
      `ours ${reencoded.length - header.imageDataOffset}, theirs ${original.length - originalHeader.imageDataOffset}`,
    );
  }

  console.log('');
  if (failures) {
    console.error(`[verify] ${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('[verify] PASS: encodeVtf() round-trips through the shipped decoder.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
