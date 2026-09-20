import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decodeProtoDefs, resolveKitRecipe } from '../../src/protodefs/decoder';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBundle } from '../lib/recipe-pack.mjs';
import { loadRoot, parseContainer as parseContainerNode, decodeType, DEF_TYPE } from '../lib/proto.mjs';
import { buildIndex, resolveRecipe as resolveRecipeNode, WEAPON_SLOTS } from '../lib/resolve.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DATA = path.join(ROOT, 'public', 'data');
const MISMATCHES_TO_PRINT = 3;

// tools/extract/warpaints.mjs adds implicit `<base>_s` sticker specs after resolving,
// using the game's vpk listing. The decoder deliberately leaves that to its
// caller (a worker cannot see the mounted package), so apply the same rule here
// against the textures the pipeline actually shipped.
function addImplicitStickerSpecs(node, textureKeys) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'apply_sticker') {
    for (const sticker of node.stickers ?? []) {
      if (!sticker.base || sticker.spec) continue;
      const implicit = sticker.base.replace(/\.webp$/i, '_s.webp');
      if (textureKeys.has(implicit)) sticker.spec = implicit;
    }
  }
  for (const child of node.nodes ?? []) addImplicitStickerSpecs(child, textureKeys);
}

function parseVariantKey(key) {
  const wear = key.match(/_w(\d+)$/);
  const head = wear ? key.slice(0, -wear[0].length) : key;
  const team = head.endsWith('_blu') ? 'blu' : 'red';
  return { weaponKey: head.slice(0, -(team.length + 1)), team, wearIndex: wear ? Number(wear[1]) : 0 };
}

function firstDifference(a, b, trail = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${trail || '(root)'}: shipped=${JSON.stringify(a)} ported=${JSON.stringify(b)}`;
  }
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const diff = firstDifference(a[key], b[key], trail ? `${trail}.${key}` : key);
    if (diff) return diff;
  }
  return `${trail || '(root)'}: differing object shape`;
}

test('decoder agrees with independent pipeline', (context) => {
  const vpdPath = process.env.TF2_PROTODEFS ?? path.join(PUBLIC_DATA, 'protodefs-full.bin');
  if (!fs.existsSync(vpdPath)) {
    assert.ok(!process.env.TF2_PROTODEFS, `Missing proto_defs: ${vpdPath}`);
    context.skip('No proto_defs fixture');
    return;
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'manifest.json'), 'utf8'));
  const weaponsByItemDef = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'item-defs.json'), 'utf8'));
  const textureKeys = new Set(Object.keys(manifest.textures ?? {}));

  console.log(`[verify] decoding ${vpdPath} ...`);
  const t0 = performance.now();
  const decoded = decodeProtoDefs(new Uint8Array(fs.readFileSync(vpdPath)), { weaponsByItemDef, builtInIds: [] });
  console.log(`[verify] decoded ${decoded.index.kits.length} paintkit definitions in ${Math.round(performance.now() - t0)}ms`);

  // The same container resolved through the original Node pipeline. A shipped
  // bundle can legitimately be older than the installed game, so a difference is
  // only a porting bug when the pipeline agrees with the bundle and not with the
  // port. Asking the pipeline directly is the only way to tell the two apart.
  const nodeRoot = loadRoot();
  const nodeContainer = parseContainerNode(vpdPath);
  const nodeDefs = decodeType(nodeRoot, nodeContainer.byType, DEF_TYPE.PAINTKIT_DEFINITION);
  const nodeCtx = buildIndex(
    decodeType(nodeRoot, nodeContainer.byType, DEF_TYPE.PAINTKIT_OPERATION),
    decodeType(nodeRoot, nodeContainer.byType, DEF_TYPE.PAINTKIT_ITEM_DEFINITION),
    decodeType(nodeRoot, nodeContainer.byType, DEF_TYPE.PAINTKIT_VARIABLES),
  );
  const nodeDefById = new Map(nodeDefs.map((def) => [def.header.defindex, def]));

  function resolveWithPipeline(kitId, weaponKey, team, wearIndex) {
    const def = nodeDefById.get(kitId);
    if (!def) return null;
    for (const name of [...WEAPON_SLOTS, 'item']) {
      for (const slot of [].concat(def[name] ?? [])) {
        if (!slot?.item_definition_template) continue;
        const itemDef = nodeCtx.itemDefByIdx.get(slot.item_definition_template.defindex);
        if (!itemDef || weaponsByItemDef[String(itemDef.item_definition_index)] !== weaponKey) continue;
        const resolved = resolveRecipeNode(def, slot, itemDef, wearIndex, team, nodeCtx);
        if (!resolved) return null;
        addImplicitStickerSpecs(resolved.tree, textureKeys);
        return buildBundle([{ key: 'x', tree: resolved.tree }]).trees[0];
      }
    }
    return null;
  }

  let variants = 0;
  let matched = 0;
  let missing = 0;
  let staleBundles = 0;
  let portingBugs = 0;
  const mismatches = [];
  const signatures = new Map();

  function recordSignature(kitId, detail) {
    // Drop the node path, keeping "<tag> <field>: shipped=... ported=...".
    const signature = detail.replace(/(\] )[\w.]*?([\w]+): /, '$1$2: ');
    const info = signatures.get(signature) ?? { count: 0, kits: new Set() };
    info.count += 1;
    info.kits.add(kitId);
    signatures.set(signature, info);
  }

  for (const file of fs.readdirSync(path.join(PUBLIC_DATA, 'recipes'))) {
    if (!file.endsWith('.json')) continue;
    const kitId = Number(file.slice(0, -5));
    const bundle = JSON.parse(fs.readFileSync(path.join(PUBLIC_DATA, 'recipes', file), 'utf8'));

    for (const [key, treeIndex] of Object.entries(bundle.variants)) {
      variants += 1;
      const { weaponKey, team, wearIndex } = parseVariantKey(key);
      const resolved = resolveKitRecipe(decoded, kitId, weaponKey, team, wearIndex);
      if (!resolved) {
        missing += 1;
        if (mismatches.length < MISMATCHES_TO_PRINT) mismatches.push({ kitId, key, detail: 'the decoder resolved no recipe' });
        continue;
      }
      addImplicitStickerSpecs(resolved.tree, textureKeys);
      // buildBundle applies the same default-field compaction the shipped bundles
      // were written with, so both sides are compared in one canonical form.
      const packed = buildBundle([{ key, tree: resolved.tree }]).trees[0];
      const expected = bundle.trees[treeIndex];
      if (JSON.stringify(packed) === JSON.stringify(expected)) {
        matched += 1;
      } else {
        const pipeline = resolveWithPipeline(kitId, weaponKey, team, wearIndex);
        const agreesWithPort = JSON.stringify(pipeline) === JSON.stringify(packed);
        if (agreesWithPort) staleBundles += 1; else portingBugs += 1;
        const detail = `${agreesWithPort ? '[stale bundle]' : '[PORTING BUG]'} ${firstDifference(expected, packed)}`;
        recordSignature(kitId, detail);
        if (mismatches.length < MISMATCHES_TO_PRINT) mismatches.push({ kitId, key, detail });
      }
    }
  }

  console.log(`\n[verify] variants: ${variants}, matched: ${matched}, unresolved: ${missing}`);
  console.log(`[verify] differing from the shipped bundle: ${staleBundles} where the Node pipeline agrees with the port (the bundle is older than this game install), ${portingBugs} genuine porting differences`);
  for (const entry of mismatches) console.log(`  kit ${entry.kitId} ${entry.key}: ${entry.detail}`);
  // A porting bug usually shows up as one signature repeated across many kits, so
  // group by the differing field rather than listing every affected variant.
  if (signatures.size) {
    console.log('\n[verify] mismatch signatures (field: shipped vs ported):');
    for (const [signature, info] of [...signatures].sort((a, b) => b[1].count - a[1].count).slice(0, 12)) {
      console.log(`  ${info.count.toString().padStart(5)}x  ${signature}`);
      console.log(`         kits: ${[...info.kits].slice(0, 8).join(', ')}${info.kits.size > 8 ? ', ...' : ''}`);
    }
  }
  // Stale bundles are a data-freshness observation, not a port failure, so only a
  // disagreement with the Node pipeline fails this check.
  const ok = portingBugs === 0 && missing === 0;
  console.log(ok
    ? `\n[verify] PASS: the port matches the Node pipeline on all ${variants} variants.`
    : '\n[verify] FAIL: the port disagrees with the Node pipeline.');
  assert.ok(ok, 'The browser decoder disagrees with the independent pipeline');

}, 120000);
