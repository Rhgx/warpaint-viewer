import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { kvGet } from '../lib/kv.mjs';
import { encodePNG } from '../lib/png.mjs';
import { decodeVTF } from '../lib/vtf.mjs';
import { extractBatch, listVPK, MISC_VPK, TEXTURES_VPK } from '../lib/vpk.mjs';
import { sha1 } from './state.mjs';

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
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, encodePNG(decoded.rgba, decoded.width, decoded.height));
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
