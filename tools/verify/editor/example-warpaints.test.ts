// Edit compatibility check for every local example war paint (skipped when
// .tmp/example-warpaints holds no archives).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { discoverGroupSelectTargets } from '../../../src/editor/layers/groupTargets';
import { discoverStickerPlacementTargets } from '../../../src/editor/sticker/stickerTargets';
import { decodeProtoDefsFromJson, extractKitMessages, resolveKitRecipeWithProvenance } from '../../../src/protodefs/decoder';
import { fixtureFragments, ROOT, shippedProtoDefs } from '../fixtures';

const EXAMPLES = path.join(ROOT, '.tmp', 'example-warpaints');

test('every example recipe resolves and target discovery never throws', async (context) => {
  const archives = fs.existsSync(EXAMPLES)
    ? fs.readdirSync(EXAMPLES).filter((name) => name.toLowerCase().endsWith('.zip')).sort()
    : [];
  if (archives.length === 0) {
    context.skip('No local example war paints');
    return;
  }
  const { baseBytes, options } = shippedProtoDefs();
  const failures: string[] = [];
  for (const archive of archives) {
    const decoded = decodeProtoDefsFromJson(baseBytes, await fixtureFragments(path.join(EXAMPLES, archive)), options);
    for (const kit of decoded.index.kits) {
      const messages = extractKitMessages(decoded, kit.defindex);
      assert.ok(messages, `${archive}: paint ${kit.defindex} should expose its editable messages`);
      for (const weaponKey of kit.weapons) {
        for (const team of ['red', 'blu'] as const) {
          for (let wearIndex = 0; wearIndex < 5; wearIndex += 1) {
            const label = `${archive} / ${weaponKey} / ${team} / wear ${wearIndex}`;
            const resolved = resolveKitRecipeWithProvenance(decoded, kit.defindex, weaponKey, team, wearIndex);
            if (!resolved) {
              failures.push(`${label}: recipe did not resolve`);
              continue;
            }
            const groups = discoverGroupSelectTargets(messages, resolved.provenance);
            discoverStickerPlacementTargets(messages, resolved);
            if (archive.toLowerCase() === 'flakfurnished.zip' && weaponKey === 'c_amputator' && team === 'red' && wearIndex === 0) {
              const layers = new Set(groups.targets.filter((target) => target.canToggle).map((target) => target.sourceKey));
              if (layers.size !== 4) failures.push(`${label}: expected 4 editable paint layers, found ${layers.size}`);
            }
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
}, 60_000);
