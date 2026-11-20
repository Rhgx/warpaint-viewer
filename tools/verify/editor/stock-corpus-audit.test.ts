// Single-pass audit across every shipped stock paint and supported weapon:
// verifies both base-layer transform discovery and sticker editability without
// resolving the RED wear-0 corpus twice.

import assert from 'node:assert/strict';
import { test } from 'vitest';

import { stickerPlacementFromQuad } from '../../../src/editor/sticker/stickerGeometry';
import { discoverStickerPlacementTargets } from '../../../src/editor/sticker/stickerTargets';
import { discoverBaseTextureTransformTarget } from '../../../src/editor/transform/transformTargets';
import { extractKitMessages, getKitWeaponSlots, resolveKitRecipeWithProvenance } from '../../../src/protodefs/kitQueries';
import { shippedProtoDefs } from '../fixtures';

test('every shipped paint exposes its base transform layer and editable sticker placements', () => {
  const { full, manifest } = shippedProtoDefs();
  const missingBases: string[] = [];
  const stickerFailures: string[] = [];
  let auditedRecipes = 0;

  for (const paint of manifest.paintkits) {
    const messages = extractKitMessages(full, paint.id);
    if (!messages) continue;
    const weaponKeys = new Set(getKitWeaponSlots(full, paint.id).map((slot) => slot.weaponKey));
    const teams: readonly ('red' | 'blu')[] = paint.hasTeamTextures ? ['red', 'blu'] : ['red'];

    for (const weaponKey of weaponKeys) {
      for (const team of teams) {
        auditedRecipes += 1;
        const resolved = resolveKitRecipeWithProvenance(full, paint.id, weaponKey, team, 0);
        if (!discoverBaseTextureTransformTarget(messages, resolved?.provenance)) {
          missingBases.push(`${paint.id}:${paint.name}/${weaponKey}/${team}`);
        }
        // Sticker destination geometry is weapon-authored and does not vary by team or wear.
        if (team === 'red' && resolved) {
          discoverStickerPlacementTargets(messages, resolved).forEach((target, index) => {
            const placement = target.quad ? stickerPlacementFromQuad(target.quad) : undefined;
            if (!target.editable || !placement?.editable) {
              stickerFailures.push(
                `${paint.name} (${paint.id}) / ${weaponKey} / sticker ${index + 1}: ${target.reason ?? placement?.reason}`,
              );
            }
          });
        }
      }
    }
  }

  assert.ok(auditedRecipes >= 9_000, `expected full shipped corpus audit, checked ${auditedRecipes}`);
  assert.deepEqual(missingBases, []);
  assert.deepEqual(stickerFailures, []);
}, 120_000);
