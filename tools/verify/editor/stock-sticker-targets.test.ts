import assert from 'node:assert/strict';
import { test } from 'vitest';
import { discoverStickerPlacementTargets } from '../../../src/editor/sticker/stickerTargets';
import { stickerPlacementFromQuad } from '../../../src/editor/sticker/stickerGeometry';
import { extractKitMessages, resolveKitRecipeWithProvenance } from '../../../src/protodefs/decoder';
import { shippedProtoDefs } from '../fixtures';

test('every shipped stock sticker placement is editable on every supported weapon', () => {
  const { full, manifest } = shippedProtoDefs();
  const failures: string[] = [];

  for (const kit of manifest.paintkits) {
    const info = full.kitsByDefindex.get(kit.id);
    const messages = extractKitMessages(full, kit.id);
    if (!info || !messages) continue;
    for (const weaponKey of new Set(info.slots.map((slot) => slot.weaponKey))) {
      // Destination geometry is weapon-authored and does not vary by team or
      // wear, so one resolved branch covers every placement for this weapon.
      const resolved = resolveKitRecipeWithProvenance(full, kit.id, weaponKey, 'red', 0);
      if (!resolved) continue;
      discoverStickerPlacementTargets(messages, resolved).forEach((target, index) => {
        const placement = target.quad ? stickerPlacementFromQuad(target.quad) : undefined;
        if (!target.editable || !placement?.editable) failures.push(
          `${kit.name} (${kit.id}) / ${weaponKey} / sticker ${index + 1}: ${target.reason ?? placement?.reason}`,
        );
      });
    }
  }

  assert.deepEqual(failures, []);
}, 120_000);
