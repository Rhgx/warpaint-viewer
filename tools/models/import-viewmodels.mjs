// Import the stock, paintable subset of tf-viewmodel-editor's extracted assets.
// Usage: node tools/models/import-viewmodels.mjs [path/to/tf-viewmodel-editor]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.resolve(process.argv[2] ?? path.join(root, '../tf-viewmodel-editor'), 'public/data');
const output = path.join(root, 'public/data/viewmodels');
const catalog = JSON.parse(await fs.readFile(path.join(root, 'public/data/manifest.json'), 'utf8'));
const extracted = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
const files = new Set();
function asset(entry, paintedMaterials = []) {
  files.add(entry.model);
  for (const materials of [entry.materials, entry.blu]) {
    for (const [name, material] of Object.entries(materials ?? {})) {
      if (paintedMaterials.includes(name) || /(?:^|_)lens(?:$|_)/i.test(name)) continue;
      for (const key of ['baseTexture', 'normalMap', 'phongExponentTexture', 'lightwarpTexture', 'detailTexture']) {
        if (key === 'detailTexture' && material.animatedWeaponSheen) continue;
        if (material[key]) files.add(material[key]);
      }
    }
  }
  return { model: entry.model, materials: entry.materials, blu: entry.blu };
}
const weapons = [];
const arms = {};
for (const weapon of catalog.weapons.filter(entry => entry.key !== 'paintkit_tool')) {
  const staticGlb = await fs.readFile(path.join(root, 'public/data', weapon.model));
  const staticDocument = JSON.parse(staticGlb.toString('utf8', 20, 20 + staticGlb.readUInt32LE(12)));
  const paintMaterials = staticDocument.materials.map(material => material.name)
    .filter(name => !/(?:^|_)lens(?:$|_)/i.test(name));
  const matches = extracted.weapons.filter(entry => path.basename(entry.model) === path.basename(weapon.model)
    && entry.variantName === 'Stock' && !entry.hideModel);
  const classes = new Set();
  for (const entry of matches) {
    if (classes.has(entry.class)) continue;
    classes.add(entry.class);
    const armsKey = entry.armsKey ?? entry.class;
    arms[armsKey] ??= asset(extracted.arms[armsKey]);
    weapons.push({ ...asset(entry, paintMaterials), paintMaterials, weaponKey: weapon.key, class: entry.class, armsKey,
      activity: entry.activity, clips: entry.clips, stockOffset: entry.stockOffset,
      ...(weapon.key === 'c_holymackerel' ? { jiggleBones: entry.animationMetadata.jiggleBones } : {}),
      flipViewmodel: entry.flipViewmodel, attachments: entry.attachments.map(entry => asset(entry)) });
  }
  if (!classes.size) throw new Error(`No stock viewmodel for ${weapon.key}`);
}
for (const file of files) {
  const target = path.join(output, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(source, file), target);
}
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify({ arms, weapons }));
console.log(`Imported ${weapons.length} weapon/class combinations and ${files.size} assets.`);
