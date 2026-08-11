// Contract checks for conservative group-select target discovery.
//
//   node tools/verify/editor/group-targets.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BlobReader, TextWriter, ZipReader } from '@zip.js/zip.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILD_DIR = path.join(ROOT, 'staging', 'group-targets-verify');

function bundleModule() {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
  const entry = path.join(ROOT, 'staging', 'group-targets-verify-entry.ts');
  fs.writeFileSync(entry,
    "export { discoverGroupSelectTargets, chooseBestSelectTargetForBucket } from '../src/editor/groupTargets';\n"
    + "export { toggleSelectGroupId } from '../src/editor/mutations';\n"
    + "export { decodeProtoDefs, decodeProtoDefsFromJson, extractKitMessages, resolveKitRecipeWithProvenance } from '../src/protodefs/decoder';\n",
  );
  const viteEntry = fileURLToPath(import.meta.resolve('vite'));
  const distIndex = viteEntry.lastIndexOf(`${path.sep}dist${path.sep}`);
  const viteBin = path.join(viteEntry.slice(0, distIndex), 'bin', 'vite.js');
  if (distIndex < 0 || !fs.existsSync(viteBin)) throw new Error(`could not locate vite's bin from ${viteEntry}`);
  const result = spawnSync(process.execPath, [viteBin, 'build', '--ssr', entry, '--outDir', BUILD_DIR, '--logLevel', 'warn'], {
    cwd: ROOT, stdio: 'inherit', shell: false,
  });
  if (result.status !== 0) throw new Error('vite SSR build of group targets failed');
  return pathToFileURL(path.join(BUILD_DIR, 'group-targets-verify-entry.js')).href;
}

const implementation = await import(bundleModule());
const messages = {
  definition: { header: { defindex: 1 } },
  operation: {
    header: { defindex: 2 },
    operation_node: {
      stage: {
        combine_multiply: {
          operation_node: [
            { stage: { select: { groups: { string: 'models/a_groups' }, select: [{ string: '16' }, { uint32: 0 }] } } },
            { stage: { apply_sticker: { operation_node: { stage: { select: { groups: { string: 'models/a_groups' }, select: { uint32: 32 } } } } } } },
            { stage: { select: { groups: { string: 'models/b_groups' }, select: [{ uint32: 48 }, { variable: 'shared_group' }] } } },
            { stage: { select: { groups: { string: 'models/c_groups' }, select: { uint32: 80 } } } },
            { stage: { select: { groups: { variable: 'groups_map' }, select: { uint32: 64 } } } },
            { operation_template: { defindex: 99 } },
          ],
        },
      },
    },
  },
};

try {
  const found = implementation.discoverGroupSelectTargets(messages);
  assert.equal(found.targets.length, 4);
  assert.deepEqual(found.targets.map((target) => target.target), [
    { groupsValue: 'models/a_groups', occurrence: 0 },
    { groupsValue: 'models/a_groups', occurrence: 1 },
    { groupsValue: 'models/b_groups', occurrence: 0 },
    { groupsValue: 'models/c_groups', occurrence: 0 },
  ]);
  assert.deepEqual(found.targets.map((target) => target.selectedGroupIds), [[16], [32], [48], [80]]);
  assert.deepEqual(found.targets.map((target) => target.canToggle), [true, true, false, true]);
  assert.deepEqual(found.targets[2].blockers, ['variable-select-value']);
  assert.equal(found.hasUnresolvedGroupsReferences, true);
  assert.equal(found.hasUnexpandedOperationTemplates, true);

  // A selector is the mask input that follows the texture it controls. The
  // UI must name that authored texture, including when it sits in a nested
  // combine result, instead of exposing an implementation variable such as
  // texture_layer_1_select_0.
  const labelled = implementation.discoverGroupSelectTargets({
    definition: {
      header: {
        defindex: 3,
        variables: { name: 'nested_layer', value: 'patterns/workshop/example/p_nested_paint.vtf' },
      },
    },
    operation: {
      header: {
        defindex: 4,
        variables: { name: 'surface_layer', value: 'patterns/workshop/example/surface-stripe.webp' },
      },
      operation_node: {
        stage: {
          combine_lerp: {
            operation_node: [
              { stage: { texture_lookup: { texture: { string: 'patterns/blank_white' } } } },
              { stage: { texture_lookup: { texture: { variable: 'surface_layer' } } } },
              { stage: { select: { groups: { string: 'models/example_groups' }, select: { uint32: 16 } } } },
              {
                stage: {
                  combine_multiply: {
                    operation_node: { stage: { texture_lookup: { texture: { variable: 'nested_layer' } } } },
                  },
                },
              },
              { stage: { select: { groups: { string: 'models/example_groups' }, select: { uint32: 32 } } } },
            ],
          },
        },
      },
    },
  });
  assert.deepEqual(labelled.targets.map((target) => [target.textureRef, target.label]), [
    ['patterns/workshop/example/surface-stripe.webp', 'Surface Stripe'],
    ['patterns/workshop/example/p_nested_paint.vtf', 'Nested Paint'],
  ]);

  // Community paints such as Heatcast reserve more selector slots than each
  // weapon overrides. Fixed, non-inherited tail slots do not need a weapon
  // provenance path and must not make the complete layer read-only.
  const mixedInheritance = implementation.discoverGroupSelectTargets({
    definition: {
      header: { defindex: 5, variables: [
        { name: 'layer_select_1', value: '0', inherit: true },
        { name: 'layer_select_2', value: '0', inherit: false },
      ] },
      blackbox: { data: { variable: { variable: 'layer_select_1', string: '0' } } },
    },
    operation: {
      header: { defindex: 6 },
      operation_node: { stage: { combine_lerp: { operation_node: [
        { stage: { texture_lookup: { texture: { string: 'patterns/layer' } } } },
        { stage: { select: {
          groups: { string: 'models/example_groups' },
          select: [{ variable: 'layer_select_1' }, { variable: 'layer_select_2' }],
        } } },
      ] } } },
    },
  }, [{
    fieldPath: ['operation', 'layer_select_1'],
    provenance: {
      variableName: 'layer_select_1',
      effectiveValue: '0',
      sourcePath: ['definition', 'blackbox', 'data', 'variable'],
      editableSourcePath: ['definition', 'blackbox', 'data', 'variable'],
      scope: 'weapon',
      canOverride: true,
    },
  }]);
  assert.equal(mixedInheritance.targets[0]?.canToggle, true);
  assert.deepEqual(mixedInheritance.targets[0]?.target.valueSourcePaths, [
    ['definition', 'blackbox', 'data', 'variable'],
    undefined,
  ]);
  assert.deepEqual(mixedInheritance.targets[0]?.target.inheritedSelectValues, [true, false]);
  const mixedEdited = implementation.toggleSelectGroupId({
    definition: {
      header: { defindex: 5, variables: [
        { name: 'layer_select_1', value: '0', inherit: true },
        { name: 'layer_select_2', value: '0', inherit: false },
      ] },
      blackbox: { data: { variable: { variable: 'layer_select_1', string: '0' } } },
    },
    operation: {
      header: { defindex: 6 },
      operation_node: { stage: { combine_lerp: { operation_node: [
        { stage: { texture_lookup: { texture: { string: 'patterns/layer' } } } },
        { stage: { select: {
          groups: { string: 'models/example_groups' },
          select: [{ variable: 'layer_select_1' }, { variable: 'layer_select_2' }],
        } } },
      ] } } },
    },
  }, {
    ...mixedInheritance.targets[0].target,
    effectiveSelectValues: [0, 0],
  }, 32);
  assert.equal(mixedEdited.definition.blackbox.data.variable.string, '32');
  assert.equal(
    mixedEdited.definition.header.variables[1].value,
    '0',
    'a mixed selector edit must not spill into its shared non-inherited tail slots',
  );

  const heatcastPath = path.join(ROOT, '.tmp', 'example-warpaints', 'Heatcast.zip');
  const basePath = path.join(ROOT, 'public', 'data', 'protodefs-base.bin');
  const heatcastItemDefsPath = path.join(ROOT, 'public', 'data', 'item-defs.json');
  const heatcastManifestPath = path.join(ROOT, 'public', 'data', 'manifest.json');
  if (fs.existsSync(heatcastPath) && fs.existsSync(basePath)
    && fs.existsSync(heatcastItemDefsPath) && fs.existsSync(heatcastManifestPath)) {
    const reader = new ZipReader(new BlobReader(new Blob([fs.readFileSync(heatcastPath)])));
    let fragments;
    try {
      const entries = await reader.getEntries();
      fragments = await Promise.all(entries
        .filter((entry) => !entry.directory && entry.filename.toLowerCase().endsWith('.json'))
        .map(async (entry) => ({ name: entry.filename, text: await entry.getData(new TextWriter()) })));
    } finally {
      await reader.close();
    }
    const heatcastManifest = JSON.parse(fs.readFileSync(heatcastManifestPath, 'utf8'));
    const heatcast = implementation.decodeProtoDefsFromJson(
      new Uint8Array(fs.readFileSync(basePath)),
      fragments,
      {
        weaponsByItemDef: JSON.parse(fs.readFileSync(heatcastItemDefsPath, 'utf8')),
        builtInIds: heatcastManifest.paintkits.map((kit) => kit.id),
      },
    );
    const kit = heatcast.index.kits[0];
    const slot = heatcast.kitsByDefindex.get(kit.defindex)?.slots[0];
    assert.ok(slot, 'Heatcast should expose at least one supported weapon');
    const resolved = implementation.resolveKitRecipeWithProvenance(
      heatcast,
      kit.defindex,
      slot.weaponKey,
      'red',
      0,
    );
    const heatcastMessages = implementation.extractKitMessages(heatcast, kit.defindex);
    assert.ok(resolved && heatcastMessages, 'Heatcast should resolve through its imported JSON fragments');
    const heatcastTargets = implementation.discoverGroupSelectTargets(heatcastMessages, resolved.provenance);
    assert.ok(
      heatcastTargets.targets.some((target) => target.canToggle),
      'Heatcast must retain editable paint layers when only part of each selector inherits per-weapon values',
    );
  }

  assert.deepEqual(implementation.chooseBestSelectTargetForBucket(found, 16)?.target, { groupsValue: 'models/a_groups', occurrence: 0 });
  assert.deepEqual(implementation.chooseBestSelectTargetForBucket(found, 99, { groupsRef: 'models/c_groups' })?.target, { groupsValue: 'models/c_groups', occurrence: 0 });
  assert.equal(implementation.chooseBestSelectTargetForBucket(found, 99), null);
  assert.equal(implementation.chooseBestSelectTargetForBucket(found, 48), null);
  assert.equal(implementation.chooseBestSelectTargetForBucket(found, 0), null);

  const fullPath = path.join(ROOT, 'public', 'data', 'protodefs-full.bin');
  const itemDefsPath = path.join(ROOT, 'public', 'data', 'item-defs.json');
  const manifestPath = path.join(ROOT, 'public', 'data', 'manifest.json');
  if (fs.existsSync(fullPath) && fs.existsSync(itemDefsPath) && fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const decoded = implementation.decodeProtoDefs(new Uint8Array(fs.readFileSync(fullPath)), {
      weaponsByItemDef: JSON.parse(fs.readFileSync(itemDefsPath, 'utf8')),
      builtInIds: manifest.paintkits.map((kit) => kit.id),
    });
    const armyGuns = implementation.extractKitMessages(decoded, 435);
    assert.ok(armyGuns, 'Army Guns should be present in the shipped proto_defs');
    const armyLabels = implementation.discoverGroupSelectTargets(armyGuns).targets;
    assert.ok(armyLabels.length > 0, 'Army Guns should expose select targets');
    assert.ok(
      armyLabels.every((target) => target.textureRef && !/^Texture Layer\b/i.test(target.label)),
      'Army Guns selectors should identify their paired authored texture, not a texture-layer variable',
    );
    let directTargets = 0;
    let kitsWithOneEditableTarget = 0;
    for (const kit of decoded.index.kits) {
      const kitMessages = implementation.extractKitMessages(decoded, kit.defindex);
      if (!kitMessages) continue;
      const slot = decoded.kitsByDefindex.get(kit.defindex)?.slots[0];
      const resolved = slot
        ? implementation.resolveKitRecipeWithProvenance(decoded, kit.defindex, slot.weaponKey, 'red', 0)
        : null;
      const discovery = implementation.discoverGroupSelectTargets(kitMessages, resolved?.provenance);
      const editable = discovery.targets.filter((target) => target.canToggle);
      directTargets += editable.length;
      if (editable.length === 1) kitsWithOneEditableTarget += 1;
    }
    assert.ok(directTargets > 0, 'the shipped proto_defs should expose editable group selectors');
    console.log(`[verify] shipped data: ${directTargets} editable selectors; ${kitsWithOneEditableTarget} kits have exactly one`);
  }
  console.log('[verify] group targets passed');
} finally {
  fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}
