import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { kvGet } from '../lib/kv.mjs';
import { encodePNG } from '../lib/png.mjs';
import { decodeVTF } from '../lib/vtf.mjs';
import { extractBatch, listVPK, MISC_VPK, TEXTURES_VPK } from '../lib/vpk.mjs';
import { sha1 } from './state.mjs';

// Inventory icons ship at 512px but the UI never draws them above 28px; 64px
// covers high-DPI screens at a tenth of the download.
const INVENTORY_ICON_MAX = 64;

// Halves with a 2x2 box filter (alpha-weighted, so transparent edges do not
// bleed dark) until the image fits. VTF sizes are powers of two.
export function downscaleRGBA(rgba, width, height, max) {
  while (Math.max(width, height) > max && width > 1 && height > 1) {
    const w = width >> 1;
    const h = height >> 1;
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
          const i = ((y * 2 + dy) * width + x * 2 + dx) * 4;
          const alpha = rgba[i + 3];
          r += rgba[i] * alpha; g += rgba[i + 1] * alpha; b += rgba[i + 2] * alpha; a += alpha;
        }
        const o = (y * w + x) * 4;
        if (a > 0) {
          out[o] = Math.round(r / a); out[o + 1] = Math.round(g / a); out[o + 2] = Math.round(b / a);
        }
        out[o + 3] = Math.round(a / 4);
      }
    }
    rgba = out;
    width = w;
    height = h;
  }
  return { rgba, width, height };
}

const PAINT_ICON_JUNK = /blank_|paint_dirt|paint_blood|paint_scratches|_wearblend|_ao\.|_albedo\./;

export function pickPaintIconRef(tree) {
  const ordered = [];
  walkTree(tree, (node) => {
    if (node.type === 'texture_lookup' && node.texture) ordered.push(node.texture);
  });
  const patterns = ordered.filter((ref) => ref.startsWith('textures/patterns/') && !PAINT_ICON_JUNK.test(ref));
  return patterns.find((ref) => !/\/solid_/.test(ref)) || patterns[0] || null;
}

export function generatePaintIcons({
  manifestPaintkits, paintIconRefByKit, publicDataPath, stagingPath, force = false, log = console.log,
}) {
  const magick = spawnSync('magick', ['-version'], { stdio: 'ignore', shell: false });
  const magickAvailable = !(magick.error || magick.status !== 0);
  if (!magickAvailable) log('[icons] ImageMagick (magick) not found; will not be able to swatch missing paintkit thumbnails');
  const outputDirectory = path.join(publicDataPath, 'icons', 'paints');
  fs.mkdirSync(outputDirectory, { recursive: true });
  const statePath = path.join(stagingPath, 'swatch_icons.json');
  const validIds = new Set(manifestPaintkits.map((paintkit) => paintkit.id));
  const swatchedIds = new Set([...loadSwatchedIds(statePath)].filter((id) => validIds.has(id)));
  let kept = 0;
  let swatched = 0;
  let missing = 0;
  for (const paintkit of manifestPaintkits) {
    const outputRef = `icons/paints/${paintkit.id}.png`;
    const outputPath = path.join(publicDataPath, outputRef);
    if (fs.existsSync(outputPath) && !(force && swatchedIds.has(paintkit.id))) {
      paintkit.icon = outputRef;
      kept++;
      continue;
    }
    const sourceRef = paintIconRefByKit.get(paintkit.id);
    const sourcePath = sourceRef && path.join(publicDataPath, sourceRef);
    if (!magickAvailable || !sourcePath || !fs.existsSync(sourcePath)) {
      missing++;
      continue;
    }
    const result = spawnSync('magick', [sourcePath, '-resize', '96x96^', '-gravity', 'center', '-extent', '96x96', outputPath], { stdio: 'ignore', shell: false });
    if (result.status === 0) {
      paintkit.icon = outputRef;
      swatchedIds.add(paintkit.id);
      swatched++;
    } else {
      missing++;
    }
  }
  fs.mkdirSync(stagingPath, { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify([...swatchedIds].sort((a, b) => a - b)));
  log(`[icons] paintkit thumbnails: ${kept} kept, ${swatched} swatched, ${missing} without one`);
}

export function extractInventoryIcons({
  itemsGame, weaponRegistry, machineByDisplay, resolveItemField,
  publicDataPath, stagingPath, vpkChanged = true, force = false, prevHashes = {}, log = console.log,
}) {
  const textures = listVPK(TEXTURES_VPK);
  const misc = listVPK(MISC_VPK);
  const stagingDirectory = path.join(stagingPath, 'extracted');
  fs.mkdirSync(stagingDirectory, { recursive: true });
  const jobs = [];
  for (const weapon of weaponRegistry.values()) {
    const item = kvGet(itemsGame.items, String(weapon.itemDefIndex));
    const image = item ? resolveItemField(itemsGame, item, 'image_inventory') : null;
    if (!image) continue;
    const base = String(image).replace(/\\/g, '/').toLowerCase();
    jobs.push({
      outRel: `icons/weapons/${weapon.key}.png`,
      candidates: [`materials/${base}_large.vtf`, `materials/${base}.vtf`],
      assign: (ref) => { weapon.icon = ref; },
    });
  }

  const machineToImage = new Map();
  for (const item of Object.values(itemsGame.items)) {
    if (!item || typeof item !== 'object') continue;
    const collection = resolveItemField(itemsGame, item, 'collection_reference');
    const image = resolveItemField(itemsGame, item, 'image_inventory');
    if (!collection || !image) continue;
    const key = String(collection).toLowerCase();
    if (!machineToImage.has(key)) machineToImage.set(key, String(image).replace(/\\/g, '/').toLowerCase());
  }
  const collectionIcons = {};
  for (const [displayName, machineName] of machineByDisplay) {
    const image = machineToImage.get(String(machineName).toLowerCase());
    if (!image) continue;
    jobs.push({
      outRel: `icons/collections/${slugify(machineName)}.png`,
      candidates: [`materials/${image}_large.vtf`, `materials/${image}.vtf`],
      assign: (ref) => { collectionIcons[displayName] = ref; },
    });
  }

  for (const job of jobs) {
    job.vpkPath = job.candidates.find((candidate) => textures.has(candidate)) || null;
    job.vpkSource = TEXTURES_VPK;
    if (!job.vpkPath) {
      job.vpkPath = job.candidates.find((candidate) => misc.has(candidate)) || null;
      job.vpkSource = MISC_VPK;
    }
    job.outExists = fs.existsSync(path.join(publicDataPath, job.outRel));
    job.skipExtraction = job.vpkPath && !force && !vpkChanged && job.outExists;
  }
  extractBatch(TEXTURES_VPK, jobs.filter((job) => job.vpkPath && !job.skipExtraction && job.vpkSource === TEXTURES_VPK).map((job) => job.vpkPath), stagingDirectory);
  extractBatch(MISC_VPK, jobs.filter((job) => job.vpkPath && !job.skipExtraction && job.vpkSource === MISC_VPK).map((job) => job.vpkPath), stagingDirectory);

  let unchanged = 0;
  let rebuilt = 0;
  let unavailable = 0;
  const hashes = {};
  for (const job of jobs) {
    if (!job.vpkPath) {
      unavailable++;
      continue;
    }
    const outputPath = path.join(publicDataPath, job.outRel);
    if (job.skipExtraction) {
      job.assign(job.outRel);
      if (prevHashes[job.outRel]) hashes[job.outRel] = prevHashes[job.outRel];
      unchanged++;
      continue;
    }
    try {
      const buffer = fs.readFileSync(path.join(stagingDirectory, job.vpkPath));
      const hash = sha1(buffer);
      if (!force && job.outExists && prevHashes[job.outRel] === hash) {
        job.assign(job.outRel);
        hashes[job.outRel] = hash;
        unchanged++;
        continue;
      }
      const decoded = decodeVTF(buffer);
      const icon = downscaleRGBA(decoded.rgba, decoded.width, decoded.height, INVENTORY_ICON_MAX);
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, encodePNG(icon.rgba, icon.width, icon.height));
      job.assign(job.outRel);
      hashes[job.outRel] = hash;
      rebuilt++;
    } catch (error) {
      unavailable++;
      log(`[icons] failed ${job.outRel}: ${error.message}`);
    }
  }
  log(`[icons] icons: ${unchanged} unchanged, ${rebuilt} (re)built (${Object.keys(collectionIcons).length} collections), ${unavailable} unavailable`);
  return { collectionIcons, hashes };
}

function loadSwatchedIds(statePath) {
  if (!fs.existsSync(statePath)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(statePath, 'utf8'))); } catch { return new Set(); }
}

function walkTree(node, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node.nodes)) node.nodes.forEach((child) => walkTree(child, visit));
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
