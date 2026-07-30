import fs from 'node:fs';
import path from 'node:path';

export function verifyExtraction({ publicDataPath, manifestPaintkits, allTextureRefs, skipped, log = console.log }) {
  log('\n===== VERIFICATION =====');
  let missingTextures = 0;
  for (const ref of allTextureRefs) {
    if (!fs.existsSync(path.join(publicDataPath, ref))) missingTextures++;
  }
  log(`textures referenced: ${allTextureRefs.size}, missing PNG on disk: ${missingTextures}`);

  const recipesRoot = path.join(publicDataPath, 'recipes');
  let recipeBundles = 0;
  let variantCount = 0;
  let brokenRefs = 0;
  if (fs.existsSync(recipesRoot)) {
    for (const filename of fs.readdirSync(recipesRoot)) {
      if (!filename.endsWith('.json')) continue;
      recipeBundles++;
      const bundle = JSON.parse(fs.readFileSync(path.join(recipesRoot, filename), 'utf8'));
      variantCount += Object.keys(bundle.variants || {}).length;
      for (const tree of bundle.trees || []) {
        const refs = [];
        collectRefs(tree, refs);
        for (const ref of refs) {
          if (!fs.existsSync(path.join(publicDataPath, ref))) brokenRefs++;
        }
      }
    }
  }
  log(`recipe bundles on disk: ${recipeBundles}, variants: ${variantCount}, broken texture refs: ${brokenRefs}`);

  const picks = [
    manifestPaintkits.find((paintkit) => paintkit.weapons.length === 1),
    manifestPaintkits.find((paintkit) => paintkit.hasTeamTextures && paintkit.weapons.length > 10),
    manifestPaintkits.find((paintkit) => paintkit.name && /sticker|decal|autumn/i.test(paintkit.name))
      || manifestPaintkits[0],
  ].filter(Boolean);
  for (const paintkit of picks) {
    log(`  spot-check kit ${paintkit.id} "${paintkit.name}" weapons=${paintkit.weapons.length} team=${paintkit.hasTeamTextures} perWear=${paintkit.perWear}`);
  }

  log(`skipped weapon/kit resolutions: ${skipped.length}`);
  if (skipped.length) {
    const summary = {};
    for (const item of skipped) summary[item.reason] = (summary[item.reason] || 0) + 1;
    for (const [reason, count] of Object.entries(summary)) log(`  skip[${reason}] = ${count}`);
  }
  log('========================\n');
}

function collectRefs(node, output) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'texture_lookup' && node.texture) output.push(node.texture);
  if (node.type === 'select' && node.groups) output.push(node.groups);
  if (node.type === 'apply_sticker' && node.stickers) {
    for (const sticker of node.stickers) {
      if (sticker.base) output.push(sticker.base);
      if (sticker.spec) output.push(sticker.spec);
    }
  }
  if (node.nodes) {
    for (const child of node.nodes) collectRefs(child, output);
  }
}
