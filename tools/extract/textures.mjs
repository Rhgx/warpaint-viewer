import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

import { encodePNG } from '../lib/png.mjs';
import { decodeVTF, decodeVTFCubemap, parseVTFHeader } from '../lib/vtf.mjs';
import { extractBatch, listVPK, MISC_VPK, TEXTURES_VPK } from '../lib/vpk.mjs';
import { sha1 } from './state.mjs';

function rgbChannels(rgba) {
  const rgb = Buffer.allocUnsafe((rgba.length / 4) * 3);
  for (let source = 0, target = 0; source < rgba.length; source += 4, target += 3) {
    rgb[target] = rgba[source];
    rgb[target + 1] = rgba[source + 1];
    rgb[target + 2] = rgba[source + 2];
  }
  return rgb;
}

export async function extractAndDecodeTextures({
  allTextureRefs,
  layerPreviewRefs = new Set(),
  publicDataPath,
  stagingPath,
  vpkChanged = true,
  force = false,
  prevHashes = {},
  log = console.log,
}) {
  log('[textures] indexing vpk contents ...');
  const texturePaths = listVPK(TEXTURES_VPK);
  const miscPaths = listVPK(MISC_VPK);
  const metadataPath = path.join(stagingPath, 'texture_metadata.json');
  let previousMetadata = {};
  if (fs.existsSync(metadataPath)) {
    try { previousMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch { previousMetadata = {}; }
  }

  const wanted = [];
  for (const publicRef of allTextureRefs) {
    const relative = publicRef.replace(/^textures\//, '').replace(/\.webp$/i, '');
    const vpkPath = `materials/${relative}.vtf`.toLowerCase();
    const source = texturePaths.has(vpkPath) ? 'tex' : miscPaths.has(vpkPath) ? 'misc' : null;
    const outputExists = fs.existsSync(path.join(publicDataPath, publicRef));
    const thumbnailExists = fs.existsSync(path.join(publicDataPath, 'thumbnails', publicRef));
    wanted.push({
      pub: publicRef,
      vpk: vpkPath,
      src: source,
      outExists: outputExists,
      skipExtraction: source && !force && !vpkChanged && outputExists && previousMetadata[publicRef]
        && (!layerPreviewRefs.has(publicRef) || thumbnailExists),
    });
  }
  const missing = wanted.filter((item) => !item.src);
  log(`[textures] ${wanted.length} referenced, ${missing.length} not present in vpks`);

  const stagingMaterials = path.join(stagingPath, 'extracted');
  fs.mkdirSync(stagingMaterials, { recursive: true });
  const fromTextures = wanted.filter((item) => item.src === 'tex' && !item.skipExtraction).map((item) => item.vpk);
  const fromMisc = wanted.filter((item) => item.src === 'misc' && !item.skipExtraction).map((item) => item.vpk);
  log(`[textures] extracting ${fromTextures.length} from textures.vpk, ${fromMisc.length} from misc.vpk ...`);
  extractBatch(TEXTURES_VPK, fromTextures, stagingMaterials);
  extractBatch(MISC_VPK, fromMisc, stagingMaterials);

  log('[textures] decoding VTF -> WebP (lossless) ...');
  let unchanged = 0;
  let reencoded = 0;
  let brandNew = 0;
  let failed = 0;
  const metadata = {};
  const hashes = {};
  const failures = [];
  for (const item of wanted) {
    if (!item.src) {
      failed++;
      failures.push({ ...item, err: 'not in vpk' });
      continue;
    }
    const outputPath = path.join(publicDataPath, item.pub);
    const thumbnailPath = path.join(publicDataPath, 'thumbnails', item.pub);
    if (item.skipExtraction) {
      metadata[item.pub] = previousMetadata[item.pub];
      if (prevHashes[item.pub]) hashes[item.pub] = prevHashes[item.pub];
      unchanged++;
      continue;
    }
    try {
      const buffer = fs.readFileSync(path.join(stagingMaterials, item.vpk));
      const hash = sha1(buffer);
      const sourceUnchanged = !force && item.outExists
        && prevHashes[item.pub] === hash && previousMetadata[item.pub];
      const thumbnailMissing = layerPreviewRefs.has(item.pub) && !fs.existsSync(thumbnailPath);
      if (sourceUnchanged && !thumbnailMissing) {
        metadata[item.pub] = previousMetadata[item.pub];
        hashes[item.pub] = hash;
        unchanged++;
        continue;
      }
      const decoded = decodeVTF(buffer);
      const header = parseVTFHeader(buffer);
      metadata[item.pub] = sourceUnchanged ? previousMetadata[item.pub] : {
        width: header.width, height: header.height, mipCount: header.mipCount,
        clampS: !!(header.flags & 0x4), clampT: !!(header.flags & 0x8),
        pointSample: !!(header.flags & 0x1), trilinear: !!(header.flags & 0x2),
        anisotropic: !!(header.flags & 0x10), noMip: !!(header.flags & 0x100), noLod: !!(header.flags & 0x200),
      };
      hashes[item.pub] = hash;
      const image = sharp(decoded.rgba, { raw: { width: decoded.width, height: decoded.height, channels: 4 } });
      if (!sourceUnchanged) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        await image.clone().webp({ lossless: true, effort: 4, exact: true }).toFile(outputPath);
      }
      if (layerPreviewRefs.has(item.pub)) {
        fs.mkdirSync(path.dirname(thumbnailPath), { recursive: true });
        await sharp(rgbChannels(decoded.rgba), {
          raw: { width: decoded.width, height: decoded.height, channels: 3 },
        })
          .resize(32, 32, { fit: 'fill' })
          .webp({ lossless: true, effort: 4 })
          .toFile(thumbnailPath);
      }
      if (sourceUnchanged) unchanged++;
      else if (item.outExists) reencoded++;
      else brandNew++;
      if (!sourceUnchanged && (reencoded + brandNew) % 200 === 0) {
        log(`  ... ${reencoded + brandNew} (re)encoded`);
      }
    } catch (error) {
      failed++;
      failures.push({ pub: item.pub, err: error.message });
    }
  }
  log(`[textures] ${unchanged} unchanged, ${reencoded} re-encoded, ${brandNew} new, ${failed} failed`);
  if (failures.length) {
    fs.writeFileSync(path.join(stagingPath, 'texture_failures.json'), JSON.stringify(failures, null, 1));
    log('[textures] failure details -> staging/texture_failures.json');
  }
  fs.writeFileSync(metadataPath, JSON.stringify(metadata));

  const cubemapVpk = 'materials/editor/cubemap.vtf';
  const faces = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  const outputDirectory = path.join(publicDataPath, 'env', 'editor-cubemap');
  const cubemapExists = faces.every((name) => fs.existsSync(path.join(outputDirectory, `${name}.png`)));
  if (force || vpkChanged || !cubemapExists) {
    try {
      extractBatch(TEXTURES_VPK, [cubemapVpk], stagingMaterials);
      const decodedFaces = decodeVTFCubemap(fs.readFileSync(path.join(stagingMaterials, cubemapVpk)));
      fs.mkdirSync(outputDirectory, { recursive: true });
      decodedFaces.forEach((face, index) => {
        fs.writeFileSync(path.join(outputDirectory, `${faces[index]}.png`), encodePNG(face.rgba, face.width, face.height));
      });
      log('[textures] decoded TF2 editor cubemap (6 faces)');
    } catch (error) {
      log(`[textures] failed to decode TF2 editor cubemap: ${error.message}`);
    }
  }
  return { metadata, hashes };
}
