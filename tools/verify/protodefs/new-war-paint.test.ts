import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { loadOperationTemplates } from '../../../src/data/loader';
import type { Manifest } from '../../../src/data/types';
import { discoverGroupSelectTargets } from '../../../src/editor/layers/groupTargets';
import { discoverStickerPlacementTargets } from '../../../src/editor/sticker/stickerTargets';
import {
  decodeProtoDefsFromJson,
  extractKitMessages,
  resolveKitRecipe,
  resolveKitRecipeWithProvenance,
} from '../../../src/protodefs/decoder';
import { partitionResolvableKits } from '../../../src/protodefs/validation';
import { buildTemplateWarPaint, nextWarPaintIds } from '../../../src/protodefs/templatePaint';
import { PUBLIC_DATA } from '../fixtures';

async function loadFixtures() {
  const baseBytes = new Uint8Array(fs.readFileSync(path.join(PUBLIC_DATA, 'protodefs-base.bin')));
  const weaponsByItemDef: Record<string, string> = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
  const manifest: Manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
  // Served through the loader so the templates are expanded exactly as the app expands them.
  const templateFile = fs.readFileSync(path.join(PUBLIC_DATA, 'operation-templates.json'), 'utf8');
  vi.stubGlobal('fetch', async () => new Response(templateFile));
  const templates = await loadOperationTemplates();
  const builtInIds = manifest.paintkits.map((kit) => kit.id);
  const operationIds = Object.keys(templates.usage).map(Number);
  const isShipped = (ref: string): boolean => Boolean(manifest.textures?.[ref]);
  return { baseBytes, weaponsByItemDef, builtInIds, operationIds, templates, isShipped };
}

test('new war paints built on every stock template resolve as new and only name shipped textures', async () => {
  const { baseBytes, weaponsByItemDef, builtInIds, operationIds, templates, isShipped } = await loadFixtures();
  assert.ok(templates.templates.length > 0, 'every stock template should be exercised');
  const failures: string[] = [];

  for (const template of templates.templates) {
    const templateName = template.name;
    const ids = nextWarPaintIds({ paintDefindexes: builtInIds, operationDefindexes: operationIds });
    assert.ok(ids.defindex > Math.max(...builtInIds), 'new paint defindex must clear every built-in paint');
    assert.ok(ids.operationDefindex > Math.max(...operationIds), 'new operation must clear every stock operation');

    const fragments = buildTemplateWarPaint({
      template,
      defindex: ids.defindex,
      operationDefindex: ids.operationDefindex,
      name: 'New war paint',
      isShipped,
    });
    const decoded = decodeProtoDefsFromJson(baseBytes, fragments, { weaponsByItemDef, builtInIds });
    const kit = decoded.index.kits.find((entry) => entry.defindex === ids.defindex);
    assert.ok(kit, `${templateName}: the new paint is not in the decoded index`);
    assert.equal(kit.isNew, true, `${templateName}: the new paint should be treated as new`);

    const { loadable } = await partitionResolvableKits({
      resolveRecipe: async (defindex, weaponKey, team, wearIndex) => resolveKitRecipe(decoded, defindex, weaponKey, team, wearIndex),
    }, [kit]);
    assert.equal(loadable.length, 1, `${templateName}: the new paint did not resolve for its first weapon`);
    assert.ok(kit.weapons.length > 0, `${templateName}: the new paint names no supported weapon`);

    for (const weaponKey of kit.weapons) {
      for (const team of ['red', 'blu'] as const) {
        for (let wearIndex = 0; wearIndex < 5; wearIndex += 1) {
          const recipe = resolveKitRecipe(decoded, kit.defindex, weaponKey, team, wearIndex);
          if (!recipe) {
            failures.push(`${templateName} / ${weaponKey} / ${team} / wear ${wearIndex}: recipe did not resolve`);
            continue;
          }
          for (const ref of recipe.textureRefs) {
            if (!isShipped(ref)) failures.push(`${templateName} / ${weaponKey} / ${team} / wear ${wearIndex}: ${ref} is not shipped`);
          }
        }
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('a new war paint on a sticker template exposes its stages as editor targets', async () => {
  const { baseBytes, weaponsByItemDef, builtInIds, operationIds, templates, isShipped } = await loadFixtures();
  const template = templates.templates.find((entry) => entry.name === 'one_sticker_three_texture_inner_wear');
  assert.ok(template, 'one_sticker_three_texture_inner_wear is missing from operation-templates.json');
  const ids = nextWarPaintIds({ paintDefindexes: builtInIds, operationDefindexes: operationIds });
  const fragments = buildTemplateWarPaint({
    template,
    defindex: ids.defindex,
    operationDefindex: ids.operationDefindex,
    name: 'New war paint',
    isShipped,
  });
  const decoded = decodeProtoDefsFromJson(baseBytes, fragments, { weaponsByItemDef, builtInIds });
  const kit = decoded.index.kits.find((entry) => entry.defindex === ids.defindex);
  assert.ok(kit, 'the new paint is not in the decoded index');
  const messages = extractKitMessages(decoded, ids.defindex);
  assert.ok(messages, 'the new paint exposes its operation to the editor');
  const resolved = resolveKitRecipeWithProvenance(decoded, ids.defindex, kit.weapons[0], 'red', 0);
  assert.ok(resolved, 'the new paint does not resolve for its first weapon');

  const stickers = discoverStickerPlacementTargets(messages, resolved);
  assert.ok(stickers.length >= 1, `expected at least 1 sticker target, found ${stickers.length}`);
  const layers = discoverGroupSelectTargets(messages, resolved.provenance).targets;
  assert.ok(layers.length >= 1, `expected at least 1 texture layer target, found ${layers.length}`);
});
