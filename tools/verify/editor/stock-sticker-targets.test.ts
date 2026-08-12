import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { discoverStickerPlacementTargets } from '../../../src/editor/stickerTargets';
import { stickerPlacementFromQuad } from '../../../src/editor/stickerGeometry';
import {
  decodeProtoDefs,
  extractKitMessages,
  resolveKitRecipeWithProvenance,
} from '../../../src/protodefs/decoder';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('every shipped stock sticker placement is editable on every supported weapon', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'manifest.json'), 'utf8'));
  const itemDefs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'item-defs.json'), 'utf8'));
  const paintkits = manifest.paintkits as Array<{ id: number; name: string }>;
  const decoded = decodeProtoDefs(
    new Uint8Array(fs.readFileSync(path.join(ROOT, 'public', 'data', 'protodefs-full.bin'))),
    { weaponsByItemDef: itemDefs, builtInIds: paintkits.map((kit) => kit.id) },
  );
  const failures: string[] = [];
  let targetCount = 0;

  for (const kit of paintkits) {
    const info = decoded.kitsByDefindex.get(kit.id);
    const messages = extractKitMessages(decoded, kit.id);
    if (!info || !messages) continue;
    const weaponKeys = [...new Set(info.slots.map((slot) => slot.weaponKey))]
      .filter((weaponKey): weaponKey is string => typeof weaponKey === 'string');
    for (const weaponKey of weaponKeys) {
      // Destination geometry is weapon-authored and does not vary by team or
      // wear, so one resolved branch covers every placement for this weapon.
      const resolved = resolveKitRecipeWithProvenance(decoded, kit.id, weaponKey, 'red', 0);
      if (!resolved) continue;
      const targets = discoverStickerPlacementTargets(messages, resolved);
      targetCount += targets.length;
      targets.forEach((target, index) => {
        const placement = target.quad ? stickerPlacementFromQuad(target.quad) : undefined;
        if (!target.editable || !placement?.editable) failures.push(
          `${kit.name} (${kit.id}) / ${weaponKey} / sticker ${index + 1}: ${target.reason ?? placement?.reason}`,
        );
      });
    }
  }

  assert.deepEqual(failures, [], `Stock sticker compatibility failures:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
  console.log(`[verify] ${targetCount} stock sticker placements are editable across all supported weapons`);
}, 120_000);
